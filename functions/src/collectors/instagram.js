"use strict";

const axios = require("axios");

// Facebook Login for Business 기반 Instagram API (graph.facebook.com)
// 토큰 형식: EAAxxxxxxx (Facebook User Access Token)
const IG_API = "https://graph.facebook.com/v22.0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 액세스 토큰으로 연결 가능한 Instagram 비즈니스 계정 목록 조회
 * Facebook Login for Business 방식: /me/accounts 에서 연결된 IG 비즈니스 계정 탐색
 * @param {string} accessToken - EAAxxxx 형식의 Facebook User Access Token
 * @returns {Promise<Array<{igUserId: string, username: string, pageId: string, pageName: string}>>}
 */
async function listConnectedInstagramAccounts(accessToken) {
  const resp = await axios.get(`${IG_API}/me/accounts`, {
    params: {
      fields: "instagram_business_account{id,username}",
      access_token: accessToken,
    },
    timeout: 15000,
  });

  const pages = resp.data?.data || [];
  const accounts = [];
  for (const page of pages) {
    const igAcc = page.instagram_business_account;
    if (igAcc?.id) {
      accounts.push({
        igUserId: igAcc.id,
        username: igAcc.username || "",
        pageId: page.id || "",
        pageName: page.name || "",
      });
    }
  }
  return accounts;
}

/**
 * Long-lived 토큰 갱신 (60일 만료 전 주기적 갱신)
 * Facebook Login: fb_exchange_token 방식 (계정별 appId / appSecret 사용)
 * @param {string} accessToken
 * @param {string} appId - Meta 앱 ID (Firestore 계정 문서에서 조회)
 * @param {string} appSecret - Meta 앱 시크릿 (Firestore 계정 문서에서 조회)
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
async function refreshToken(accessToken, appId, appSecret) {
  if (!appId || !appSecret) {
    throw new Error("앱 ID / 앱 시크릿 미설정 — 계정 설정을 확인하세요");
  }

  const resp = await axios.get(`${IG_API}/oauth/access_token`, {
    params: {
      grant_type:      "fb_exchange_token",
      client_id:       appId,
      client_secret:   appSecret,
      fb_exchange_token: accessToken,
    },
    timeout: 15000,
  });
  const { access_token, expires_in } = resp.data;
  if (!access_token) throw new Error("토큰 갱신 실패: 응답에 access_token 없음");
  return { accessToken: access_token, expiresIn: expires_in };
}

/**
 * 계정 지표 수집: 팔로워 수 + 프로필 방문수 + 해당일 account-level 지표
 * @param {string} igUserId
 * @param {string} accessToken
 * @returns {Promise<{followerCount: number|null, profileViews: number|null, dailyReach: number|null, dailyViews: number|null}>}
 */
