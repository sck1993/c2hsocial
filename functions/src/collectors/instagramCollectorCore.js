"use strict";

const axios = require("axios");

// 페이지네이션 간 딜레이 (ms)
const SLEEP_PAGE = 300;
// 인사이트 수집 간 딜레이 (ms)
const SLEEP_INSIGHT = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCommentText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Instagram/Facebook Graph API collector factory
 * @param {string} baseUrl - API base URL (e.g. "https://graph.facebook.com/v22.0")
 * @param {string} logPrefix - 로그 접두어 (e.g. "instagram", "instagram_direct")
 * @returns {object} fetch* 함수 모음
 */
function createCollector(baseUrl, logPrefix) {
  /**
   * 계정 지표 수집: 팔로워 수 + 프로필 방문수 + 해당일 account-level 지표
   * @param {string} igUserId
   * @param {string} accessToken
   * @param {string} date - YYYY-MM-DD
   * @returns {Promise<{followerCount, profileViews, dailyReach, mediaReach, storyReach, dailyViews, dailyShares, dailySaves}>}
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
      const profileResp = await axios.get(`${baseUrl}/${igUserId}`, {
        params: { fields: "followers_count", access_token: accessToken },
        timeout: 15000,
      });
      followerCount = profileResp.data.followers_count ?? null;
    } catch (err) {
      console.warn(`[${logPrefix}] followers_count 수집 실패 (igUserId=${igUserId}): ${err.message}`);
    }

    // ② 프로필 방문 (metric_type=total_value 신형 방식)
    let profileViews = null;
    try {
      const insightsResp = await axios.get(`${baseUrl}/${igUserId}/insights`, {
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
      console.warn(`[${logPrefix}] profile_views 수집 실패 (igUserId=${igUserId}): ${err.message}`);
    }

    // ③ account-level 일별 도달 — MEDIA(POST+REELS 등) / STORY 분리, AD 제외
    // dailyReach = mediaReach + storyReach (account_total)
    let dailyReach = null;
    let mediaReach = null;
    let storyReach = null;
    try {
      const insightsResp = await axios.get(`${baseUrl}/${igUserId}/insights`, {
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
      console.warn(`[${logPrefix}] account insights(reach) 수집 실패 (igUserId=${igUserId}): ${err.message}`);
    }

    // ④ views — AD 제외 일반 콘텐츠 조회만 집계 (reach와 동일 방식)
    let dailyViews = null;
    try {
      const viewsResp = await axios.get(`${baseUrl}/${igUserId}/insights`, {
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
      console.warn(`[${logPrefix}] account insights(views) 수집 실패 (igUserId=${igUserId}): ${err.message}`);
    }

    // ⑤ account-level 일별 shares / saves — metric_type=total_value 신형 방식 (reach와 동일)
    let dailyShares = null;
    let dailySaves  = null;
    try {
      const ssResp = await axios.get(`${baseUrl}/${igUserId}/insights`, {
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
      console.warn(`[${logPrefix}] account insights(shares,saves) 수집 실패 (igUserId=${igUserId}): ${err.message}`);
    }

    return { followerCount, profileViews, dailyReach, mediaReach, storyReach, dailyViews, dailyShares, dailySaves };
  }

  /**
   * 지정 기간 이내 포스트 목록 조회
   * @param {string} igUserId
   * @param {string} accessToken
   * @param {Date} since - 조회 시작 시점 Date 객체
   * @returns {Promise<Array>}
   */
  async function fetchRecentPosts(igUserId, accessToken, since) {
    const resp = await axios.get(`${baseUrl}/${igUserId}/media`, {
      params: {
        fields: "id,timestamp,media_type,permalink,caption",
        limit: 50,
        access_token: accessToken,
      },
      timeout: 15000,
    });

    const allMedia = resp.data?.data || [];
    // limit:50이 최대값 — 조회 기간 내 포스트가 50개를 초과하면 누락될 수 있음 (고빈도 계정 주의)
    if (allMedia.length === 50) {
      console.warn(`[${logPrefix}] fetchRecentPosts: 포스트 50개 상한 도달 (igUserId=${igUserId}) — 일부 누락 가능`);
    }
    const sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();

    // 조회 시작 시점 이후 포스트만 필터
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
      const resp = await axios.get(`${baseUrl}/${mediaId}/insights`, {
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
      console.warn(`[${logPrefix}] 인사이트 오류 (${mediaId}, type=${mediaType}): ${err.response?.status || "?"} ${err.message}${detail ? " — " + detail : ""}`);
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

  async function fetchPostComments(mediaId, accessToken, maxComments = 100) {
    const targetLimit = Math.max(1, Math.min(100, Number(maxComments) || 100));

    async function readAll(includeOrder) {
      const out = [];
      let nextUrl = null;
      let isFirst = true;

      while (out.length < targetLimit) {
        let resp;
        if (isFirst) {
          const params = {
            fields: "text,username,timestamp,like_count",
            limit: Math.min(50, targetLimit),
            access_token: accessToken,
          };
          if (includeOrder) params.order = "reverse_chronological";
          resp = await axios.get(`${baseUrl}/${mediaId}/comments`, {
            params,
            timeout: 15000,
          });
          isFirst = false;
        } else if (nextUrl) {
          resp = await axios.get(nextUrl, { timeout: 15000 });
        } else {
          break;
        }

        const items = resp.data?.data || [];
        for (const item of items) {
          if (out.length >= targetLimit) break;
          out.push({
            id: item.id || null,
            text: normalizeCommentText(item.text || ""),
            username: item.username || null,
            timestamp: item.timestamp || null,
            likeCount: item.like_count ?? 0,
          });
        }

        nextUrl = resp.data?.paging?.next || null;
        if (!nextUrl || !items.length) break;
      }

      return out
        .filter((item) => item.text || item.username || item.timestamp)
        .sort((a, b) => {
          const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return bt - at;
        })
        .slice(0, targetLimit);
    }

    try {
      return await readAll(true);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : "";
      console.warn(`[${logPrefix}] 댓글 수집 재시도 (${mediaId}): ${err.message}${detail ? " — " + detail : ""}`);
      try {
        return await readAll(false);
      } catch (retryErr) {
        const retryDetail = retryErr.response?.data ? JSON.stringify(retryErr.response.data).substring(0, 300) : "";
        console.warn(`[${logPrefix}] 댓글 수집 실패 (${mediaId}): ${retryErr.message}${retryDetail ? " — " + retryDetail : ""}`);
        return [];
      }
    }
  }

  /**
   * 전체 게시물 목록 + 인사이트 수집 (페이지네이션)
   * 최초 초기화 시 1회 실행.
   * @param {string} igUserId
   * @param {string} accessToken
   * @returns {Promise<Array>}
   */
  async function fetchAllPosts(igUserId, accessToken) {
    const allMedia = [];
    let nextUrl = null;
    let isFirst = true;

    while (true) {
      let resp;
      if (isFirst) {
        resp = await axios.get(`${baseUrl}/${igUserId}/media`, {
          params: {
            fields: "id,timestamp,media_type,permalink,caption",
            limit: 50,
            access_token: accessToken,
          },
          timeout: 30000,
        });
        isFirst = false;
      } else if (nextUrl) {
        resp = await axios.get(nextUrl, { timeout: 30000 });
      } else {
        break;
      }

      const items = resp.data?.data || [];
      allMedia.push(...items);
      nextUrl = resp.data?.paging?.next || null;
      if (!nextUrl || !items.length) break;
      await sleep(SLEEP_PAGE);
    }

    console.log(`[${logPrefix}] fetchAllPosts: 미디어 ${allMedia.length}개 조회 (igUserId=${igUserId})`);

    const result = [];
    for (const post of allMedia) {
      await sleep(SLEEP_INSIGHT);
      try {
        const insights = await fetchPostInsights(post.id, accessToken, post);
        result.push({ ...post, ...insights });
      } catch (err) {
        if (err.response?.status === 429) {
          console.warn(`[${logPrefix}] fetchAllPosts: 429 Rate Limit — ${result.length}/${allMedia.length}개 후 중단`);
          break;
        }
        console.warn(`[${logPrefix}] fetchAllPosts: 인사이트 실패 (${post.id}): ${err.message}`);
        result.push(post);
      }
    }

    return result;
  }

  /**
   * 최근 N개 게시물 + 인사이트 수집 (일별 배치 갱신용)
   * @param {string} igUserId
   * @param {string} accessToken
   * @param {number} limit - 가져올 게시물 수 (기본 40)
   * @returns {Promise<Array>}
   */
  async function fetchLatestNPosts(igUserId, accessToken, limit = 40) {
    const resp = await axios.get(`${baseUrl}/${igUserId}/media`, {
      params: {
        fields: "id,timestamp,media_type,permalink,caption",
        limit: Math.min(limit, 100),
        access_token: accessToken,
      },
      timeout: 15000,
    });

    const media = resp.data?.data || [];
    const result = [];
    for (const post of media) {
      await sleep(SLEEP_INSIGHT);
      try {
        const insights = await fetchPostInsights(post.id, accessToken, post);
        result.push({ ...post, ...insights });
      } catch (err) {
        if (err.response?.status === 429) {
          console.warn(`[${logPrefix}] fetchLatestNPosts: 429 Rate Limit — ${result.length}개 후 중단`);
          break;
        }
        console.warn(`[${logPrefix}] fetchLatestNPosts: 인사이트 실패 (${post.id}): ${err.message}`);
        result.push(post);
      }
    }

    return result;
  }

  return {
    fetchAccountMetrics,
    fetchRecentPosts,
    fetchPostInsights,
    fetchPostComments,
    fetchAllPosts,
    fetchLatestNPosts,
  };
}

module.exports = { createCollector, sleep, normalizeCommentText, SLEEP_PAGE, SLEEP_INSIGHT };
