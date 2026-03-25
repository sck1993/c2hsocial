"use strict";

const admin = require("firebase-admin");
const {
  fetchPagePosts,
  fetchPostComments,
  validatePageAccessToken,
} = require("./collectors/facebookPageCollector");
const { analyzeFacebookGroupPosts } = require("./analyzers/openrouterAnalyzer");
const { sendFacebookPageEmailReport, logDelivery, logDeliveryFailure } = require("./reportDelivery");
const {
  getKSTYesterdayString,
  sleep,
  getUtcRangeForKstDate,
} = require("./utils/dateUtils");

const POST_GAP_MS = 300;
const PAGE_GAP_MS = 1200;
const DEFAULT_WORKSPACE = "ws_antigravity";

function flattenComments(comments = []) {
  const out = [];

  for (const comment of comments) {
    out.push({
      author: comment.author || "",
      text: comment.text || "",
      likeCount: comment.likeCount || 0,
      createdTime: comment.createdTime || "",
      depth: 0,
    });

    for (const reply of comment.replies || []) {
      out.push({
        author: reply.author || "",
        text: reply.text || "",
        likeCount: reply.likeCount || 0,
        createdTime: reply.createdTime || "",
        depth: 1,
      });
    }
  }

  return out;
}

function compactPostsForStorage(posts = []) {
  return posts.map((post) => {
    const previewComments = flattenComments(post.comments || [])
      .slice(0, 20)
      .map((comment) => ({
        author: comment.author,
        text: String(comment.text || "").slice(0, 240),
        depth: comment.depth,
      }));

    return {
      postId: post.postId || "",
      postUrl: post.postUrl || "",
      message: String(post.message || "").slice(0, 1200),
      createdTime: post.createdTime || "",
      statusType: post.statusType || "",
      reactions: post.reactions || 0,
      topLevelCommentCount: post.topLevelCommentCount || 0,
      replyCount: post.replyCount || 0,
      commentCount: post.commentCount || 0,
      commentCoverage: post.commentCoverage || "full",
      truncatedComments: post.truncatedComments === true,
      truncatedReplies: post.truncatedReplies === true,
      commentPreview: previewComments,
      attachments: Array.isArray(post.attachments)
        ? post.attachments.slice(0, 5).map((att) => ({
            mediaType: att.mediaType || "",
            url: att.url || "",
            title: att.title || "",
            description: att.description || "",
          }))
        : [],
    };
  });
}

function isTokenErrorMessage(message = "") {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("access token") ||
    text.includes("oauth") ||
    text.includes("invalid") ||
    text.includes("expired") ||
    text.includes("permissions error") ||
    text.includes("permissions") ||
    text.includes("not authorized")
  );
}

function normalizeReportGroupName(pageData = {}, fallbackDocId = "") {
  return String(
    pageData.reportGroupName ||
    pageData.pageName ||
    pageData.pageId ||
    fallbackDocId ||
    "facebook_page"
  ).trim();
}

function buildReportGroupDocId(groupName = "") {
  const normalized = String(groupName || "facebook_page").trim() || "facebook_page";
  return `grp_${Buffer.from(normalized, "utf8").toString("base64url").slice(0, 180)}`;
}

function mergeRecipients(pages = []) {
  const merged = new Set();
  for (const page of pages) {
    const recipients = page.pageData?.deliveryConfig?.email?.recipients || [];
    const isEnabled = page.pageData?.deliveryConfig?.email?.isEnabled === true;
    if (!isEnabled) continue;
    for (const recipient of recipients) {
      const normalized = String(recipient || "").trim();
      if (normalized) merged.add(normalized);
    }
  }
  return Array.from(merged);
}

