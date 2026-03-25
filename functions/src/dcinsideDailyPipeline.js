/**
 * dcinsideDailyPipeline.js
 * 디시인사이드 갤러리 일일 수집 → AI 분석 → Firestore 저장 → 이메일 발송
 *
 * exports:
 *   runDcinsidePipeline(filterWorkspaceId?, targetDate?, options?)
 *   runDcinsideEmailSender(filterWorkspaceId?, targetDate?)
 */

const admin = require("firebase-admin");
const { analyzeFacebookGroupPosts } = require("./analyzers/openrouterAnalyzer");
const { sendDcinsideEmailReport, logDelivery, logDeliveryFailure } = require("./reportDelivery");
const { getKSTYesterdayString, sleep } = require("./utils/dateUtils");

const GALLERY_GAP_MS = 3000;
const DEFAULT_WORKSPACE = "ws_antigravity";

// ── 메인 파이프라인 ──────────────────────────────────────────────

/**
 * @param {string|null}  filterWorkspaceId  - 특정 워크스페이스만 실행 (null → 기본값)
 * @param {string|null}  targetDate         - 'YYYY-MM-DD', null → KST 어제
 * @param {object}       options
 * @param {boolean}      options.skipEmail  - true 시 이메일 발송 건너뜀
 */
async function runDcinsidePipeline(
  filterWorkspaceId = null,
  targetDate = null,
  options = {}
) {
  const { skipEmail = false, triggerSource = "schedule" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(
    `[dcinsidePipeline] 시작 — workspaceId: ${workspaceId}, date: ${date}`
  );

  const results = { processed: 0, skipped: 0, errors: 0 };

  // ── 갤러리 목록 조회 ───────────────────────────────────────────
  const gallerySnap = await db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("dcinside_galleries")
    .where("isActive", "==", true)
    .get();

  if (gallerySnap.empty) {
    console.log("[dcinsidePipeline] 활성 갤러리 없음 — 종료");
    return results;
  }

  // ── 갤러리 순회 ────────────────────────────────────────────────
  for (const gDoc of gallerySnap.docs) {
    const gData = gDoc.data();
    const galleryId   = gData.galleryId   || "";
    const galleryType = gData.galleryType || "general";
    const galleryName = gData.galleryName || galleryId;
    const galleryUrl  = gData.galleryUrl  || "";

    if (!galleryId) {
      console.warn(`[dcinsidePipeline] galleryId 없음 — skip (${gDoc.id})`);
      results.skipped++;
      continue;
    }

    console.log(
      `[dcinsidePipeline] 갤러리 처리: ${galleryName} (${galleryId}, ${galleryType})`
    );

    try {
      // ── Mac Mini가 수집한 데이터 읽기 ─────────────────────────
      const collectedSnap = await db
        .collection("workspaces").doc(workspaceId)
        .collection("dcinside_collected").doc(date)
        .collection("galleries").doc(gDoc.id)
        .get();

      if (!collectedSnap.exists) {
        console.warn(`[dcinsidePipeline] ${galleryName}: 수집 데이터 없음 — Mac Mini가 실행됐는지 확인하세요`);
        results.skipped++;
        continue;
      }

      const collectedData = collectedSnap.data();
      const posts = collectedData.posts || [];

      if (collectedData.skipped || posts.length === 0) {
        console.log(`[dcinsidePipeline] ${galleryName}: 해당일 게시글 없음 — skip`);
        results.skipped++;
        continue;
      }

      const totalComments = posts.reduce(
        (sum, p) => sum + (p.comments ? p.comments.length : 0),
        0
      );
      const totalViews = posts.reduce((sum, p) => sum + (p.viewCount || 0), 0);
      const totalRecommends = posts.reduce(
        (sum, p) => sum + (p.recommendCount || 0),
        0
      );

      // ── AI 분석 ────────────────────────────────────────────────
      let aiSummary = "";
      let aiSummary_en = "";
      let aiSentiment = { positive: 0, neutral: 100, negative: 0 };
      let aiKeywords_en = [];
      let aiIssues = [];
      let promptTokens = 0;
      let completionTokens = 0;
      let totalCost = 0;

      try {
        const analysisResult = await analyzeFacebookGroupPosts({
          groupName: galleryName,
          date,
          posts,
          customPrompt: gData.analysisPrompt || "",
          model: gData.analysisModel || process.env.OPENROUTER_MODEL,
          platform: "dcinside",
        });
        aiSummary    = analysisResult.summary    || "";
        aiSummary_en = analysisResult.summary_en || "";
        aiSentiment  = analysisResult.sentiment  || aiSentiment;
        aiKeywords_en= analysisResult.keywords_en || [];
        aiIssues     = analysisResult.issues     || [];

        const usage  = analysisResult.usage || {};
        promptTokens     = usage.prompt_tokens     || 0;
        completionTokens = usage.completion_tokens || 0;
        totalCost        = Number(usage.cost || 0).toFixed(6);
      } catch (aiErr) {
        console.warn(
          `[dcinsidePipeline] AI 분석 실패 (${galleryName}): ${aiErr.message}`
        );
      }

      // ── Firestore 저장 ─────────────────────────────────────────
      const reportData = {
        galleryId,
        galleryName,
        galleryUrl,
        galleryType,
        date,
        postCount:        posts.length,
        totalComments,
        totalViews,
        totalRecommends,
        posts,
        aiSummary,
        aiSummary_en,
        aiSentiment,
        aiKeywords_en,
        aiIssues,
        model:            gData.analysisModel || process.env.OPENROUTER_MODEL || "",
        promptTokens,
        completionTokens,
        totalTokens:      promptTokens + completionTokens,
        cost:             totalCost,
        crawlStatus:      "ok",
        collectedAt:      admin.firestore.FieldValue.serverTimestamp(),
      };

      await db
        .collection("workspaces").doc(workspaceId)
        .collection("dcinside_reports").doc(date)
        .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      await db
        .collection("workspaces").doc(workspaceId)
        .collection("dcinside_reports").doc(date)
        .collection("galleries").doc(gDoc.id)
        .set(reportData);

      console.log(
        `[dcinsidePipeline] ${galleryName}: 저장 완료 (posts: ${posts.length})`
      );

      // ── 이메일 발송 ────────────────────────────────────────────
      const emailConfig = gData.deliveryConfig?.email;
      if (
        !skipEmail &&
        emailConfig?.isEnabled &&
        (emailConfig.recipients || []).length > 0
      ) {
        try {
          await sendDcinsideEmailReport({
            recipients: emailConfig.recipients,
            galleryName,
            galleryUrl,
            date,
            report: reportData,
          });
          console.log(`[dcinsidePipeline] 이메일 발송 완료: ${galleryName}`);
          logDelivery(db, workspaceId, {
            platform: "dcinside",
            target: galleryName,
            targetId: gDoc.id,
            reportType: "daily",
            reportDate: date,
            recipientCount: emailConfig.recipients.length,
            triggerSource,
          });
        } catch (emailErr) {
          console.error(
            `[dcinsidePipeline] 이메일 발송 실패 (${galleryName}): ${emailErr.message}`
          );
          logDeliveryFailure(db, workspaceId, {
            platform: "dcinside",
            target: galleryName,
            targetId: gDoc.id,
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
      console.error(
        `[dcinsidePipeline] ${workspaceId}/${gDoc.id} 오류: ${err.message}`
      );
      results.errors++;
    }

    await sleep(GALLERY_GAP_MS);
  }

  console.log(
    `[dcinsidePipeline] 완료 — processed: ${results.processed}, skipped: ${results.skipped}, errors: ${results.errors}`
  );
  return results;
}

// ── 이메일 재발송 ─────────────────────────────────────────────────

async function runDcinsideEmailSender(
  filterWorkspaceId = null,
  targetDate = null,
  options = {}
) {
  const { triggerSource = "manual" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(
    `[dcinsideEmailSender] 시작 — workspaceId: ${workspaceId}, date: ${date}`
  );

  const results = { sent: 0, skipped: 0, errors: 0 };

  const gallerySnap = await db
    .collection("workspaces").doc(workspaceId)
    .collection("dcinside_galleries")
    .where("isActive", "==", true)
    .get();

  for (const gDoc of gallerySnap.docs) {
    const gData = gDoc.data();
    const emailConfig = gData.deliveryConfig?.email;
    if (!emailConfig?.isEnabled || !(emailConfig.recipients || []).length) {
      results.skipped++;
      continue;
    }

    try {
      const reportSnap = await db
        .collection("workspaces").doc(workspaceId)
        .collection("dcinside_reports").doc(date)
        .collection("galleries").doc(gDoc.id)
        .get();

      if (!reportSnap.exists) {
        console.warn(`[dcinsideEmailSender] 리포트 없음 — ${gDoc.id}/${date}`);
        results.skipped++;
        continue;
      }

      const report = reportSnap.data();
      await sendDcinsideEmailReport({
        recipients:  emailConfig.recipients,
        galleryName: gData.galleryName || "",
        galleryUrl:  gData.galleryUrl  || "",
        date,
        report,
      });

      console.log(`[dcinsideEmailSender] 발송 완료: ${gData.galleryName}`);
      logDelivery(db, workspaceId, {
        platform: "dcinside",
        target: gData.galleryName || gDoc.id,
        targetId: gDoc.id,
        reportType: "daily",
        reportDate: date,
        recipientCount: emailConfig.recipients.length,
        triggerSource,
      });
      results.sent++;
    } catch (err) {
      console.error(`[dcinsideEmailSender] 오류 (${gDoc.id}): ${err.message}`);
      logDeliveryFailure(db, workspaceId, {
        platform: "dcinside",
        target: gData.galleryName || gDoc.id,
        targetId: gDoc.id,
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
    `[dcinsideEmailSender] 완료 — sent: ${results.sent}, errors: ${results.errors}`
  );
  return results;
}

module.exports = {
  runDcinsidePipeline,
  runDcinsideEmailSender,
};
