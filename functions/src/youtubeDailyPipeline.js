"use strict";

const admin = require("firebase-admin");
const { searchVideos, fetchVideosByIds } = require("./collectors/youtubeCollector");
const { analyzeYoutubeVideos, analyzeYoutubeVideoRelevance } = require("./analyzers/openrouterAnalyzer");
const { sendYoutubeEmailReport, logDelivery, logDeliveryFailure } = require("./reportDelivery");
const { getKSTYesterdayString } = require("./utils/dateUtils");

const DEFAULT_WORKSPACE = "ws_antigravity";
const MAX_GROUP_VIDEOS = 50;
const MAX_RELEVANCE_CANDIDATES = 120;
const SEARCH_PAGE_LIMIT = 1;

async function getYoutubeApiKeyForWorkspace(db, workspaceId) {
  const snap = await db.collection("workspaces").doc(workspaceId)
    .collection("settings").doc("api_keys")
    .get();
  return String(snap.data()?.youtubeDataApiKey || process.env.YOUTUBE_API_KEY || "").trim();
}

function getYoutubeUtcRangeForKstDate(date) {
  return {
    publishedAfter: `${date}T00:00:00+09:00`,
    publishedBefore: `${date}T23:59:59+09:00`,
  };
}

function normalizeMatchedVideo(existing = null, incoming = {}, queryText = "") {
  const nextQueries = new Set(existing?.matchedQueries || []);
  if (queryText) nextQueries.add(queryText);
  return {
    ...(existing || {}),
    ...incoming,
    matchedQueries: Array.from(nextQueries),
    isShortCandidate: Number.isFinite(incoming.durationSeconds) ? incoming.durationSeconds <= 60 : Boolean(existing?.isShortCandidate),
  };
}

function sortByPublishedDesc(a, b) {
  return String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
}

function buildEmptyYoutubeSummary() {
  return [
    "<strong>[업로드 동향]</strong> 관련성 판정 후 <strong>보고 대상 영상이 없습니다.</strong>",
    "<strong>[반응 요약]</strong> 특이사항 없음",
  ].join("<br><br>");
}

function buildEmptyYoutubeSummaryEn() {
  return [
    "<strong>[Upload Trend]</strong> <strong>No reportable videos remained</strong> after relevance filtering.",
    "<strong>[Reaction Summary]</strong> Nothing meaningful to summarize.",
  ].join("<br><br>");
}

async function listGroupsWithQueries(db, workspaceId) {
  const groupSnap = await db.collection("workspaces").doc(workspaceId)
    .collection("youtube_groups")
    .where("isActive", "==", true)
    .get();

  const groups = [];
  for (const groupDoc of groupSnap.docs) {
    const querySnap = await groupDoc.ref.collection("queries")
      .where("isActive", "==", true)
      .get();
    groups.push({
      doc: groupDoc,
      data: groupDoc.data() || {},
      queries: querySnap.docs.map((queryDoc) => ({
        id: queryDoc.id,
        ...queryDoc.data(),
      })).filter((query) => String(query.query || "").trim()),
    });
  }
  return groups;
}

