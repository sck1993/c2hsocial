"use strict";

/**
 * naverLoungeCollector.js
 * HTTP 요청 기반 네이버 라운지 수집기
 *
 * 주요 함수:
 *   loadSessionFromFirestore(db, wsId)        — Firestore에서 요청 세션 로드
 *   saveSessionToFirestore(db, wsId, data)    — Firestore에 요청 세션 저장
 *   markSessionInvalid(db, wsId)              — 세션 만료 마킹
 *   collectLoungePosts(opts)                  — feed API로 해당일 게시글 목록 수집
 *   collectPostComments(opts)                 — 댓글 API로 게시글 댓글 수집
 */

const axios = require("axios");
const admin = require("firebase-admin");

const FEED_PAGE_LIMIT = 25;
const FEED_FETCH_MAX_PAGES = 12;
const COMMENT_PAGE_LIMIT = 30;
const COMMENT_FETCH_MAX_PAGES = 20;
const POST_MAX = 50;

function parseCookieHeaderToCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return [];

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return null;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name || !value) return null;
      return {
        name,
        value,
        domain: ".naver.com",
        path: "/",
        secure: true,
        httpOnly: false,
      };
    })
    .filter(Boolean);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, num) => {
      try {
        return String.fromCodePoint(parseInt(num, 10));
      } catch {
        return _;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function compactWhitespace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function walkSmartEditor(node, texts) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) walkSmartEditor(item, texts);
    return;
  }

  if (typeof node !== "object") return;

  if (node["@ctype"] === "textNode" && typeof node.value === "string") {
    const value = compactWhitespace(decodeHtmlEntities(node.value));
    if (value) texts.push(value);
  }

  for (const value of Object.values(node)) {
    walkSmartEditor(value, texts);
  }
}

function extractTextFromContents(contents) {
  if (!contents) return "";

  let parsed;
  try {
    parsed = typeof contents === "string" ? JSON.parse(contents) : contents;
  } catch {
    return compactWhitespace(decodeHtmlEntities(contents));
  }

  const texts = [];
  walkSmartEditor(parsed, texts);
  return compactWhitespace(texts.join("\n")).slice(0, 3000);
}

