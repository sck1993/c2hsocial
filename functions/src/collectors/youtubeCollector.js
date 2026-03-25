"use strict";

const axios = require("axios");

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

function getYoutubeApiKey(overrideApiKey = "") {
  const apiKey = String(overrideApiKey || process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("YouTube API 키가 설정되지 않았습니다.");
  }
  return apiKey;
}

async function callYoutubeApi(path, params = {}, apiKeyOverride = "") {
  const apiKey = getYoutubeApiKey(apiKeyOverride);
  const { data } = await axios.get(`${YOUTUBE_API_BASE}${path}`, {
    params: {
      ...params,
      key: apiKey,
    },
    timeout: 30000,
  });
  return data;
}

function pickBestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    "";
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseDurationToSeconds(duration = "") {
  const match = String(duration).match(
    /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function formatDurationLabel(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
      .join(":");
  }
  return [minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function normalizeSearchItem(item = {}) {
  const snippet = item.snippet || {};
  const videoId = item.id?.videoId || "";
  return {
    videoId,
    publishedAt: snippet.publishedAt || "",
    channelId: snippet.channelId || "",
    channelTitle: snippet.channelTitle || "",
    title: snippet.title || "",
    descriptionSnippet: snippet.description || "",
    thumbnailUrl: pickBestThumbnail(snippet.thumbnails || {}),
    liveBroadcastContent: snippet.liveBroadcastContent || "",
  };
}

function normalizeVideoItem(item = {}) {
  const snippet = item.snippet || {};
  const durationSeconds = parseDurationToSeconds(item.contentDetails?.duration || "");
  return {
    videoId: item.id || "",
    videoUrl: item.id ? `https://www.youtube.com/watch?v=${item.id}` : "",
    title: snippet.title || "",
    descriptionSnippet: snippet.description || "",
    channelId: snippet.channelId || "",
    channelTitle: snippet.channelTitle || "",
    publishedAt: snippet.publishedAt || "",
    thumbnailUrl: pickBestThumbnail(snippet.thumbnails || {}),
    duration: formatDurationLabel(durationSeconds),
    durationSeconds,
    viewCount: toIntOrNull(item.statistics?.viewCount),
    likeCount: toIntOrNull(item.statistics?.likeCount),
    commentCount: toIntOrNull(item.statistics?.commentCount),
  };
}

async function searchVideos({
  apiKey,
  query,
  publishedAfter,
  publishedBefore,
  maxResults = 25,
  pageToken,
}) {
  const data = await callYoutubeApi("/search", {
    part: "snippet",
    q: query,
    type: "video",
    order: "date",
    maxResults: Math.min(Math.max(Number(maxResults) || 25, 1), 50),
    publishedAfter,
    publishedBefore,
    pageToken,
    fields: "nextPageToken,items(id/videoId,snippet/publishedAt,snippet/channelId,snippet/channelTitle,snippet/title,snippet/description,snippet/thumbnails,snippet/liveBroadcastContent)",
  }, apiKey);

  return {
    nextPageToken: data.nextPageToken || null,
    items: Array.isArray(data.items) ? data.items.map(normalizeSearchItem).filter((item) => item.videoId) : [],
  };
}

async function fetchVideosByIds(videoIds = [], apiKey = "") {
  const ids = [...new Set((Array.isArray(videoIds) ? videoIds : []).filter(Boolean))];
  if (!ids.length) return [];

  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) {
    chunks.push(ids.slice(i, i + 50));
  }

  const results = [];
  for (const chunk of chunks) {
    const data = await callYoutubeApi("/videos", {
      part: "snippet,contentDetails,statistics",
      id: chunk.join(","),
      maxResults: chunk.length,
      fields: "items(id,snippet/publishedAt,snippet/channelId,snippet/channelTitle,snippet/title,snippet/description,snippet/thumbnails,contentDetails/duration,statistics/viewCount,statistics/likeCount,statistics/commentCount)",
    }, apiKey);
    const items = Array.isArray(data.items) ? data.items.map(normalizeVideoItem).filter((item) => item.videoId) : [];
    results.push(...items);
  }

  return results;
}

module.exports = {
  searchVideos,
  fetchVideosByIds,
  parseDurationToSeconds,
  formatDurationLabel,
};