async function fetchAccountMetrics(igUserId, accessToken, date) {
  // date(YYYY-MM-DD) → since/until Unix timestamp (seconds)
  // UTC 자정 기준: since=UTC 00:00, until=UTC 23:59:59
  // → KST 기준 데이터 확보 시각: 다음날 KST 09:00 이후
  const sinceTs = Math.floor(new Date(date).getTime() / 1000);
  const untilTs = sinceTs + 86400 - 1;

  // ① 팔로워 수 (절대값 스냅샷)
  let followerCount = null;
  try {
    const profileResp = await axios.get(`${IG_API}/${igUserId}`, {
      params: { fields: "followers_count", access_token: accessToken },
      timeout: 15000,
    });
    followerCount = profileResp.data.followers_count ?? null;
  } catch (err) {
    console.warn(`[instagram] followers_count 수집 실패 (igUserId=${igUserId}): ${err.message}`);
  }

  // ② 프로필 방문 (metric_type=total_value 신형 방식)
  let profileViews = null;
  try {
    const insightsResp = await axios.get(`${IG_API}/${igUserId}/insights`, {
      params: {
        metric: "profile_views",
        period: "day",
        metric_type: "total_value",
        since: sinceTs,
        until: untilTs,
        access_token: accessToken,
      },
      timeout: 15000,
    });
    const item = insightsResp.data?.data?.[0];
    profileViews = item?.total_value?.value ?? null;
  } catch (err) {
    console.warn(`[instagram] profile_views 수집 실패 (igUserId=${igUserId}): ${err.message}`);
  }

  // ③ account-level 일별 도달 — MEDIA(POST+REELS 등) / STORY 분리, AD 제외
  // dailyReach = mediaReach + storyReach (account_total)
  let dailyReach = null;
  let mediaReach = null;
  let storyReach = null;
  try {
    const insightsResp = await axios.get(`${IG_API}/${igUserId}/insights`, {
      params: {
        metric: "reach",
        period: "day",
        breakdown: "media_product_type",
        metric_type: "total_value",
        since: sinceTs,
        until: untilTs,
        access_token: accessToken,
      },
      timeout: 15000,
    });
    const item = insightsResp.data?.data?.[0];
    const results = item?.total_value?.breakdowns?.[0]?.results;
    if (Array.isArray(results)) {
      const organic = results.filter(r => r.dimension_values?.[0] !== "AD");
      storyReach = organic
        .filter(r => r.dimension_values?.[0] === "STORY")
        .reduce((sum, r) => sum + (r.value ?? 0), 0) || null;
      mediaReach = organic
        .filter(r => r.dimension_values?.[0] !== "STORY")
        .reduce((sum, r) => sum + (r.value ?? 0), 0) || null;
      dailyReach = ((mediaReach ?? 0) + (storyReach ?? 0)) || null;
    }
  } catch (err) {
    console.warn(`[instagram] account insights(reach) 수집 실패 (igUserId=${igUserId}): ${err.message}`);
  }

  // ④ views — AD 제외 일반 콘텐츠 조회만 집계 (reach와 동일 방식)
  let dailyViews = null;
  try {
    const viewsResp = await axios.get(`${IG_API}/${igUserId}/insights`, {
      params: {
        metric: "views",
        period: "day",
        breakdown: "media_product_type",
        metric_type: "total_value",
        since: sinceTs,
        until: untilTs,
        access_token: accessToken,
      },
      timeout: 15000,
    });
    const item = viewsResp.data?.data?.[0];
    const results = item?.total_value?.breakdowns?.[0]?.results;
    if (Array.isArray(results)) {
      dailyViews = results
        .filter(r => r.dimension_values?.[0] !== "AD")
        .reduce((sum, r) => sum + (r.value ?? 0), 0) || null;
    }
  } catch (err) {
    console.warn(`[instagram] account insights(views) 수집 실패 (igUserId=${igUserId}): ${err.message}`);
  }

  // ⑤ account-level 일별 shares / saves — metric_type=total_value 신형 방식 (reach와 동일)
  let dailyShares = null;
  let dailySaves  = null;
  try {
    const ssResp = await axios.get(`${IG_API}/${igUserId}/insights`, {
      params: {
        metric: "shares,saves",
        period: "day",
        metric_type: "total_value",
        since: sinceTs,
        until: untilTs,
        access_token: accessToken,
      },
      timeout: 15000,
    });
    for (const item of (ssResp.data?.data || [])) {
      const val = item?.total_value?.value ?? null;
      if (item.name === "shares") dailyShares = val;
      if (item.name === "saves")  dailySaves  = val;
    }
  } catch (err) {
    console.warn(`[instagram] account insights(shares,saves) 수집 실패 (igUserId=${igUserId}): ${err.message}`);
  }

  return { followerCount, profileViews, dailyReach, mediaReach, storyReach, dailyViews, dailyShares, dailySaves };
}

/**
 * 최근 14일 이내 포스트 목록 조회
 * @param {string} igUserId
 * @param {string} accessToken
 * @param {Date} since - 14일 전 Date 객체
 * @returns {Promise<Array>}
 */
async function fetchRecentPosts(igUserId, accessToken, since) {
  const resp = await axios.get(`${IG_API}/${igUserId}/media`, {
    params: {
      fields: "id,timestamp,media_type,permalink,caption",
      limit: 50,
      access_token: accessToken,
    },
    timeout: 15000,
  });

  const allMedia = resp.data?.data || [];
  // limit:50이 최대값 — 14일 내 포스트가 50개를 초과하면 누락될 수 있음 (고빈도 계정 주의)
  if (allMedia.length === 50) {
    console.warn(`[instagram] fetchRecentPosts: 포스트 50개 상한 도달 (igUserId=${igUserId}) — 일부 누락 가능`);
  }
  const sinceMs  = since instanceof Date ? since.getTime() : new Date(since).getTime();

  // 14일 이내 포스트만 필터
  return allMedia.filter((m) => {
    const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
    return ts >= sinceMs;
  });
}

/**
 * 개별 포스트 인사이트 수집
 * 안정 메트릭만 API 요청, "In development" 메트릭(views, total_interactions)은 계산으로 대체
 *
 * 미디어 타입별 안정 메트릭:
 *   FEED (IMAGE, CAROUSEL):  reach, likes, comments, shares, saved, profile_visits
 *   REELS (VIDEO):           reach, likes, comments, shares, saved, ig_reels_avg_watch_time
 *   STORY:                   reach, shares
 *
 * @param {string} mediaId
 * @param {string} accessToken
 * @param {object} mediaObj - 미디어 원본 객체 (media_type 참조용)
 * @returns {Promise<object>}
 */