function extractLoungeId(loungeUrl = "", fallback = "") {
  const match = String(loungeUrl).match(/\/lounge\/([^/?#]+)/);
  return match ? match[1] : fallback;
}

function extractBoardId(loungeUrl = "", fallback = 0) {
  try {
    const parsed = new URL(String(loungeUrl));
    const raw = parsed.searchParams.get("boardId");
    if (raw != null && raw !== "") return Number(raw);
  } catch (_) { /* ignore invalid lounge URL */ }
  return Number(fallback || 0);
}

function normalizeReferer(referer = "", loungeId = "") {
  return String(referer || "").trim() || `https://game.naver.com/lounge/${loungeId}/board`;
}

function getDateParts(createdDate) {
  const value = String(createdDate || "");
  if (!/^\d{8,14}$/.test(value)) {
    return { dateKey: "", isoDateTime: "" };
  }

  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(8, 10) || "00";
  const minute = value.slice(10, 12) || "00";
  const second = value.slice(12, 14) || "00";

  return {
    dateKey: `${year}-${month}-${day}`,
    isoDateTime: `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`,
  };
}

function createAuthError(message, statusCode = 403) {
  const error = new Error(message);
  error.code = "NAVER_AUTH";
  error.statusCode = statusCode;
  return error;
}

function isAuthError(error) {
  return error?.code === "NAVER_AUTH" || [401, 403].includes(error?.statusCode);
}

function buildRequestHeaders(session, referer) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Cookie: session.cookieHeader,
    deviceid: session.deviceId,
    "front-client-platform-type": "PC",
    "front-client-product-type": "web",
    Origin: "https://game.naver.com",
    Pragma: "no-cache",
    Referer: referer,
    "User-Agent": session.userAgent,
  };
}

async function fetchFeedPage({ session, loungeId, boardId = 0, offset = 0, referer }) {
  const url = `https://comm-api.game.naver.com/nng_main/v1/community/lounge/${encodeURIComponent(loungeId)}/feed`;
  const response = await axios.get(url, {
    params: {
      boardId,
      buffFilteringYN: "N",
      limit: FEED_PAGE_LIMIT,
      offset,
      order: "NEW",
    },
    headers: buildRequestHeaders(session, referer),
    timeout: 30000,
    validateStatus: () => true,
  });

  if ([401, 403].includes(response.status)) {
    throw createAuthError(`[naverLoungeCollector] 인증 실패 (${response.status})`, response.status);
  }

  if (response.status >= 400) {
    const detail = typeof response.data === "object"
      ? JSON.stringify(response.data).slice(0, 500)
      : "";
    throw new Error(`[naverLoungeCollector] feed 요청 실패 (${response.status}) ${detail}`.trim());
  }

  const data = response.data || {};
  if (data.code !== 200 || !data.content) {
    if ([401, 403].includes(Number(data.code))) {
      throw createAuthError(
        `[naverLoungeCollector] 세션 만료 또는 권한 없음 (code=${data.code})`,
        Number(data.code)
      );
    }
    throw new Error(
      `[naverLoungeCollector] feed 응답 비정상 (code=${data.code}, message=${data.message || "unknown"})`
    );
  }

  return data.content;
}

async function fetchCommentPage({ session, loungeId, feedId, offset = 0, referer }) {
  const url = `https://apis.naver.com/nng_main/nng_comment_api/v1/type/FEED/id/${encodeURIComponent(feedId)}/comments`;
  const response = await axios.get(url, {
    params: {
      originalLoungeId: loungeId,
      limit: COMMENT_PAGE_LIMIT,
      offset,
      orderType: "ASC",
      pagingType: "PAGE",
    },
    headers: buildRequestHeaders(session, referer),
    timeout: 30000,
    validateStatus: () => true,
  });

  if ([401, 403].includes(response.status)) {
    throw createAuthError(`[naverLoungeCollector] 댓글 인증 실패 (${response.status})`, response.status);
  }

  if (response.status >= 400) {
    const detail = typeof response.data === "object"
      ? JSON.stringify(response.data).slice(0, 500)
      : "";
    throw new Error(`[naverLoungeCollector] 댓글 요청 실패 (${response.status}) ${detail}`.trim());
  }

  const data = response.data || {};
  if (data.code !== 200 || !data.content?.comments) {
    if ([401, 403].includes(Number(data.code))) {
      throw createAuthError(
        `[naverLoungeCollector] 댓글 세션 만료 또는 권한 없음 (code=${data.code})`,
        Number(data.code)
      );
    }
    throw new Error(
      `[naverLoungeCollector] 댓글 응답 비정상 (code=${data.code}, message=${data.message || "unknown"})`
    );
  }

  return data.content.comments;
}

function mapFeedToPost(item, targetDate) {
  const feed = item?.feed || {};
  const user = item?.user || {};
  const comment = item?.comment || {};
  const board = item?.board || {};
  const buff = item?.buff || {};
  const { dateKey, isoDateTime } = getDateParts(feed.createdDate);

  if (!dateKey) return { post: null, dateKey: "" };

  const post = {
    feedId: feed.feedId || item?.feedId || null,
    postUrl:
      item?.feedLink?.pc ||
      `https://game.naver.com/lounge/${feed.loungeId || ""}/board/detail/${feed.feedId || ""}`,
    title: compactWhitespace(decodeHtmlEntities(feed.title || "")),
    authorName: compactWhitespace(decodeHtmlEntities(user.nickname || "")),
    text: extractTextFromContents(feed.contents) ||
      compactWhitespace(decodeHtmlEntities(feed.title || "")),
    publishedAt: dateKey,
    publishedAtDateTime: isoDateTime,
    commentCount: Number(comment.totalCount ?? comment.commentCount ?? 0),
    comments: [],
    reactions: Number(buff.buffCount ?? feed.buff ?? 0),
    readCount: Number(item?.readCount || 0),
    boardId: board.boardId ?? null,
    boardName: board.boardName || "",
    isPinned: Boolean(feed.pinned),
    images: [],
  };

  if (dateKey !== targetDate) {
    return { post: null, dateKey };
  }

  return { post, dateKey };
}

async function loadSessionFromFirestore(db, workspaceId) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("naver_session")
    .doc("main");
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data();
}

