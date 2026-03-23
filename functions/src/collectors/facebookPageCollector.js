"use strict";

const axios = require("axios");

const FB_API = "https://graph.facebook.com/v22.0";
const API_TIMEOUT_MS = 20000;
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_PAGES = 20;

function normalizeAxiosError(err) {
  const apiMessage = err.response?.data?.error?.message;
  return new Error(apiMessage || err.message || "Facebook Graph API 호출 실패");
}

async function graphGet(pathOrUrl, params = null) {
  try {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const resp = await axios.get(pathOrUrl, { timeout: API_TIMEOUT_MS });
      return resp.data;
    }

    const cleanPath = String(pathOrUrl || "").replace(/^\//, "");
    const resp = await axios.get(`${FB_API}/${cleanPath}`, {
      params: params || undefined,
      timeout: API_TIMEOUT_MS,
    });
    return resp.data;
  } catch (err) {
    throw normalizeAxiosError(err);
  }
}

async function collectPagedData(path, params, maxPages = DEFAULT_MAX_PAGES) {
  const results = [];
  let nextUrl = null;
  let pageCount = 0;
  let truncated = false;
  let lastNextUrl = null;

  while (pageCount < maxPages) {
    const payload = nextUrl
      ? await graphGet(nextUrl)
      : await graphGet(path, params);

    results.push(...(payload?.data || []));
    nextUrl = payload?.paging?.next || null;
    lastNextUrl = nextUrl;
    pageCount += 1;

    if (!nextUrl) break;
  }

  if (lastNextUrl && pageCount >= maxPages) {
    truncated = true;
  }

  return {
    items: results,
    pageCount,
    truncated,
    hasMore: Boolean(lastNextUrl),
    nextUrl: lastNextUrl,
  };
}

function normalizeAttachment(raw = {}) {
  return {
    mediaType: raw.media_type || "",
    url: raw.url || raw.media?.image?.src || raw.media?.source || "",
    title: raw.title || "",
    description: raw.description || "",
  };
}

function normalizePagePost(raw = {}) {
  return {
    postId: raw.id || "",
    postUrl: raw.permalink_url || "",
    message: raw.message || "",
    createdTime: raw.created_time || "",
    statusType: raw.status_type || "",
    reactions: raw.reactions?.summary?.total_count || 0,
    topLevelCommentCount: raw.comments?.summary?.total_count || 0,
    attachments: Array.isArray(raw.attachments?.data)
      ? raw.attachments.data.map(normalizeAttachment).filter((v) => v.url || v.title || v.description)
      : [],
  };
}

function normalizeComment(raw = {}) {
  return {
    commentId: raw.id || "",
    authorId: raw.from?.id || "",
    author: raw.from?.name || "",
    text: raw.message || "",
    createdTime: raw.created_time || "",
    likeCount: raw.like_count || 0,
    replyCount: raw.comment_count || 0,
    replies: [],
  };
}

async function discoverManagedFacebookPages(accessToken) {
  if (!accessToken) throw new Error("accessToken 필수");

  const { items: pages } = await collectPagedData(
    "me/accounts",
    {
      fields: "id,name,access_token,category,picture{url}",
      limit: DEFAULT_LIMIT,
      access_token: accessToken,
    },
    10
  );

  return pages
    .filter((page) => page?.id && page?.access_token)
    .map((page) => ({
      pageId: page.id,
      pageName: page.name || page.id,
      pageAccessToken: page.access_token,
      pageCategory: page.category || "",
      pictureUrl: page.picture?.data?.url || "",
    }));
}

