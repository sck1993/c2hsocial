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
  launchBrowser,
  loadSessionFromFirestore,
  markSessionInvalid,
  applyCookiesToContext,
  verifySessionAlive,
  collectLoungePosts,
  collectPostContent,
  collectPostComments,
} = require("./collectors/naverLoungeCollector");
const { analyzeFacebookGroupPosts } = require("./analyzers/openrouterAnalyzer");
const { sendNaverLoungeEmailReport } = require("./reportDelivery");
const { getKSTYesterdayString } = require("./utils/dateUtils");

const POST_GAP_MS = 2000;    // 포스트 간 대기 ms
const LOUNGE_GAP_MS = 5000;  // 라운지 간 대기 ms
const DEFAULT_WORKSPACE = "ws_antigravity";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  const { skipEmail = false } = options;
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

  if (!session || !session.cookies || session.cookies.length === 0) {
    console.warn("[naverLoungePipeline] 저장된 세션 없음 — 파이프라인 중단");
    return results;
  }

  // ── 브라우저 실행 ────────────────────────────────────────────────
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    console.error("[naverLoungePipeline] 브라우저 실행 실패:", err.message);
    return results;
  }

  try {
    const context = await browser.newContext({
      userAgent: session.userAgent || undefined,
      locale: "ko-KR",
      extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8" },
    });

    await applyCookiesToContext(context, session.cookies);
    const page = await context.newPage();

    // ── 세션 유효성 확인 ──────────────────────────────────────────
    const alive = await verifySessionAlive(page);
    if (!alive) {
      console.warn("[naverLoungePipeline] 세션 만료 감지 — isValid=false 마킹");
      await markSessionInvalid(db, workspaceId);

      // 모든 활성 라운지에 crawlStatus="session_expired" 저장
      const loungeSnap = await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("naver_lounges")
        .where("isActive", "==", true)
        .get();

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
        // 1. 게시글 목록 수집
        const { posts, skipped } = await collectLoungePosts(page, loungeUrl, date);

        if (skipped || posts.length === 0) {
          console.log(`[naverLoungePipeline] ${loungeName}: 해당일 게시글 없음 — skip`);
          results.skipped++;
          continue;
        }

        // 2. 포스트별 본문 + 댓글 수집
        let partialFailure = false;
        for (const post of posts) {
          // 본문 수집
          const { text, error: contentErr } = await collectPostContent(page, post.postUrl);
          post.text = text;
          if (contentErr) partialFailure = true;

          // 댓글 수집 (collectPostContent 이후 동일 페이지에 있으므로 재이동 최소화)
          const { comments, error: commentErr } = await collectPostComments(page, post.postUrl);
          post.comments = comments;
          post.commentCount = comments.length;
          if (commentErr) partialFailure = true;

          await sleep(POST_GAP_MS);
        }

        // 3. 집계
        const totalComments = posts.reduce((s, p) => s + (p.commentCount || 0), 0);

        // 4. AI 분석 (openrouterAnalyzer의 Facebook 분석 함수 재사용)
        let aiSummary = "", aiIssues = [];
        let promptTokens = 0, completionTokens = 0, totalCost = 0;

        try {
          const analysisResult = await analyzeFacebookGroupPosts({
            groupName: loungeName,
            date,
            posts,
            customPrompt: loungeData.analysisPrompt || "",
            model: loungeData.analysisModel || process.env.OPENROUTER_MODEL,
          });
          aiSummary = analysisResult.summary || "";
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

        // 5. Firestore 저장
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
          aiIssues,
          model:            loungeData.analysisModel || process.env.OPENROUTER_MODEL || "",
          promptTokens,
          completionTokens,
          totalTokens:      promptTokens + completionTokens,
          cost:             totalCost,
          crawlStatus,
          collectedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 부모 날짜 문서 생성
        await db
          .collection("workspaces")
          .doc(workspaceId)
          .collection("naver_reports")
          .doc(date)
          .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

        // 라운지별 리포트 저장
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

        // 6. 이메일 발송
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
          } catch (emailErr) {
            console.error(
              `[naverLoungePipeline] 이메일 발송 실패 (${loungeName}): ${emailErr.message}`
            );
          }
        }

        results.processed++;
      } catch (err) {
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
  } finally {
    try {
      await browser.close();
    } catch (_) {}
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
  targetDate = null
) {
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
      results.sent++;
    } catch (err) {
      console.error(`[naverLoungeEmailSender] 오류 (${lDoc.id}): ${err.message}`);
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