async function runFacebookPagePipeline(filterWorkspaceId = null, targetDate = null, options = {}) {
  const { skipEmail = false, triggerSource = "schedule" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;
  const { since, until } = getUtcRangeForKstDate(date);

  console.log(`[facebookPagePipeline] 시작 — workspaceId: ${workspaceId}, date: ${date}`);

  const results = { processed: 0, skipped: 0, errors: 0 };

  const pageSnap = await db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("facebook_pages")
    .where("isActive", "==", true)
    .get();

  if (pageSnap.empty) {
    console.log("[facebookPagePipeline] 활성 페이지 없음 — 종료");
    return results;
  }

  const groupedPages = new Map();
  for (const pageDoc of pageSnap.docs) {
    const pageData = pageDoc.data() || {};
    const reportGroupName = normalizeReportGroupName(pageData, pageDoc.id);
    if (!groupedPages.has(reportGroupName)) groupedPages.set(reportGroupName, []);
    groupedPages.get(reportGroupName).push({ pageDoc, pageData });
  }

  for (const [reportGroupName, groupPages] of groupedPages.entries()) {
    const reportDocId = buildReportGroupDocId(reportGroupName);
    const sourcePages = [];
    const mergedPosts = [];
    const recipients = mergeRecipients(groupPages);
    const analysisPrompt = groupPages.map((v) => String(v.pageData.analysisPrompt || "").trim()).find(Boolean) || "";
    const analysisModel = groupPages.map((v) => String(v.pageData.analysisModel || "").trim()).find(Boolean) || process.env.OPENROUTER_MODEL || "";
    let partialFailure = false;
    let anySuccessfulCollection = false;

    console.log(`[facebookPagePipeline] 리포트 그룹 처리: ${reportGroupName} (${groupPages.length}개 페이지)`);

    for (const { pageDoc, pageData } of groupPages) {
      const pageId = pageData.pageId || "";
      let pageName = pageData.pageName || pageId || pageDoc.id;
      const pageAccessToken = pageData.pageAccessToken || "";
      const pageRef = pageDoc.ref;

      if (!pageId || !pageAccessToken) {
        console.warn(`[facebookPagePipeline] pageId/pageAccessToken 누락 — skip (${pageDoc.id})`);
        await pageRef.set({
          tokenStatus: "missing",
          lastTokenError: "pageId 또는 pageAccessToken 누락",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        partialFailure = true;
        results.skipped += 1;
        sourcePages.push({
          docId: pageDoc.id,
          pageId,
          pageName,
          pageCategory: pageData.pageCategory || "",
          pictureUrl: pageData.pictureUrl || "",
          postCount: 0,
          totalComments: 0,
          totalReplies: 0,
          status: "missing",
        });
        continue;
      }

      console.log(`[facebookPagePipeline] 페이지 처리: ${pageName} (${pageId})`);

      try {
        const validated = await validatePageAccessToken(pageId, pageAccessToken);
        pageName = pageName || validated.pageName;
        await pageRef.set({
          tokenStatus: "valid",
          lastTokenError: admin.firestore.FieldValue.delete(),
          lastValidatedAt: admin.firestore.FieldValue.serverTimestamp(),
          pageName,
          pageCategory: validated.pageCategory || pageData.pageCategory || "",
          pictureUrl: validated.pictureUrl || pageData.pictureUrl || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        const postResult = await fetchPagePosts(pageId, pageAccessToken, { since, until });
        const posts = postResult.posts || [];
        anySuccessfulCollection = true;
        if (postResult.truncated === true) partialFailure = true;

        for (const post of posts) {
          try {
            const commentResult = await fetchPostComments(post.postId, pageAccessToken, { includeReplies: true });
            post.comments = commentResult.comments;
            post.topLevelCommentCount = commentResult.topLevelCommentCount;
            post.replyCount = commentResult.replyCount;
            post.commentCount = commentResult.totalComments;
            post.commentCoverage = commentResult.coverage;
            post.truncatedComments = commentResult.truncatedComments === true;
            post.truncatedReplies = commentResult.truncatedReplies === true;
            post.sourcePageId = pageId;
            post.sourcePageName = pageName;

            if (commentResult.coverage !== "full" || commentResult.replyErrorCount > 0) {
              partialFailure = true;
            }
          } catch (commentErr) {
            console.warn(`[facebookPagePipeline] 댓글 수집 실패 (${pageName}/${post.postId}): ${commentErr.message}`);
            partialFailure = true;
            post.comments = [];
            post.topLevelCommentCount = 0;
            post.replyCount = 0;
            post.commentCount = 0;
            post.commentCoverage = "failed";
            post.truncatedComments = false;
            post.truncatedReplies = false;
            post.sourcePageId = pageId;
            post.sourcePageName = pageName;
          }

          await sleep(POST_GAP_MS);
        }

        mergedPosts.push(...posts);
        sourcePages.push({
          docId: pageDoc.id,
          pageId,
          pageName,
          pageCategory: validated.pageCategory || pageData.pageCategory || "",
          pictureUrl: validated.pictureUrl || pageData.pictureUrl || "",
          postCount: posts.length,
          totalComments: posts.reduce((sum, post) => sum + (post.commentCount || 0), 0),
          totalReplies: posts.reduce((sum, post) => sum + (post.replyCount || 0), 0),
          status: posts.length ? "ok" : "no_posts",
        });
      } catch (err) {
        if (isTokenErrorMessage(err.message)) {
          await pageRef.set({
            tokenStatus: "invalid",
            lastTokenError: err.message,
            lastValidatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        const detail = err.response?.data ? JSON.stringify(err.response.data) : "";
        console.error(
          `[facebookPagePipeline] ${workspaceId}/${pageDoc.id} 오류: ${err.message}${detail ? " — " + detail : ""}`
        );
        partialFailure = true;
        results.errors += 1;
        sourcePages.push({
          docId: pageDoc.id,
          pageId,
          pageName,
          pageCategory: pageData.pageCategory || "",
          pictureUrl: pageData.pictureUrl || "",
          postCount: 0,
          totalComments: 0,
          totalReplies: 0,
          status: "error",
          error: err.message,
        });
      }

      await sleep(PAGE_GAP_MS);
    }

    if (!anySuccessfulCollection && !sourcePages.length) {
      console.log(`[facebookPagePipeline] ${reportGroupName}: 수집 성공 페이지 없음 — 종료`);
      results.skipped += 1;
      continue;
    }

    mergedPosts.sort((a, b) => String(b.createdTime || "").localeCompare(String(a.createdTime || "")));

    const primarySource = sourcePages[0] || {};
    const totalReactions = mergedPosts.reduce((sum, post) => sum + (post.reactions || 0), 0);
    const totalComments = mergedPosts.reduce((sum, post) => sum + (post.commentCount || 0), 0);
    const totalReplies = mergedPosts.reduce((sum, post) => sum + (post.replyCount || 0), 0);

    let aiSummary = "";
    let aiSummary_en = "";
    let aiSentiment = { positive: 0, neutral: 100, negative: 0 };
    let aiKeywords = [];
    let aiKeywords_en = [];
    let aiIssues = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let totalCost = 0;

    if (!mergedPosts.length) {
      aiSummary = "게시물이 존재하지 않습니다";
      aiSummary_en = "No posts were found.";
    } else {
      try {
        const analysisResult = await analyzeFacebookGroupPosts({
          groupName: reportGroupName,
          pageName: reportGroupName,
          date,
          posts: mergedPosts,
          customPrompt: analysisPrompt,
          model: analysisModel,
          platform: "facebook_page",
        });

        aiSummary = analysisResult.summary || "";
        aiSummary_en = analysisResult.summary_en || "";
        aiSentiment = analysisResult.sentiment || aiSentiment;
        aiKeywords = analysisResult.keywords || [];
        aiKeywords_en = analysisResult.keywords_en || [];
        aiIssues = analysisResult.issues || [];

        const usage = analysisResult.usage || {};
        promptTokens = usage.prompt_tokens || 0;
        completionTokens = usage.completion_tokens || 0;
        totalCost = parseFloat(Number(usage.cost || 0).toFixed(6));
      } catch (aiErr) {
        console.warn(`[facebookPagePipeline] AI 분석 실패 (${reportGroupName}): ${aiErr.message}`);
      }
    }

    const crawlStatus = mergedPosts.length === 0
      ? (partialFailure ? "partial" : "no_posts")
      : (partialFailure ? "partial" : "ok");

    const reportData = {
      reportGroupName,
      pageId: sourcePages.length === 1 ? (primarySource.pageId || "") : "",
      pageIds: sourcePages.map((page) => page.pageId).filter(Boolean),
      pageName: reportGroupName,
      pageCategory: sourcePages.map((page) => page.pageCategory).filter(Boolean).join(", "),
      pictureUrl: primarySource.pictureUrl || "",
      sourcePageCount: sourcePages.length,
      sourcePageDocIds: sourcePages.map((page) => page.docId).filter(Boolean),
      sourcePages,
      date,
      postCount: mergedPosts.length,
      totalReactions,
      totalComments,
      totalReplies,
      postListTruncated: mergedPosts.some((post) => post.commentCoverage === "partial" || post.truncatedComments || post.truncatedReplies),
      posts: compactPostsForStorage(mergedPosts),
      aiSummary,
      aiSummary_en,
      aiSentiment,
      aiKeywords,
      aiKeywords_en,
      aiIssues,
      model: analysisModel,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cost: totalCost,
      crawlStatus,
      collectedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db
      .collection("workspaces")
      .doc(workspaceId)
      .collection("facebook_page_reports")
      .doc(date)
      .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    await db
      .collection("workspaces")
      .doc(workspaceId)
      .collection("facebook_page_reports")
      .doc(date)
      .collection("pages")
      .doc(reportDocId)
      .set(reportData);

    console.log(
      `[facebookPagePipeline] ${reportGroupName}: 저장 완료 (pages: ${sourcePages.length}, posts: ${mergedPosts.length}, comments: ${totalComments}, crawlStatus: ${crawlStatus})`
    );

    if (!skipEmail && recipients.length > 0) {
      try {
        await sendFacebookPageEmailReport({
          recipients,
          pageName: reportGroupName,
          date,
          report: reportData,
        });
        console.log(`[facebookPagePipeline] 이메일 발송 완료: ${reportGroupName}`);
        logDelivery(db, workspaceId, {
          platform: "facebook_page",
          target: reportGroupName,
          targetId: reportDocId,
          reportType: "daily",
          reportDate: date,
          recipientCount: recipients.length,
          triggerSource,
        });
      } catch (emailErr) {
        console.error(`[facebookPagePipeline] 이메일 발송 실패 (${reportGroupName}): ${emailErr.message}`);
        logDeliveryFailure(db, workspaceId, {
          platform: "facebook_page",
          target: reportGroupName,
          targetId: reportDocId,
          reportType: "daily",
          reportDate: date,
          recipientCount: recipients.length,
          triggerSource,
          errorMessage: emailErr.message,
        });
      }
    }

    results.processed += 1;
  }

  console.log(
    `[facebookPagePipeline] 완료 — processed: ${results.processed}, skipped: ${results.skipped}, errors: ${results.errors}`
  );
  return results;
}

async function runFacebookPageEmailSender(filterWorkspaceId = null, targetDate = null, options = {}) {
  const { triggerSource = "manual" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(`[facebookPageEmailSender] 시작 — workspaceId: ${workspaceId}, date: ${date}`);

  const results = { sent: 0, skipped: 0, errors: 0 };

  const pageSnap = await db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("facebook_pages")
    .where("isActive", "==", true)
    .get();

  const groupedPages = new Map();
  for (const pageDoc of pageSnap.docs) {
    const pageData = pageDoc.data() || {};
    const reportGroupName = normalizeReportGroupName(pageData, pageDoc.id);
    if (!groupedPages.has(reportGroupName)) groupedPages.set(reportGroupName, []);
    groupedPages.get(reportGroupName).push({ pageDoc, pageData });
  }

  for (const [reportGroupName, groupPages] of groupedPages.entries()) {
    const recipients = mergeRecipients(groupPages);
    if (!recipients.length) {
      results.skipped += 1;
      continue;
    }

    try {
      const reportSnap = await db
        .collection("workspaces")
        .doc(workspaceId)
        .collection("facebook_page_reports")
        .doc(date)
        .collection("pages")
        .doc(buildReportGroupDocId(reportGroupName))
        .get();

      if (!reportSnap.exists) {
        console.warn(`[facebookPageEmailSender] 리포트 없음 — ${reportGroupName}/${date}`);
        results.skipped += 1;
        continue;
      }

      await sendFacebookPageEmailReport({
        recipients,
        pageName: reportGroupName,
        date,
        report: reportSnap.data(),
      });

      console.log(`[facebookPageEmailSender] 발송 완료: ${reportGroupName}`);
      logDelivery(db, workspaceId, {
        platform: "facebook_page",
        target: reportGroupName,
        targetId: buildReportGroupDocId(reportGroupName),
        reportType: "daily",
        reportDate: date,
        recipientCount: recipients.length,
        triggerSource,
      });
      results.sent += 1;
    } catch (err) {
      console.error(`[facebookPageEmailSender] 오류 (${reportGroupName}): ${err.message}`);
      logDeliveryFailure(db, workspaceId, {
        platform: "facebook_page",
        target: reportGroupName,
        targetId: buildReportGroupDocId(reportGroupName),
        reportType: "daily",
        reportDate: date,
        recipientCount: recipients.length,
        triggerSource,
        errorMessage: err.message,
      });
      results.errors += 1;
    }
  }

  console.log(`[facebookPageEmailSender] 완료 — sent: ${results.sent}, errors: ${results.errors}`);
  return results;
}

module.exports = {
  runFacebookPagePipeline,
  runFacebookPageEmailSender,
};