async function discoverChildPages(parentPageId, parentPageAccessToken) {
  if (!parentPageId) throw new Error("parentPageId 필수");
  if (!parentPageAccessToken) throw new Error("parentPageAccessToken 필수");

  const { items: children } = await collectPagedData(
    `${parentPageId}/global_brand_children`,
    {
      fields: "id,name,category,picture{url}",
      limit: DEFAULT_LIMIT,
      access_token: parentPageAccessToken,
    },
    10
  );

  if (!children || children.length === 0) return [];

  const results = await Promise.allSettled(
    children.map(async (child) => {
      const base = {
        pageId: child.id,
        pageName: child.name || child.id,
        pageCategory: child.category || "",
        pictureUrl: child.picture?.data?.url || "",
        pageAccessToken: null,
        tokenSource: "unavailable",
        tokenNote: null,
      };

      try {
        const tokenData = await graphGet(`${child.id}`, {
          fields: "access_token",
          access_token: parentPageAccessToken,
        });
        if (tokenData?.access_token) {
          base.pageAccessToken = tokenData.access_token;
          base.tokenSource = "parent_token";
        }
      } catch (err) {
        base.tokenNote = err.message;
      }

      return base;
    })
  );

  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

async function lookupChildPagesByIds(pageIds, accessToken) {
  if (!Array.isArray(pageIds) || pageIds.length === 0) return [];
  if (!accessToken) throw new Error("accessToken 필수");

  const results = await Promise.allSettled(
    pageIds.map(async (pageId) => {
      const id = String(pageId).trim();
      if (!id) throw new Error("빈 pageId");

      const info = await graphGet(id, {
        fields: "id,name,category,picture{url}",
        access_token: accessToken,
      });

      const base = {
        pageId: info.id || id,
        pageName: info.name || id,
        pageCategory: info.category || "",
        pictureUrl: info.picture?.data?.url || "",
        pageAccessToken: null,
        tokenSource: "unavailable",
        tokenNote: null,
      };

      try {
        const tokenData = await graphGet(id, {
          fields: "access_token",
          access_token: accessToken,
        });
        if (tokenData?.access_token) {
          base.pageAccessToken = tokenData.access_token;
          base.tokenSource = "parent_token";
        }
      } catch (err) {
        base.tokenNote = err.message;
      }

      return base;
    })
  );

  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

async function fetchPagePosts(pageId, pageAccessToken, { since, until } = {}) {
  if (!pageId) throw new Error("pageId 필수");
  if (!pageAccessToken) throw new Error("pageAccessToken 필수");

  const { items: rawPosts, truncated, pageCount } = await collectPagedData(
    `${pageId}/posts`,
    {
      fields: [
        "id",
        "message",
        "created_time",
        "permalink_url",
        "status_type",
        "attachments{media_type,media,url,title,description}",
        "reactions.summary(true).limit(0)",
        "comments.summary(true).limit(0)",
      ].join(","),
      limit: DEFAULT_LIMIT,
      since,
      until,
      access_token: pageAccessToken,
    },
    20
  );

  return {
    posts: rawPosts.map(normalizePagePost).filter((post) => post.postId),
    truncated,
    pageCount,
  };
}

async function fetchCommentReplies(commentId, pageAccessToken, maxPages = 10) {
  if (!commentId) return [];

  const { items: rawReplies, truncated, pageCount } = await collectPagedData(
    `${commentId}/comments`,
    {
      fields: "id,message,created_time,from{id,name},like_count,comment_count",
      limit: DEFAULT_LIMIT,
      order: "chronological",
      access_token: pageAccessToken,
    },
    maxPages
  );

  return {
    replies: rawReplies.map(normalizeComment),
    truncated,
    pageCount,
  };
}

async function fetchPostComments(postId, pageAccessToken, options = {}) {
  const {
    includeReplies = true,
    maxCommentPages = 20,
    maxReplyPages = 10,
  } = options;

  if (!postId) throw new Error("postId 필수");
  if (!pageAccessToken) throw new Error("pageAccessToken 필수");

  const { items: rawComments, truncated: commentsTruncated } = await collectPagedData(
    `${postId}/comments`,
    {
      fields: "id,message,created_time,from{id,name},like_count,comment_count",
      limit: DEFAULT_LIMIT,
      order: "chronological",
      access_token: pageAccessToken,
    },
    maxCommentPages
  );

  const comments = [];
  let replyCount = 0;
  let replyErrorCount = 0;
  let truncatedReplies = false;

  for (const rawComment of rawComments) {
    const comment = normalizeComment(rawComment);

    if (includeReplies && comment.replyCount > 0) {
      try {
        const replyResult = await fetchCommentReplies(comment.commentId, pageAccessToken, maxReplyPages);
        comment.replies = replyResult.replies;
        if (replyResult.truncated) truncatedReplies = true;
        replyCount += comment.replies.length;
      } catch (err) {
        replyErrorCount += 1;
        comment.replyFetchError = err.message;
      }
    }

    comments.push(comment);
  }

  const coverage = !includeReplies
    ? "top_level_only"
    : (replyErrorCount > 0 || commentsTruncated || truncatedReplies ? "partial" : "full");

  return {
    comments,
    topLevelCommentCount: comments.length,
    replyCount,
    totalComments: comments.length + replyCount,
    coverage,
    replyErrorCount,
    truncatedComments: commentsTruncated,
    truncatedReplies,
  };
}

async function validatePageAccessToken(pageId, pageAccessToken) {
  if (!pageId) throw new Error("pageId 필수");
  if (!pageAccessToken) throw new Error("pageAccessToken 필수");

  const data = await graphGet(`${pageId}`, {
    fields: "id,name,category,picture{url}",
    access_token: pageAccessToken,
  });

  return {
    pageId: data?.id || pageId,
    pageName: data?.name || "",
    pageCategory: data?.category || "",
    pictureUrl: data?.picture?.data?.url || "",
  };
}

module.exports = {
  discoverManagedFacebookPages,
  discoverChildPages,
  lookupChildPagesByIds,
  fetchPagePosts,
  fetchPostComments,
  validatePageAccessToken,
};
