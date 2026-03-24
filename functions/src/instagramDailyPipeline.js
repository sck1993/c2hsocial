"use strict";

const admin = require("firebase-admin");
const {
  refreshToken,
  debugToken,
  fetchAccountMetrics,
  fetchRecentPosts,
  fetchAllPosts,
  fetchLatestNPosts,
  fetchPostInsights,
  fetchPostComments,
  sleep,
} = require("./collectors/instagramCollector");
const igDirect = require("./collectors/instagramDirectCollector");
const {
  analyzeInstagramPostPerformance,
  analyzeInstagramPostComment,
  DEFAULT_IG_POST_COMMENT_PROMPT,
} = require("./analyzers/openrouterAnalyzer");
const { sendInstagramEmailReport, logDelivery } = require("./reportDelivery");

// KST(UTC+9) 기준 어제 날짜 문자열 반환
function getKSTYesterdayString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeMediaType(mediaType) {
  const t = String(mediaType || "").toUpperCase();
  if (!t) return null;
  if (t === "REELS") return "VIDEO";
  return t;
}

function getDateDaysAgo(dateStr, days) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().split("T")[0];
}

function getKSTDateString(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function mapPostsById(posts) {
  return new Map((Array.isArray(posts) ? posts : [])
    .filter((post) => post?.id)
    .map((post) => [post.id, post]));
}

const IG_REPORT_POST_WINDOW_DAYS = 7;

function buildPostCommentPeriodContext(targetPost, allPosts) {
  const posts = (Array.isArray(allPosts) ? allPosts : []).filter((post) => post?.id);
  const targetId = targetPost?.id;
  if (!targetId || !posts.length) return "";

  const sortedBy = (selector) => [...posts]
    .filter((post) => selector(post) != null)
    .sort((a, b) => (selector(b) || 0) - (selector(a) || 0));

  const getRankText = (selector, label, reverseLow = false) => {
    const ranked = sortedBy(selector);
    const index = ranked.findIndex((post) => post.id === targetId);
    if (index < 0 || !ranked.length) return null;
    const rank = index + 1;
    if (rank === 1) return `${label} 최상위권`;
    if (rank <= Math.ceil(ranked.length / 3)) return `${label} 상위권`;
    if (rank >= ranked.length && ranked.length >= 3) return reverseLow ? `${label} 하위권` : `${label} 낮은 편`;
    if (rank > Math.floor((ranked.length * 2) / 3)) return reverseLow ? `${label} 하위권` : `${label} 낮은 편`;
    return `${label} 중간권`;
  };

  const parts = [
    `최근 1주 분석 포스트 수 ${posts.length}건`,
    getRankText((post) => post.engagementRate, "참여 반응"),
    getRankText((post) => post.comments, "댓글 대화량"),
    getRankText((post) => post.saves, "저장 반응"),
    getRankText((post) => post.shares, "공유 반응"),
  ].filter(Boolean);

  if (targetPost?.mediaType) {
    const sameTypePosts = posts.filter((post) => post.mediaType === targetPost.mediaType);
    if (sameTypePosts.length >= 2) {
      const rankedWithinType = [...sameTypePosts]
        .sort((a, b) => (b.engagementRate || 0) - (a.engagementRate || 0));
      const typeRank = rankedWithinType.findIndex((post) => post.id === targetId) + 1;
      if (typeRank === 1) parts.push(`동일 유형 내 반응 최상위권`);
      else if (typeRank > 0 && typeRank <= Math.ceil(rankedWithinType.length / 2)) parts.push(`동일 유형 내 반응 상위권`);
    }
  }

  return parts.join(", ");
}

/**
 * Instagram 일별 파이프라인 (리포트 생성 + Firestore 저장, 선택적으로 이메일 발송)
 * 현재 운영 스케줄은 매일 KST 09:00이며, 기본 대상 날짜는 KST 어제입니다.
 *
 * @param {string|null} filterWorkspaceId - 지정 시 해당 워크스페이스만 처리
 * @param {string|null} targetDate - 지정 시 해당 날짜 리포트 생성 (기본: KST 어제)
 * @param {object} options
 * @param {boolean} options.skipEmail - true이면 이메일 발송 건너뜀 (기본: false)
 * @param {boolean} options.forceRegenerateComments - true이면 기존 게시물 AI 코멘트 재생성
 * @param {string|null} options.filterAccountId - 지정 시 해당 계정 doc ID만 처리 (예: "instagram_34601953809451809")
 * @returns {Promise<{processed: number, skipped: number, errors: number}>}
 */
async function runInstagramPipeline(filterWorkspaceId = null, targetDate = null, options = {}) {
  const { skipEmail = false, forceRegenerateComments = false, filterAccountId = null } = options;
  const db   = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const results = { processed: 0, skipped: 0, errors: 0 };

  console.log(`[instagramPipeline] 실행 시작 — date=${date}`);

  // 워크스페이스 목록 조회
  let workspacesSnap;
  if (filterWorkspaceId) {
    const wsDoc = await db.collection("workspaces").doc(filterWorkspaceId).get();
    workspacesSnap = { docs: wsDoc.exists ? [wsDoc] : [] };
  } else {
    workspacesSnap = await db.collection("workspaces").get();
  }

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;

    // 활성 Instagram 계정 조회
    const accountsSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("instagram_accounts")
      .where("isActive", "==", true)
      .get();

    for (const accDoc of accountsSnap.docs) {
      const acc = accDoc.data();
      const docId = accDoc.id;

      if (filterAccountId && docId !== filterAccountId) continue;

      try {
        let { accessToken, igUserId, username, appId, appSecret } = acc;
        const apiType = acc.apiType || "facebook"; // 기존 계정 하위 호환: 기본값 "facebook"
        const performanceReviewPrompt = acc.performanceReviewPrompt || null;
        const performanceReviewModel = acc.performanceReviewModel || "openai/gpt-5.4-mini";
        const postCommentPrompt = acc.postCommentPrompt || acc.reactionAnalysisPrompt || DEFAULT_IG_POST_COMMENT_PROMPT;

        // apiType에 따라 collector 모듈 선택
        const collector = apiType === "instagram" ? igDirect : {
          refreshToken, debugToken, fetchAccountMetrics, fetchRecentPosts, fetchAllPosts, fetchLatestNPosts, fetchPostInsights, fetchPostComments,
        };

        // ── AI usage 누산 ──
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let totalCost = 0;

        // ── a. 토큰 유효성 확인 + 7일 이내 자동 갱신 ──
        let tokenExpiresMs = acc.tokenExpiresAt?.toDate?.()?.getTime() ?? 0;

        if (apiType === "instagram") {
          // Instagram API: /me로 토큰 유효성 확인 (만료일 조회 불가), refresh는 ig_refresh_token 방식
          try {
            await igDirect.debugIgDirectToken(accessToken);
            console.log(`[instagramPipeline] Instagram token 유효 확인 — ${docId}`);
          } catch (debugErr) {
            console.warn(`[instagramPipeline] Instagram token 확인 실패 — ${docId}: ${debugErr.message}`);
          }

          if (tokenExpiresMs - Date.now() <= 7 * 24 * 60 * 60 * 1000) {
            console.log(`[instagramPipeline] Instagram 토큰 갱신 — ${workspaceId}/${docId}`);
            try {
              const { accessToken: newToken, expiresIn } = await igDirect.refreshDirectToken(accessToken);
              accessToken = newToken;
              const newExpiresAt = new Date(Date.now() + (expiresIn || 5184000) * 1000);
              await db.collection("workspaces").doc(workspaceId)
                .collection("instagram_accounts").doc(docId)
                .update({
                  accessToken: newToken,
                  tokenExpiresAt: admin.firestore.Timestamp.fromDate(newExpiresAt),
                  tokenRefreshedAt: admin.firestore.Timestamp.fromDate(new Date()),
                });
            } catch (refreshErr) {
              console.error(`[instagramPipeline] Instagram 토큰 갱신 실패 — ${docId}: ${refreshErr.message}`);
            }
          }
        } else {
          // Facebook API: debug_token으로 실제 만료일 조회 + 7일 이내 갱신
          try {
            const tokenInfo = await debugToken(accessToken, appId, appSecret);
            if (tokenInfo.expiresAt) {
              tokenExpiresMs = tokenInfo.expiresAt.getTime();
              await db.collection("workspaces").doc(workspaceId)
                .collection("instagram_accounts").doc(docId)
                .update({ tokenExpiresAt: admin.firestore.Timestamp.fromDate(tokenInfo.expiresAt) });
              console.log(`[instagramPipeline] debug_token — ${docId}: 만료일 ${tokenInfo.expiresAt.toISOString()}, valid=${tokenInfo.isValid}`);
            }
          } catch (debugErr) {
            console.warn(`[instagramPipeline] debug_token 실패 — ${docId}: ${debugErr.message}`);
          }

          if (tokenExpiresMs - Date.now() <= 7 * 24 * 60 * 60 * 1000) {
            console.log(`[instagramPipeline] Facebook 토큰 갱신 — ${workspaceId}/${docId}`);
            try {
              const { accessToken: newToken, expiresIn } = await refreshToken(accessToken, appId, appSecret);
              accessToken = newToken;
              const newExpiresAt = new Date(Date.now() + (expiresIn || 5184000) * 1000);
              await db.collection("workspaces").doc(workspaceId)
                .collection("instagram_accounts").doc(docId)
                .update({
                  accessToken: newToken,
                  tokenExpiresAt: admin.firestore.Timestamp.fromDate(newExpiresAt),
                  tokenRefreshedAt: admin.firestore.Timestamp.fromDate(new Date()),
                });
            } catch (refreshErr) {
              console.error(`[instagramPipeline] Facebook 토큰 갱신 실패 — ${docId}: ${refreshErr.message}`);
            }
          }
        }

        // ── b. 계정 지표 수집 ──
        const accountMetrics = await collector.fetchAccountMetrics(igUserId, accessToken, date);

        // ── b-2. 전날 리포트에서 delta 계산 (Firestore 1회 읽기로 전체 처리) ──
        const prevDate = getDateDaysAgo(date, 1);
        let followerDelta = null;
        let reachDelta = null;
        let viewsDelta = null;
        let sharesDelta = null;
        let savesDelta = null;
        let profileViewsDelta = null;
        let prevReportData = null;
        try {
          const prevSnap = await db.collection("workspaces").doc(workspaceId)
            .collection("instagram_reports").doc(prevDate)
            .collection("accounts").doc(docId).get();
          if (prevSnap.exists) {
            const prev = prevSnap.data();
            prevReportData = prev;
            const diff = (cur, p) => (cur != null && p != null) ? cur - p : null;
            followerDelta    = diff(accountMetrics.followerCount, prev.followerCount);
            reachDelta       = diff(accountMetrics.dailyReach,    prev.dailyReach);
            viewsDelta       = diff(accountMetrics.dailyViews,    prev.dailyViews);
            sharesDelta      = diff(accountMetrics.dailyShares,   prev.dailyShares);
            savesDelta       = diff(accountMetrics.dailySaves,    prev.dailySaves);
            profileViewsDelta= diff(accountMetrics.profileViews,  prev.profileViews);
          }
        } catch (deltaErr) {
          console.warn(`[instagramPipeline] delta 계산 실패 — ${docId}: ${deltaErr.message}`);
        }

        // ── b-3. 최근 14일 트렌드 데이터 수집 (Firestore 기존 리포트 조회) ──
        const trendData = [];
        const historicalCommentedPostsMap = new Map();
        try {
          const [dy, dm, dd_] = date.split("-").map(Number);
          const baseDateMs = Date.UTC(dy, dm - 1, dd_);
          for (let i = 13; i >= 1; i--) {
            const trendDate = new Date(baseDateMs - i * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const trendSnap = await db.collection("workspaces").doc(workspaceId)
              .collection("instagram_reports").doc(trendDate)
              .collection("accounts").doc(docId).get();
            const td = trendSnap.exists ? trendSnap.data() : null;
            trendData.push({
              date: trendDate,
              followerCount: toIntOrNull(td?.followerCount),
              dailyViews:    toIntOrNull(td?.dailyViews),
            });
            for (const oldPost of Array.isArray(td?.posts) ? td.posts : []) {
              if (!oldPost?.id || !oldPost.aiComment) continue;
              historicalCommentedPostsMap.set(oldPost.id, {
                aiComment: oldPost.aiComment,
                aiCommentStatus: oldPost.aiCommentStatus || "commented",
                aiCommentedAt: oldPost.aiCommentedAt || null,
                aiCommentSourceCommentsCount: oldPost.aiCommentSourceCommentsCount ?? null,
              });
            }
          }
          // 오늘(현재 수집) 데이터를 맨 끝에 추가
          trendData.push({
            date,
            followerCount: toIntOrNull(accountMetrics.followerCount),
            dailyViews:    toIntOrNull(accountMetrics.dailyViews),
          });
        } catch (trendErr) {
          console.warn(`[instagramPipeline] trendData 수집 실패 — ${docId}: ${trendErr.message}`);
        }

        // ── c. 최근 40개 배치 upsert → Firestore posts/ 갱신 (postsInitialized=true인 계정만) ──
        // 리포트 생성 전에 먼저 실행하여 최신 데이터를 확보한다
        const postsColRef = db.collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts").doc(docId)
          .collection("posts");
        let batchUpsertOk = false;

        if (acc.postsInitialized === true) {
          try {
            console.log(`[instagramPipeline] 게시물 스냅샷 배치 갱신 시작 — ${docId}`);
            const latestPosts = await collector.fetchLatestNPosts(igUserId, accessToken, 40);

            // 쓰기 전에 읽어서 firstSyncedAt 미설정 포스트 파악 (쓰기→읽기→쓰기 패턴 제거)
            const existingSnaps = await Promise.all(latestPosts.map((p) => postsColRef.doc(p.id).get()));
            const needsFirstSync = new Set(
              existingSnaps.filter((s) => !s.exists || !s.data()?.firstSyncedAt).map((s) => s.id)
            );

            const nowTs = admin.firestore.FieldValue.serverTimestamp();
            const batchWrite = db.batch();
            for (const post of latestPosts) {
              batchWrite.set(postsColRef.doc(post.id), {
                id: post.id,
                igUserId,
                timestamp: post.timestamp || null,
                permalink: post.permalink || null,
                mediaType: normalizeMediaType(post.media_type),
                caption: post.caption || null,
                views: toIntOrNull(post.views),
                reach: toIntOrNull(post.reach),
                likes: toIntOrNull(post.likes),
                comments: toIntOrNull(post.comments),
                shares: toIntOrNull(post.shares),
                saves: toIntOrNull(post.saves),
                follows: toIntOrNull(post.follows),
                profileVisits: toIntOrNull(post.profileVisits),
                reelAvgWatchTime: post.reelAvgWatchTime ?? null,
                totalInteractions: toIntOrNull(post.totalInteractions),
                engagementRate: post.engagementRate ?? 0,
                lastUpdatedAt: nowTs,
                ...(needsFirstSync.has(post.id) ? { firstSyncedAt: nowTs } : {}),
              }, { merge: true });
            }
            // postsLastSyncedAt 업데이트도 같은 batch에 포함 (별도 RPC 제거)
            batchWrite.update(
              db.collection("workspaces").doc(workspaceId).collection("instagram_accounts").doc(docId),
              { postsLastSyncedAt: nowTs }
            );
            await batchWrite.commit();
            console.log(`[instagramPipeline] 게시물 스냅샷 ${latestPosts.length}개 갱신 완료 — ${docId}`);
            batchUpsertOk = true;
          } catch (batchErr) {
            console.error(`[instagramPipeline] 게시물 스냅샷 갱신 실패, API fallback으로 전환 — ${docId}: ${batchErr.message}`);
          }
        }

        // ── d. 최근 7일 포스트 수집 ──
        // postsInitialized + 배치 성공 → Firestore posts/ 읽기
        // 그 외 → 기존 API 직접 호출 방식
        const sinceRecentWindow = new Date(`${getDateDaysAgo(date, IG_REPORT_POST_WINDOW_DAYS - 1)}T00:00:00Z`);
        const sinceMs = sinceRecentWindow.getTime();
        let postsWithInsights = [];
        let rateLimited = false;

        if (acc.postsInitialized === true && batchUpsertOk) {
          // Firestore posts/ 에서 최근 7일 필터
          try {
            const postsSnap = await postsColRef.orderBy("timestamp", "desc").limit(200).get();
            postsWithInsights = postsSnap.docs
              .map((d) => d.data())
              .filter((p) => p.timestamp && new Date(p.timestamp).getTime() >= sinceMs)
              .map((p) => ({
                id: p.id,
                timestamp: p.timestamp,
                permalink: p.permalink || null,
                mediaType: p.mediaType,
                mediaTypeRaw: p.mediaType || null,
                media_type: p.mediaType || null,
                caption: p.caption || null,
                views: p.views ?? null,
                reach: p.reach ?? null,
                likes: p.likes ?? null,
                comments: p.comments ?? null,
                shares: p.shares ?? null,
                saves: p.saves ?? null,
                follows: p.follows ?? null,
                profileVisits: p.profileVisits ?? null,
                reelAvgWatchTime: p.reelAvgWatchTime ?? null,
                totalInteractions: p.totalInteractions ?? null,
                engagementRate: p.engagementRate ?? 0,
              }));
            console.log(`[instagramPipeline] Firestore posts/ 조회 완료 — ${workspaceId}/${docId}: 최근 7일 ${postsWithInsights.length}개`);
          } catch (readErr) {
            console.warn(`[instagramPipeline] Firestore posts/ 읽기 실패 — ${docId}: ${readErr.message}`);
            postsWithInsights = [];
          }
        } else {
          // API 직접 호출 (미초기화 계정 또는 배치 실패 fallback)
          const recentPosts = await collector.fetchRecentPosts(igUserId, accessToken, sinceRecentWindow);
          console.log(`[instagramPipeline] API 직접 수집 — ${workspaceId}/${docId}: 포스트 ${recentPosts.length}개`);

          for (const post of recentPosts) {
            if (rateLimited) break;
            await sleep(500);
            try {
              const insights = await collector.fetchPostInsights(post.id, accessToken, post);
              const normalizedMediaType = normalizeMediaType(post.media_type);
              postsWithInsights.push({
                id: post.id,
                timestamp: post.timestamp,
                permalink: post.permalink || null,
                mediaType: normalizedMediaType,
                mediaTypeRaw: post.media_type || null,
                media_type: post.media_type || null,
                caption: post.caption || null,
                ...insights,
              });
            } catch (insightErr) {
              if (insightErr.response?.status === 429) {
                console.warn(`[instagramPipeline] 429 Rate Limit — ${docId}: 수집된 ${postsWithInsights.length}/${recentPosts.length}개로 부분 저장`);
                rateLimited = true;
              } else {
                console.warn(`[instagramPipeline] 포스트 인사이트 실패 (${post.id}): ${insightErr.message}`);
              }
            }
          }
        }

        const reportDateRef = db.collection("workspaces").doc(workspaceId)
          .collection("instagram_reports").doc(date);
        let currentReportData = null;
        try {
          const currentSnap = await reportDateRef.collection("accounts").doc(docId).get();
          if (currentSnap.exists) currentReportData = currentSnap.data();
        } catch (currentErr) {
          console.warn(`[instagramPipeline] 기존 동일 날짜 리포트 조회 실패 — ${docId}: ${currentErr.message}`);
        }
        const currentPostsMap = mapPostsById(currentReportData?.posts);

        // ── e. 집계 ──
        const validPosts = postsWithInsights.filter((p) => p.reach && p.reach > 0);
        const avgEngagementRate = validPosts.length > 0
          ? +(validPosts.reduce((sum, p) => sum + p.engagementRate, 0) / validPosts.length).toFixed(2)
          : 0;

        // 최근 7일 포스트 shares / saves 합산 (참고용 — 카드에는 account-level dailyShares/dailySaves 사용)
        const totalShares14d = postsWithInsights.reduce((s, p) => s + (p.shares ?? 0), 0) || null;
        const totalSaves14d  = postsWithInsights.reduce((s, p) => s + (p.saves  ?? 0), 0) || null;

        // 릴스 watch time 집계 (VIDEO 타입, ig_reels_avg_watch_time 있는 포스트만)
        const reelPosts = postsWithInsights.filter((p) => p.mediaType === "VIDEO" && p.reelAvgWatchTime != null);
        const reelCount = reelPosts.length;
        const reelAvgWatchTime = reelCount > 0
          ? Math.round(reelPosts.reduce((s, p) => s + p.reelAvgWatchTime, 0) / reelCount)
          : null;
        // 총 watch time = Σ(avgWatchTime × reach) ms 단위
        const reelTotalWatchTime = reelCount > 0
          ? Math.round(reelPosts.reduce((s, p) => s + p.reelAvgWatchTime * (p.reach || 0), 0))
          : null;

        // ── e-2. 최근 1주 전체 포스트 성과 리뷰 ──
        let aiPerformanceReview = null;
        if (postsWithInsights.length > 0) {
          try {
            const { review, usage: perfUsage } = await analyzeInstagramPostPerformance({
              username,
              posts:                    postsWithInsights,
              accountAvgEngagementRate: avgEngagementRate,
              followerCount:            accountMetrics.followerCount,
              customPrompt:             performanceReviewPrompt,
              model:                    performanceReviewModel,
            });
            aiPerformanceReview = review;
            totalPromptTokens     += perfUsage?.prompt_tokens     || 0;
            totalCompletionTokens += perfUsage?.completion_tokens || 0;
            totalCost             += perfUsage?.cost              || 0;
          } catch (reviewErr) {
            console.warn(`[instagramPipeline] AI 성과 리뷰 실패 — ${docId}: ${reviewErr.message}`);
          }
        }

        const postsWithComments = [];
        for (const post of postsWithInsights) {
          const existingCurrentPost = currentPostsMap.get(post.id);
          if (!forceRegenerateComments && existingCurrentPost?.aiComment) {
            postsWithComments.push({
              ...post,
              aiComment: existingCurrentPost.aiComment,
              aiCommentStatus: existingCurrentPost.aiCommentStatus || "commented",
              aiCommentedAt: existingCurrentPost.aiCommentedAt || new Date().toISOString(),
              aiCommentSourceCommentsCount: existingCurrentPost.aiCommentSourceCommentsCount ?? null,
            });
            continue;
          }

          const historicalComment = historicalCommentedPostsMap.get(post.id);
          if (!forceRegenerateComments && historicalComment?.aiComment) {
            postsWithComments.push({
              ...post,
              aiComment: historicalComment.aiComment,
              aiCommentStatus: historicalComment.aiCommentStatus || "commented",
              aiCommentedAt: historicalComment.aiCommentedAt || new Date().toISOString(),
              aiCommentSourceCommentsCount: historicalComment.aiCommentSourceCommentsCount ?? null,
            });
            continue;
          }

          const postKSTDate = getKSTDateString(post.timestamp);
          if (postKSTDate === date) {
            postsWithComments.push({
              ...post,
              aiCommentStatus: "waiting_1d",
            });
            continue;
          }

          try {
            const latestComments = await collector.fetchPostComments(post.id, accessToken, 100);
            const periodContext = buildPostCommentPeriodContext(post, postsWithInsights);
            const { comment, usage } = await analyzeInstagramPostComment({
              username,
              post,
              comments: latestComments,
              periodContext,
              model: performanceReviewModel,
              customPrompt: postCommentPrompt,
            });
            totalPromptTokens     += usage?.prompt_tokens || 0;
            totalCompletionTokens += usage?.completion_tokens || 0;
            totalCost             += usage?.cost || 0;

            postsWithComments.push({
              ...post,
              aiComment: comment || "",
              aiCommentStatus: comment ? "commented" : null,
              aiCommentedAt: comment ? new Date().toISOString() : null,
              aiCommentSourceCommentsCount: latestComments.length,
            });
          } catch (commentErr) {
            console.warn(`[instagramPipeline] 게시물 AI 코멘트 실패 (${post.id}): ${commentErr.message}`);
            postsWithComments.push(post);
          }
        }

        // ── f. Firestore 저장 ──
        const reportData = {
          igUserId,
          username,
          date,
          followerCount: toIntOrNull(accountMetrics.followerCount),
          followerDelta,
          profileViews: toIntOrNull(accountMetrics.profileViews),
          profileViewsDelta,
          dailyReach:   toIntOrNull(accountMetrics.dailyReach),
          reachDelta,
          mediaReach:   toIntOrNull(accountMetrics.mediaReach),
          storyReach:   toIntOrNull(accountMetrics.storyReach),
          dailyViews:   toIntOrNull(accountMetrics.dailyViews),
          viewsDelta,
          dailyShares:  toIntOrNull(accountMetrics.dailyShares),
          sharesDelta,
          dailySaves:   toIntOrNull(accountMetrics.dailySaves),
          savesDelta,
          totalShares14d,
          totalSaves14d,
          reelAvgWatchTime,
          reelTotalWatchTime,
          reelCount,
          posts: postsWithComments,
          postCount: postsWithComments.length,
          avgEngagementRate,
          trendData,
          aiPerformanceReview,
          model:            performanceReviewModel,
          promptTokens:     totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens:      totalPromptTokens + totalCompletionTokens,
          cost:             totalCost > 0 ? +totalCost.toFixed(6) : null,
          collectedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 부모 문서 생성/갱신 (available-dates 엔드포인트에서 조회 가능하도록)
        await reportDateRef.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

        await reportDateRef.collection("accounts").doc(docId).set(reportData);

        console.log(`[instagramPipeline] ${workspaceId}/${docId} (${date}) 저장 완료`);

        // ── g. 이메일 발송 (skipEmail=true이면 건너뜀) ──
        if (!skipEmail) {
          const emailConfig = acc.deliveryConfig?.email;
          if (emailConfig?.isEnabled && emailConfig.recipients?.length > 0) {
            try {
              await sendInstagramEmailReport({
                recipients: emailConfig.recipients,
                username,
                date,
                report: reportData,
              });
              console.log(`[instagramPipeline] 이메일 발송 완료 — ${username}`);
              logDelivery(db, workspaceId, { platform: "instagram", target: username, reportDate: date, recipientCount: emailConfig.recipients.length });
            } catch (mailErr) {
              console.error(`[instagramPipeline] 이메일 발송 실패 — ${username}: ${mailErr.message}`);
            }
          }
        }

        results.processed++;

        // 계정 간 1초 대기 (rate limit 여유)
        await sleep(1000);

      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : "";
        console.error(`[instagramPipeline] ${workspaceId}/${docId} 오류: ${err.message}${detail ? " — " + detail : ""}`);
        results.errors++;
      }
    }
  }

  console.log("[instagramPipeline] 완료 —", results);
  return results;
}

/**
 * Instagram 이메일 발송
 * 현재는 수동 발송/분리 실행 용도로 유지됩니다.
 *
 * @param {string|null} filterWorkspaceId
 * @param {string|null} targetDate - 지정 시 해당 날짜 리포트 발송 (기본: KST 어제)
 * @returns {Promise<{sent: number, skipped: number, errors: number}>}
 */
async function runInstagramEmailSender(filterWorkspaceId = null, targetDate = null) {
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const results = { sent: 0, skipped: 0, errors: 0 };

  console.log(`[instagramEmailSender] 실행 시작 — date=${date}`);

  let workspacesSnap;
  if (filterWorkspaceId) {
    const wsDoc = await db.collection("workspaces").doc(filterWorkspaceId).get();
    workspacesSnap = { docs: wsDoc.exists ? [wsDoc] : [] };
  } else {
    workspacesSnap = await db.collection("workspaces").get();
  }

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;

    const accountsSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("instagram_accounts")
      .where("isActive", "==", true)
      .get();

    for (const accDoc of accountsSnap.docs) {
      const acc = accDoc.data();
      const docId = accDoc.id;

      const emailConfig = acc.deliveryConfig?.email;
      if (!emailConfig?.isEnabled || !emailConfig.recipients?.length) {
        results.skipped++;
        continue;
      }

      try {
        const reportSnap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("instagram_reports").doc(date)
          .collection("accounts").doc(docId).get();

        if (!reportSnap.exists) {
          console.warn(`[instagramEmailSender] 리포트 없음 — ${workspaceId}/${docId} date=${date}`);
          results.skipped++;
          continue;
        }

        await sendInstagramEmailReport({
          recipients: emailConfig.recipients,
          username: acc.username,
          date,
          report: reportSnap.data(),
        });

        console.log(`[instagramEmailSender] 이메일 발송 완료 — ${acc.username} (${date})`);
        results.sent++;
      } catch (err) {
        console.error(`[instagramEmailSender] ${workspaceId}/${docId} 오류: ${err.message}`);
        results.errors++;
      }
    }
  }

  console.log("[instagramEmailSender] 완료 —", results);
  return results;
}

module.exports = { runInstagramPipeline, runInstagramEmailSender };
