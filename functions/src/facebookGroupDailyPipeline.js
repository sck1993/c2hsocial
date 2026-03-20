/**
 * facebookGroupDailyPipeline.js
 * Facebook 그룹 일일 수집 → AI 분석 → Firestore 저장 → 이메일 발송
 *
 * exports:
 *   runFacebookGroupPipeline(filterWorkspaceId?, targetDate?, options?)
 *   runFacebookGroupEmailSender(filterWorkspaceId?, targetDate?)
 */

const admin = require("firebase-admin");
const {
  launchBrowser,
  loadSessionFromFirestore,
  markSessionInvalid,
  applyCookiesToContext,
  verifySessionAlive,
  collectGroupPosts,
  collectPostComments,
  fetchPostImages,
} = require("./collectors/facebookGroupCollector");
const { analyzeFacebookGroupPosts } = require("./analyzers/openrouterAnalyzer");
const { sendFacebookEmailReport } = require("./reportDelivery");
const { getKSTYesterdayString } = require("./utils/dateUtils");

const POST_GAP_MS = 2000;   // 포스트 간 대기 ms
const GROUP_GAP_MS = 5000;  // 그룹 간 대기 ms
const DEFAULT_WORKSPACE = "ws_antigravity";

// ── 헬퍼 ─────────────────────────────────────────────────────────
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
async function runFacebookGroupPipeline(filterWorkspaceId = null, targetDate = null, options = {}) {
  const { skipEmail = false } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(`[facebookGroupPipeline] 시작 — workspaceId: ${workspaceId}, date: ${date}`);

  const results = { processed: 0, skipped: 0, errors: 0 };

  // ── 세션 로드 ───────────────────────────────────────────────────
  let session;
  try {
    session = await loadSessionFromFirestore(db, workspaceId);
  } catch (err) {
    console.error("[facebookGroupPipeline] 세션 로드 실패:", err.message);
    return results;
  }

  if (!session || !session.cookies || session.cookies.length === 0) {
    console.warn("[facebookGroupPipeline] 저장된 세션 없음 — 파이프라인 중단");
    return results;
  }

  // ── 브라우저 실행 ────────────────────────────────────────────────
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    console.error("[facebookGroupPipeline] 브라우저 실행 실패:", err.message);
    return results;
  }

  let context;
  let page;
  try {
    context = await browser.newContext({
      userAgent: session.userAgent || undefined,
      locale: "ko-KR",
      extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8" },
    });

    // 쿠키 주입
    await applyCookiesToContext(context, session.cookies);
    page = await context.newPage();

    // ── 세션 유효성 확인 ──────────────────────────────────────────
    const alive = await verifySessionAlive(page);
    if (!alive) {
      console.warn("[facebookGroupPipeline] 세션 만료 감지 — isValid=false 마킹");
      await markSessionInvalid(db, workspaceId);

      // 모든 그룹에 crawlStatus="session_expired" 저장
      const groupSnap = await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("facebook_groups")
        .where("isActive", "==", true)
        .get();

      for (const gDoc of groupSnap.docs) {
        await db
          .collection("workspaces")
          .doc(workspaceId)
          .collection("facebook_reports")
          .doc(date)
          .collection("groups")
          .doc(gDoc.id)
          .set(
            {
              groupId: gDoc.data().groupId || gDoc.id,
              groupName: gDoc.data().groupName || "",
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

    // ── 그룹 목록 조회 ───────────────────────────────────────────
    const groupSnap = await db
      .collection("workspaces")
      .doc(workspaceId)
      .collection("facebook_groups")
      .where("isActive", "==", true)
      .get();

    if (groupSnap.empty) {
      console.log("[facebookGroupPipeline] 활성 그룹 없음 — 종료");
      return results;
    }

    // ── 그룹 순회 ────────────────────────────────────────────────
    for (const gDoc of groupSnap.docs) {
      const groupData = gDoc.data();
      const groupId   = groupData.groupId   || gDoc.id;
      const groupName = groupData.groupName || "";
      const groupUrl  = groupData.groupUrl  || "";

      if (!groupUrl) {
        console.warn(`[facebookGroupPipeline] groupUrl 없음 — skip (${gDoc.id})`);
        results.skipped++;
        continue;
      }

      console.log(`[facebookGroupPipeline] 그룹 처리: ${groupName} (${groupId})`);

      try {
        // 1. 게시글 수집
        const { posts, skipped } = await collectGroupPosts(page, groupUrl, date);

        if (skipped || posts.length === 0) {
          console.log(`[facebookGroupPipeline] ${groupName}: 해당일 게시글 없음 — skip`);
          results.skipped++;
          continue;
        }

        // 2. 포스트별 댓글 + 이미지 수집
        let partialFailure = false;
        for (const post of posts) {
          // 댓글 수집
          const { comments, error } = await collectPostComments(page, post.postUrl);
          post.comments = comments;
          post.commentCount = comments.length;
          if (error) partialFailure = true;

          // 이미지 base64 변환 (쿠키 인증 필요, 포스트 페이지에서 실행)
          if (post.imageUrls && post.imageUrls.length > 0) {
            post.images = await fetchPostImages(page, post.imageUrls);
            console.log(
              `[facebookGroupPipeline] 이미지 변환: ${post.images.length}/${post.imageUrls.length}장 (${post.postUrl.split("/").slice(-2).join("/")})`
            );
          }

          await sleep(POST_GAP_MS);
        }

        // 3. 집계
        const totalReactions = posts.reduce((s, p) => s + (p.reactions || 0), 0);
        const totalComments  = posts.reduce((s, p) => s + (p.commentCount || 0), 0);

        // 4. AI 분석
        let aiSummary = "", aiSentiment = { positive: 0, neutral: 100, negative: 0 };
        let aiKeywords = [], aiIssues = [];
        let promptTokens = 0, completionTokens = 0, totalCost = 0;

        try {
          const analysisResult = await analyzeFacebookGroupPosts({
            groupName,
            date,
            posts,
            customPrompt: groupData.analysisPrompt || "",
            model: groupData.analysisModel || process.env.OPENROUTER_MODEL,
          });
          aiSummary   = analysisResult.summary   || "";
          aiSentiment = analysisResult.sentiment || aiSentiment;
          aiKeywords  = analysisResult.keywords  || [];
          aiIssues    = analysisResult.issues    || [];

          const usage = analysisResult.usage || {};
          promptTokens     = usage.prompt_tokens     || 0;
          completionTokens = usage.completion_tokens || 0;
          totalCost        = parseFloat(Number(usage.cost || 0).toFixed(6));
        } catch (aiErr) {
          console.warn(`[facebookGroupPipeline] AI 분석 실패 (${groupName}): ${aiErr.message}`);
        }

        // 5. Firestore 저장 (base64 이미지 제거 — 문서 크기 초과 방지)
        const postsForStorage = posts.map(({ images, imageUrls, ...rest }) => rest);

        const crawlStatus = partialFailure ? "partial" : "ok";
        const reportData = {
          groupId,
          groupName,
          groupUrl,
          date,
          postCount:       posts.length,
          totalReactions,
          totalComments,
          posts: postsForStorage,
          aiSummary,
          aiSentiment,
          aiKeywords,
          aiIssues,
          model:            groupData.analysisModel || process.env.OPENROUTER_MODEL || "",
          promptTokens,
          completionTokens,
          totalTokens:      promptTokens + completionTokens,
          cost:             totalCost,
          crawlStatus,
          collectedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 부모 문서 (날짜 문서) 생성
        await db
          .collection("workspaces")
          .doc(workspaceId)
          .collection("facebook_reports")
          .doc(date)
          .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

        // 그룹별 리포트 저장
        await db
          .collection("workspaces")
          .doc(workspaceId)
          .collection("facebook_reports")
          .doc(date)
          .collection("groups")
          .doc(gDoc.id)
          .set(reportData);

        console.log(
          `[facebookGroupPipeline] ${groupName}: 저장 완료 (posts: ${posts.length}, crawlStatus: ${crawlStatus})`
        );

        // 6. 이메일 발송
        const emailConfig = groupData.deliveryConfig?.email;
        if (!skipEmail && emailConfig?.isEnabled && (emailConfig.recipients || []).length > 0) {
          try {
            await sendFacebookEmailReport({
              recipients: emailConfig.recipients,
              groupName,
              groupUrl,
              date,
              report: reportData,
            });
            console.log(`[facebookGroupPipeline] 이메일 발송 완료: ${groupName}`);
          } catch (emailErr) {
            console.error(`[facebookGroupPipeline] 이메일 발송 실패 (${groupName}): ${emailErr.message}`);
          }
        }

        results.processed++;
      } catch (err) {
        if (err.message === "SESSION_EXPIRED") {
          console.warn("[facebookGroupPipeline] 그룹 접근 중 세션 만료 감지 — isValid=false 마킹 후 중단");
          await markSessionInvalid(db, workspaceId);
          results.errors++;
          break; // 나머지 그룹 처리 불필요
        }
        const detail = err.response?.data ? JSON.stringify(err.response.data) : "";
        console.error(
          `[facebookGroupPipeline] ${workspaceId}/${gDoc.id} 오류: ${err.message}${detail ? " — " + detail : ""}`
        );
        results.errors++;
      }

      await sleep(GROUP_GAP_MS);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  console.log(
    `[facebookGroupPipeline] 완료 — processed: ${results.processed}, skipped: ${results.skipped}, errors: ${results.errors}`
  );
  return results;
}

// ── 이메일 재발송 ────────────────────────────────────────────────
/**
 * 저장된 리포트를 읽어 이메일만 재발송
 */
async function runFacebookGroupEmailSender(filterWorkspaceId = null, targetDate = null) {
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(`[facebookGroupEmailSender] 시작 — workspaceId: ${workspaceId}, date: ${date}`);

  const results = { sent: 0, skipped: 0, errors: 0 };

  const groupSnap = await db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("facebook_groups")
    .where("isActive", "==", true)
    .get();

  for (const gDoc of groupSnap.docs) {
    const groupData = gDoc.data();
    const emailConfig = groupData.deliveryConfig?.email;
    if (!emailConfig?.isEnabled || !(emailConfig.recipients || []).length) {
      results.skipped++;
      continue;
    }

    try {
      const reportSnap = await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("facebook_reports")
        .doc(date)
        .collection("groups")
        .doc(gDoc.id)
        .get();

      if (!reportSnap.exists) {
        console.warn(`[facebookGroupEmailSender] 리포트 없음 — ${gDoc.id}/${date}`);
        results.skipped++;
        continue;
      }

      const report = reportSnap.data();
      await sendFacebookEmailReport({
        recipients: emailConfig.recipients,
        groupName:  groupData.groupName || "",
        groupUrl:   groupData.groupUrl  || "",
        date,
        report,
      });

      console.log(`[facebookGroupEmailSender] 발송 완료: ${groupData.groupName}`);
      results.sent++;
    } catch (err) {
      console.error(`[facebookGroupEmailSender] 오류 (${gDoc.id}): ${err.message}`);
      results.errors++;
    }
  }

  console.log(`[facebookGroupEmailSender] 완료 — sent: ${results.sent}, errors: ${results.errors}`);
  return results;
}

module.exports = {
  runFacebookGroupPipeline,
  runFacebookGroupEmailSender,
};