async function fetchPostInsights(mediaId, accessToken, mediaObj = {}) {
  const mediaType = (mediaObj.media_type || "").toUpperCase();
  const isVideoLike = mediaType === "VIDEO" || mediaType === "REELS";

  // 미디어 타입별 요청 메트릭 구성
  // views: FEED + REELS + STORY 지원 ("under development"이나 현재 사용 가능)
  // follows: FEED(IMAGE, CAROUSEL_ALBUM) 전용 — VIDEO/STORY는 API 400 오류 확인됨
  let metrics;
  if (mediaType === "STORY") {
    metrics = "reach,shares,views";
  } else if (isVideoLike) {
    metrics = "reach,likes,comments,shares,saved,ig_reels_avg_watch_time,views";
  } else {
    // IMAGE, CAROUSEL_ALBUM (FEED)
    metrics = "reach,likes,comments,shares,saved,profile_visits,views,follows";
  }

  let rawInsights = {};
  try {
    const resp = await axios.get(`${IG_API}/${mediaId}/insights`, {
      params: {
        metric: metrics,
        access_token: accessToken,
      },
      timeout: 15000,
    });
    for (const item of (resp.data?.data || [])) {
      rawInsights[item.name] = item.values?.[0]?.value ?? item.value ?? null;
    }
  } catch (err) {
    // 429 Rate Limit은 재시도 없이 상위로 전파 (파이프라인이 처리)
    if (err.response?.status === 429) throw err;
    const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : "";
    console.warn(`[instagram] 인사이트 오류 (${mediaId}, type=${mediaType}): ${err.response?.status || "?"} ${err.message}${detail ? " — " + detail : ""}`);
  }

  const reach    = rawInsights.reach    ?? null;
  const likes    = rawInsights.likes    ?? null;
  const comments = rawInsights.comments ?? null;
  const shares   = rawInsights.shares   ?? null;
  const saves    = rawInsights.saved    ?? null;

  // views: 실제 API 값 사용, 미반환 시 reach로 fallback
  const views = rawInsights.views ?? reach;

  // total_interactions = likes + comments + shares + saves (계산)
  let totalInteractions = null;
  if (likes !== null || comments !== null || shares !== null || saves !== null) {
    totalInteractions = (likes ?? 0) + (comments ?? 0) + (shares ?? 0) + (saves ?? 0);
  }

  // profile_visits (FEED 전용)
  const profileVisits = rawInsights.profile_visits ?? null;

  // ig_reels_avg_watch_time (VIDEO/REELS 전용, ms 단위)
  const reelAvgWatchTime = rawInsights.ig_reels_avg_watch_time ?? null;

  // follows (FEED 전용 — VIDEO/STORY는 API 400 확인, null 고정)
  const follows = (!isVideoLike && mediaType !== "STORY")
    ? (rawInsights.follows ?? null)
    : null;

  // 참여율 = (likes + comments + shares + saves) / reach * 100
  const engagementRate = (reach && reach > 0)
    ? +((((likes ?? 0) + (comments ?? 0) + (shares ?? 0) + (saves ?? 0)) / reach) * 100).toFixed(2)
    : 0;

  return {
    views,
    reach,
    likes,
    comments,
    shares,
    saves,
    follows,
    profileVisits,
    totalInteractions,
    engagementRate,
    reelAvgWatchTime,
  };
}

/**
 * debug_token API로 실제 토큰 만료 시각 조회
 * @param {string} inputToken - 검사할 액세스 토큰
 * @param {string} appId
 * @param {string} appSecret
 * @returns {Promise<{isValid: boolean, expiresAt: Date|null, dataAccessExpiresAt: Date|null, scopes: string[]}>}
 */
async function debugToken(inputToken, appId, appSecret) {
  const resp = await axios.get(`${IG_API}/debug_token`, {
    params: {
      input_token: inputToken,
      access_token: `${appId}|${appSecret}`,
    },
    timeout: 15000,
  });
  const d = resp.data?.data;
  if (!d) throw new Error("debug_token 응답에 data 없음");
  return {
    isValid: d.is_valid ?? false,
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
    dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000) : null,
    scopes: d.scopes || [],
  };
}

module.exports = {
  listConnectedInstagramAccounts,
  refreshToken,
  debugToken,
  fetchAccountMetrics,
  fetchRecentPosts,
  fetchPostInsights,
  sleep,
};