async function saveSessionToFirestore(
  db,
  workspaceId,
  { cookieHeader = "", deviceId = "", userAgent = "", referer = "", cookies = null }
) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("naver_session")
    .doc("main");

  const normalizedCookieHeader = String(cookieHeader || "").trim();
  const normalizedDeviceId = String(deviceId || "").trim();
  const normalizedUserAgent = String(userAgent || "").trim();
  const normalizedReferer = String(referer || "").trim();
  const normalizedCookies = Array.isArray(cookies)
    ? cookies
    : parseCookieHeaderToCookies(normalizedCookieHeader);

  await ref.set(
    {
      cookieHeader: normalizedCookieHeader,
      deviceId: normalizedDeviceId,
      userAgent: normalizedUserAgent,
      referer: normalizedReferer,
      cookies: normalizedCookies,
      isValid: true,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastValidatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function markSessionInvalid(db, workspaceId) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("naver_session")
    .doc("main");
  await ref.set({ isValid: false }, { merge: true });
}

async function collectLoungePosts({
  session,
  loungeId,
  loungeUrl = "",
  targetDate,
  boardId = 0,
}) {
  if (!session?.cookieHeader || !session?.deviceId || !session?.userAgent) {
    throw createAuthError("[naverLoungeCollector] 요청 세션 정보가 부족합니다.", 401);
  }

  const resolvedLoungeId = extractLoungeId(loungeUrl, loungeId);
  if (!resolvedLoungeId) {
    throw new Error("[naverLoungeCollector] loungeId를 확인할 수 없습니다.");
  }

  const resolvedBoardId = extractBoardId(loungeUrl, boardId);
  const referer = normalizeReferer(session.referer, resolvedLoungeId);

  console.log(
    `[naverLoungeCollector] feed 수집 시작: loungeId=${resolvedLoungeId}, boardId=${resolvedBoardId}, targetDate=${targetDate}`
  );

  const seenFeedIds = new Set();
  const posts = [];

  for (let pageIndex = 0; pageIndex < FEED_FETCH_MAX_PAGES; pageIndex++) {
    const offset = pageIndex * FEED_PAGE_LIMIT;
    const content = await fetchFeedPage({
      session,
      loungeId: resolvedLoungeId,
      boardId: resolvedBoardId,
      offset,
      referer,
    });

    const feeds = Array.isArray(content.feeds) ? content.feeds : [];
    if (feeds.length === 0) break;

    let sawUnpinnedOlderThanTarget = false;

    for (const item of feeds) {
      const feed = item?.feed || {};
      const { post, dateKey } = mapFeedToPost(item, targetDate);

      if (dateKey && dateKey < targetDate && !feed.pinned) {
        sawUnpinnedOlderThanTarget = true;
      }

      if (!post) continue;
      if (seenFeedIds.has(post.feedId)) continue;

      seenFeedIds.add(post.feedId);
      posts.push(post);
      if (posts.length >= POST_MAX) break;
    }

    if (posts.length >= POST_MAX || sawUnpinnedOlderThanTarget) break;
  }

  if (posts.length === 0) {
    console.log(`[naverLoungeCollector] ${targetDate} 게시글 없음 — skip`);
    return { posts: [], skipped: true };
  }

  console.log(`[naverLoungeCollector] 게시글 ${posts.length}개 수집 완료`);
  return { posts, skipped: false };
}

async function collectPostComments({
  session,
  loungeId,
  feedId,
  postUrl = "",
}) {
  if (!feedId) {
    return { comments: [], totalCount: 0 };
  }

  const referer = String(postUrl || "").trim() || normalizeReferer(session.referer, loungeId);
  const comments = [];

  for (let pageIndex = 0; pageIndex < COMMENT_FETCH_MAX_PAGES; pageIndex++) {
    const offset = pageIndex * COMMENT_PAGE_LIMIT;
    const page = await fetchCommentPage({
      session,
      loungeId,
      feedId,
      offset,
      referer,
    });

    const rows = Array.isArray(page.data) ? page.data : [];
    for (const row of rows) {
      const comment = row?.comment || {};
      const user = row?.user || {};
      if (comment.deleted || comment.hideByCleanBot) continue;

      const text = compactWhitespace(decodeHtmlEntities(comment.content || ""));
      if (!text) continue;

      comments.push({
        author: compactWhitespace(decodeHtmlEntities(user.userNickname || "")),
        text,
      });
    }

    const totalCount = Number(page.totalCount ?? page.commentCount ?? comments.length);
    if (rows.length < COMMENT_PAGE_LIMIT || comments.length >= totalCount) {
      return { comments, totalCount };
    }
  }

  return { comments, totalCount: comments.length };
}

module.exports = {
  collectLoungePosts,
  collectPostComments,
  extractTextFromContents,
  isAuthError,
  loadSessionFromFirestore,
  markSessionInvalid,
  parseCookieHeaderToCookies,
  saveSessionToFirestore,
};
