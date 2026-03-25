/**
 * naverLoungeDailyPipeline.js
 * 네이버 라운지 일일 수집 → AI 분석 → Firestore 저장 → 이메일 발송
 *
 * exports:
 *   runNaverLoungePipeline(filterWorkspaceId?, targetDate?, options?)
 *   runNaverLoungeEmailSender(filterWorkspaceId?, targetDate?)
 */

const admin = require("firebase-admin");
const {
  loadSessionFromFirestore,
  markSessionInvalid,
  collectLoungePosts,
  collectPostComments,
  isAuthError,
} = require("./collectors/naverLoungeCollector");
const { analyzeFacebookGroupPosts } = require("./analyzers/openrouterAnalyzer");
const { sendNaverLoungeEmailReport, logDelivery, logDeliveryFailure } = require("./reportDelivery");
const { getKSTYesterdayString, sleep } = require("./utils/dateUtils");

const POST_GAP_MS = 400;     // 게시글별 댓글 수집 간격 ms
const LOUNGE_GAP_MS = 5000;  // 라운지 간 대기 ms
const DEFAULT_WORKSPACE = "ws_antigravity";

// ── 메인 파이프라인 ──────────────────────────────────────────────
/**
 * @param {string|null}  filterWorkspaceId  - 특정 워크스페이스만 실행 (null → 기본값)
 * @param {string|null}  targetDate         - 'YYYY-MM-DD', null → KST 어제
 * @param {object}       options
 * @param {boolean}      options.skipEmail  - true 시 이메일 발송 건너뜀
 */