async function runYoutubePipeline(filterWorkspaceId = null, targetDate = null, options = {}) {
  const { skipEmail = false, triggerSource = "schedule" } = options;
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;
  const { publishedAfter, publishedBefore } = getYoutubeUtcRangeForKstDate(date);

  console.log(`[youtubePipeline] 시작 — workspaceId: ${workspaceId}, date: ${date}`);
  const results = { processed: 0, skipped: 0, errors: 0 };
  const groups = await listGroupsWithQueries(db, workspaceId);
  if (!groups.length) {
    console.log("[youtubePipeline] 활성 그룹 없음 — 종료");
    return results;
  }
  const youtubeApiKey = await getYoutubeApiKeyForWorkspace(db, workspaceId);
  if (!youtubeApiKey) {
    throw new Error("YouTube API 키가 설정되지 않았습니다.");
  }

  for (const group of groups) {
    const groupDocId = group.doc.id;
    const groupData = group.data || {};
    const groupName = String(groupData.name || groupDocId).trim() || groupDocId;
    const groupNameEn = String(groupData.nameEn || "").trim();
    const queries = group.queries || [];
    const maxResultsPerQuery = Math.min(Math.max(Number(groupData.maxResultsPerQuery) || 25, 1), 50);

    if (!queries.length) {
      console.log(`[youtubePipeline] ${groupName}: 활성 키워드 없음 — skip`);
      results.skipped += 1;
      continue;
    }

    try {
      const matchedVideoMap = new Map();

      for (const queryData of queries) {
        const queryText = String(queryData.query || "").trim();
        if (!queryText) continue;

        let pageToken = null;
        for (let page = 0; page < SEARCH_PAGE_LIMIT; page++) {
          const searchResult = await searchVideos({
            apiKey: youtubeApiKey,
            query: queryText,
            publishedAfter,
            publishedBefore,
            maxResults: maxResultsPerQuery,
            pageToken,
          });
          for (const item of searchResult.items) {
            const existing = matchedVideoMap.get(item.videoId) || null;
            matchedVideoMap.set(
              item.videoId,
              normalizeMatchedVideo(existing, {
                videoId: item.videoId,
                videoUrl: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : "",
                title: item.title,
                descriptionSnippet: item.descriptionSnippet,
                channelId: item.channelId,
                channelTitle: item.channelTitle,
                publishedAt: item.publishedAt,
                thumbnailUrl: item.thumbnailUrl,
              }, queryText)
            );
          }
          if (!searchResult.nextPageToken) break;
          pageToken = searchResult.nextPageToken;
        }
      }

      const videoIds = Array.from(matchedVideoMap.keys());
      const detailedVideos = await fetchVideosByIds(videoIds, youtubeApiKey);
      for (const video of detailedVideos) {
        const existing = matchedVideoMap.get(video.videoId) || null;
        matchedVideoMap.set(
          video.videoId,
          normalizeMatchedVideo(existing, video)
        );
      }

      const candidateVideos = Array.from(matchedVideoMap.values())
        .sort(sortByPublishedDesc)
        .slice(0, MAX_RELEVANCE_CANDIDATES);

      let relevantVideos = candidateVideos;
      let candidateVideoCount = candidateVideos.length;
      let relevantVideoCount = candidateVideos.length;
      let uncertainVideoCount = 0;
      let irrelevantVideoCount = 0;
      let filteredOutVideoCount = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let totalCost = 0;
      const analysisModel = String(groupData.analysisModel || process.env.OPENROUTER_MODEL || "").trim();

      if (candidateVideos.length > 0) {
        try {
          const relevanceResult = await analyzeYoutubeVideoRelevance({
            groupName,
            queries: queries.map((query) => String(query.query || "").trim()).filter(Boolean),
            videos: candidateVideos,
            model: analysisModel,
          });
          const relevanceMap = new Map(
            relevanceResult.items.map((item) => [item.index - 1, item])
          );
          const classifiedVideos = candidateVideos.map((video, index) => {
            const relevance = relevanceMap.get(index) || {};
            return {
              ...video,
              relevanceStatus: relevance.status || "unsure",
              relevanceScore: Number.isFinite(relevance.score) ? Number(relevance.score.toFixed(2)) : null,
              relevanceReason: relevance.reason || "",
              relevanceTopicLabel: relevance.topicLabel || "",
            };
          });
          relevantVideos = classifiedVideos.filter((video) => video.relevanceStatus === "relevant");
          uncertainVideoCount = classifiedVideos.filter((video) => video.relevanceStatus === "unsure").length;
          irrelevantVideoCount = classifiedVideos.filter((video) => video.relevanceStatus === "irrelevant").length;
          relevantVideoCount = relevantVideos.length;
          filteredOutVideoCount = classifiedVideos.length - relevantVideoCount;
          const relevanceUsage = relevanceResult.usage || {};
          promptTokens += relevanceUsage.prompt_tokens || 0;
          completionTokens += relevanceUsage.completion_tokens || 0;
          totalCost += Number(relevanceUsage.cost || 0);
        } catch (relevanceErr) {
          console.warn(`[youtubePipeline] 관련성 판정 실패 (${groupName}): ${relevanceErr.message}`);
        }
      }

      const videos = relevantVideos
        .slice(0, MAX_GROUP_VIDEOS);

      let aiSummary = "";
      let aiSummaryEn = "";

      if (videos.length > 0) {
        try {
          const analysisResult = await analyzeYoutubeVideos({
            groupName,
            date,
            queries: queries.map((query) => String(query.query || "").trim()).filter(Boolean),
            videos,
            customPrompt: groupData.summaryPrompt || "",
            model: analysisModel,
          });
          aiSummary = analysisResult.summary || "";
          aiSummaryEn = analysisResult.summary_en || "";
          const usage = analysisResult.usage || {};
          promptTokens += usage.prompt_tokens || 0;
          completionTokens += usage.completion_tokens || 0;
          totalCost += Number(usage.cost || 0);
        } catch (aiErr) {
          console.warn(`[youtubePipeline] AI 분석 실패 (${groupName}): ${aiErr.message}`);
        }
      } else if (candidateVideoCount > 0) {
        aiSummary = buildEmptyYoutubeSummary();
        aiSummaryEn = buildEmptyYoutubeSummaryEn();
      }

      const reportData = {
        groupName,
        groupNameEn,
        date,
        queryCount: queries.length,
        queries: queries.map((query) => String(query.query || "").trim()).filter(Boolean),
        candidateVideoCount,
        relevantVideoCount,
        uncertainVideoCount,
        irrelevantVideoCount,
        filteredOutVideoCount,
        videoCount: videos.length,
        videos,
        aiSummary,
        aiSummary_en: aiSummaryEn,
        model: analysisModel,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cost: totalCost > 0 ? Number(totalCost.toFixed(6)) : null,
        crawlStatus: "ok",
        collectedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection("workspaces").doc(workspaceId)
        .collection("youtube_reports").doc(date)
        .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      await db.collection("workspaces").doc(workspaceId)
        .collection("youtube_reports").doc(date)
        .collection("groups").doc(groupDocId)
        .set(reportData);

      if (!skipEmail) {
        const emailConfig = groupData.deliveryConfig?.email;
        if (emailConfig?.isEnabled && (emailConfig.recipients || []).length > 0) {
          try {
            await sendYoutubeEmailReport({
              recipients: emailConfig.recipients,
              groupName,
              date,
              report: reportData,
            });
            logDelivery(db, workspaceId, {
              platform: "youtube",
              target: groupName,
              targetId: groupDocId,
              reportType: "daily",
              reportDate: date,
              recipientCount: emailConfig.recipients.length,
              triggerSource,
            });
          } catch (emailErr) {
            console.error(`[youtubePipeline] 이메일 발송 실패 (${groupName}): ${emailErr.message}`);
            logDeliveryFailure(db, workspaceId, {
              platform: "youtube",
              target: groupName,
              targetId: groupDocId,
              reportType: "daily",
              reportDate: date,
              recipientCount: emailConfig.recipients.length,
              triggerSource,
              errorMessage: emailErr.message,
            });
          }
        }
      }

      console.log(`[youtubePipeline] ${groupName}: 저장 완료 (videos: ${videos.length})`);
      results.processed += 1;
    } catch (err) {
      console.error(`[youtubePipeline] ${workspaceId}/${groupDocId} 오류: ${err.message}`);
      results.errors += 1;
    }
  }

  console.log(`[youtubePipeline] 완료 — processed: ${results.processed}, skipped: ${results.skipped}, errors: ${results.errors}`);
  return results;
}

module.exports = {
  runYoutubePipeline,
};