async function runNaverLoungePipeline(
  filterWorkspaceId = null,
  targetDate = null,
  options = {}
) {
  const { skipEmail = false, triggerSource = "schedule" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(
    `[naverLoungePipeline] 시작 — workspaceId: ${workspaceId}, date: ${date}`
  );

  const results = { processed: 0, skipped: 0, errors: 0 };

  // ── 세션 로드 ───────────────────────────────────────────────────
  let session;
  try {
    session = await loadSessionFromFirestore(db, workspaceId);
  } catch (err) {
    console.error("[naverLoungePipeline] 세션 로드 실패:", err.message);
    return results;
  }

  if (!session || !session.cookieHeader || !session.deviceId || !session.userAgent) {
    console.warn("[naverLoungePipeline] 저장된 요청 세션 없음 — 파이프라인 중단");
    return results;
  }

  // ── 라운지 목록 조회 ─────────────────────────────────────────
  const loungeSnap = await db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("naver_lounges")
    .where("isActive", "==", true)
    .get();

  if (loungeSnap.empty) {
    console.log("[naverLoungePipeline] 활성 라운지 없음 — 종료");
    return results;
  }

  async function markAllLoungesSessionExpired() {
    console.warn("[naverLoungePipeline] 세션 만료 감지 — isValid=false 마킹");
    await markSessionInvalid(db, workspaceId);

    for (const lDoc of loungeSnap.docs) {
      await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("naver_reports")
        .doc(date)
        .collection("lounges")
        .doc(lDoc.id)
        .set(
          {
            loungeId: lDoc.data().loungeId || lDoc.id,
            loungeName: lDoc.data().loungeName || "",
            date,
            crawlStatus: "session_expired",
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      results.errors++;
    }
  }

  // ── 라운지 순회 ──────────────────────────────────────────────
  for (const lDoc of loungeSnap.docs) {
    const loungeData = lDoc.data();
    const loungeId   = loungeData.loungeId   || lDoc.id;
    const loungeName = loungeData.loungeName || "";
    const loungeUrl  = loungeData.loungeUrl  || "";

    if (!loungeUrl) {
      console.warn(`[naverLoungePipeline] loungeUrl 없음 — skip (${lDoc.id})`);
      results.skipped++;
      continue;
    }

    console.log(`[naverLoungePipeline] 라운지 처리: ${loungeName} (${loungeId})`);

    try {
      const { posts, skipped } = await collectLoungePosts({
        session,
        loungeId,
        loungeUrl,
        targetDate: date,
        boardId: loungeData.boardId || 0,
      });

      if (skipped || posts.length === 0) {
        console.log(`[naverLoungePipeline] ${loungeName}: 해당일 게시글 없음 — skip`);
        results.skipped++;
        continue;
      }

      let partialFailure = false;
      for (const post of posts) {
        if (!post.commentCount) continue;

        try {
          const result = await collectPostComments({
            session,
            loungeId,
            feedId: post.feedId,
            postUrl: post.postUrl,
          });
          post.comments = result.comments;
          post.commentCount = result.totalCount;
        } catch (commentErr) {
          if (isAuthError(commentErr)) throw commentErr;
          partialFailure = true;
          console.warn(
            `[naverLoungePipeline] 댓글 수집 실패 (${loungeName}/${post.feedId}): ${commentErr.message}`
          );
        }

        await sleep(POST_GAP_MS);
      }

      const totalComments = posts.reduce((sum, post) => sum + (post.commentCount || 0), 0);

      let aiSummary = "";
      let aiSummary_en = "";
      let aiSentiment = { positive: 0, neutral: 100, negative: 0 };
      let aiKeywords_en = [];
      let aiIssues = [];
      let promptTokens = 0, completionTokens = 0, totalCost = 0;

      try {
        const analysisResult = await analyzeFacebookGroupPosts({
          groupName: loungeName,
          date,
          posts,
          customPrompt: loungeData.analysisPrompt || "",
          model: loungeData.analysisModel || process.env.OPENROUTER_MODEL,
          platform: "naver_lounge",
        });
        aiSummary = analysisResult.summary || "";
        aiSummary_en = analysisResult.summary_en || "";
        aiSentiment = analysisResult.sentiment || aiSentiment;
        aiKeywords_en = analysisResult.keywords_en || [];
        aiIssues  = analysisResult.issues  || [];

        const usage = analysisResult.usage || {};
        promptTokens     = usage.prompt_tokens     || 0;
        completionTokens = usage.completion_tokens || 0;
        totalCost        = Number(usage.cost || 0).toFixed(6);
      } catch (aiErr) {
        console.warn(
          `[naverLoungePipeline] AI 분석 실패 (${loungeName}): ${aiErr.message}`
        );
      }

      const crawlStatus = partialFailure ? "partial" : "ok";
      const reportData = {
        loungeId,
        loungeName,
        loungeUrl,
        date,
        postCount:       posts.length,
        totalComments,
        posts,
        aiSummary,
        aiSummary_en,
        aiSentiment,
        aiKeywords_en,
        aiIssues,
        model:            loungeData.analysisModel || process.env.OPENROUTER_MODEL || "",
        promptTokens,
        completionTokens,
        totalTokens:      promptTokens + completionTokens,
        cost:             totalCost,
        crawlStatus,
        collectedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("naver_reports")
        .doc(date)
        .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("naver_reports")
        .doc(date)
        .collection("lounges")
        .doc(lDoc.id)
        .set(reportData);

      console.log(
        `[naverLoungePipeline] ${loungeName}: 저장 완료 (posts: ${posts.length}, crawlStatus: ${crawlStatus})`
      );

      const emailConfig = loungeData.deliveryConfig?.email;
      if (!skipEmail && emailConfig?.isEnabled && (emailConfig.recipients || []).length > 0) {
        try {
          await sendNaverLoungeEmailReport({
            recipients: emailConfig.recipients,
            loungeName,
            loungeUrl,
            date,
            report: reportData,
          });
          console.log(`[naverLoungePipeline] 이메일 발송 완료: ${loungeName}`);
          logDelivery(db, workspaceId, {
            platform: "naver_lounge",
            target: loungeName,
            targetId: lDoc.id,
            reportType: "daily",
            reportDate: date,
            recipientCount: emailConfig.recipients.length,
            triggerSource,
          });
        } catch (emailErr) {
          console.error(
            `[naverLoungePipeline] 이메일 발송 실패 (${loungeName}): ${emailErr.message}`
          );
          logDeliveryFailure(db, workspaceId, {
            platform: "naver_lounge",
            target: loungeName,
            targetId: lDoc.id,
            reportType: "daily",
            reportDate: date,
            recipientCount: emailConfig.recipients.length,
            triggerSource,
            errorMessage: emailErr.message,
          });
        }
      }

      results.processed++;
    } catch (err) {
      if (isAuthError(err)) {
        await markAllLoungesSessionExpired();
        return results;
      }

      const detail = err.response?.data ? JSON.stringify(err.response.data) : "";
      console.error(
        `[naverLoungePipeline] ${workspaceId}/${lDoc.id} 오류: ${err.message}${
          detail ? " — " + detail : ""
        }`
      );
      results.errors++;
    }

    await sleep(LOUNGE_GAP_MS);
  }

  console.log(
    `[naverLoungePipeline] 완료 — processed: ${results.processed}, skipped: ${results.skipped}, errors: ${results.errors}`
  );
  return results;
}

// ── 이메일 재발송 ────────────────────────────────────────────────
/**
 * 저장된 리포트를 읽어 이메일만 재발송
 */
async function runNaverLoungeEmailSender(
  filterWorkspaceId = null,
  targetDate = null,
  options = {}
) {
  const { triggerSource = "manual" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(
    `[naverLoungeEmailSender] 시작 — workspaceId: ${workspaceId}, date: ${date}`
  );

  const results = { sent: 0, skipped: 0, errors: 0 };

  const loungeSnap = await db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("naver_lounges")
    .where("isActive", "==", true)
    .get();

  for (const lDoc of loungeSnap.docs) {
    const loungeData = lDoc.data();
    const emailConfig = loungeData.deliveryConfig?.email;
    if (!emailConfig?.isEnabled || !(emailConfig.recipients || []).length) {
      results.skipped++;
      continue;
    }

    try {
      const reportSnap = await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("naver_reports")
        .doc(date)
        .collection("lounges")
        .doc(lDoc.id)
        .get();

      if (!reportSnap.exists) {
        console.warn(`[naverLoungeEmailSender] 리포트 없음 — ${lDoc.id}/${date}`);
        results.skipped++;
        continue;
      }

      const report = reportSnap.data();
      await sendNaverLoungeEmailReport({
        recipients: emailConfig.recipients,
        loungeName: loungeData.loungeName || "",
        loungeUrl:  loungeData.loungeUrl  || "",
        date,
        report,
      });

      console.log(`[naverLoungeEmailSender] 발송 완료: ${loungeData.loungeName}`);
      logDelivery(db, workspaceId, {
        platform: "naver_lounge",
        target: loungeData.loungeName || lDoc.id,
        targetId: lDoc.id,
        reportType: "daily",
        reportDate: date,
        recipientCount: emailConfig.recipients.length,
        triggerSource,
      });
      results.sent++;
    } catch (err) {
      console.error(`[naverLoungeEmailSender] 오류 (${lDoc.id}): ${err.message}`);
      logDeliveryFailure(db, workspaceId, {
        platform: "naver_lounge",
        target: loungeData.loungeName || lDoc.id,
        targetId: lDoc.id,
        reportType: "daily",
        reportDate: date,
        recipientCount: emailConfig.recipients.length,
        triggerSource,
        errorMessage: err.message,
      });
      results.errors++;
    }
  }

  console.log(
    `[naverLoungeEmailSender] 완료 — sent: ${results.sent}, errors: ${results.errors}`
  );
  return results;
}

module.exports = {
  runNaverLoungePipeline,
  runNaverLoungeEmailSender,
};
