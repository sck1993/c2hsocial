"use strict";

const admin = require("firebase-admin");
const {
  refreshToken,
  debugToken,
  fetchAccountMetrics,
  fetchRecentPosts,
  fetchPostInsights,
  sleep,
} = require("./collectors/instagram");
const { analyzeInstagramPostPerformance } = require("./analyzers/openrouter");
const { sendInstagramEmailReport } = require("./delivery");

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

/**
 * Instagram 일별 파이프라인 (리포트 생성 + Firestore 저장, 선택적으로 이메일 발송)
 * 현재 운영 스케줄은 매일 KST 09:00이며, 기본 대상 날짜는 KST 어제입니다.
 *
 * @param {string|null} filterWorkspaceId - 지정 시 해당 워크스페이스만 처리
 * @param {string|null} targetDate - 지정 시 해당 날짜 리포트 생성 (기본: KST 어제)
 * @param {object} options
 * @param {boolean} options.skipEmail - true이면 이메일 발송 건너뜀 (기본: false)
 * @returns {Promise<{processed: number, skipped: number, errors: number}>}
 */
async function runInstagramPipeline(filterWorkspaceId = null, targetDate = null, options = {}) {
  const { skipEmail = false } = options;
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

      try {
        let { accessToken, igUserId, username, appId, appSecret } = acc;
        const performanceReviewPrompt = acc.performanceReviewPrompt || null;
        const performanceReviewModel = acc.performanceReviewModel || "openai/gpt-5-mini";

        // ── AI usage 누산 ──
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let totalCost = 0;

        // ── a. debug_token으로 실제 만료일 조회 + 7일 이내 자동 갱신 ──
        let tokenExpiresMs = acc.tokenExpiresAt?.toDate?.()?.getTime() ?? 0;
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
          console.log(`[instagramPipeline] 토큰 갱신 — ${workspaceId}/${docId}`);
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
            console.error(`[instagramPipeline] 토큰 갱신 실패 — ${docId}: ${refreshErr.message}`);
          }
        }

        // ── b. 계정 지표 수집 (팔로워, 프로필 방문, 해당일 account-level 지표) ──
        const accountMetrics = await fetchAccountMetrics(igUserId, accessToken, date);

        // ── b-2. 전날 리포트에서 delta 계산 (Firestore 1회 읽기로 전체 처리) ──
        const prevDate = getDateDaysAgo(date, 1);
        let followerDelta = null;
        let reachDelta = null;
        let viewsDelta = null;
        let sharesDelta = null;
        let savesDelta = null;
        let profileViewsDelta = null;
        try {
          const prevSnap = await db.collection("workspaces").doc(workspaceId)
            .collection("instagram_reports").doc(prevDate)
            .collection("accounts").doc(docId).get();
          if (prevSnap.exists) {
            const prev = prevSnap.data();
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

        // ── c. 최근 14일 포스트 목록 ──
        const since14Days = new Date(`${getDateDaysAgo(date, 13)}T00:00:00Z`);
        const recentPosts = await fetchRecentPosts(igUserId, accessToken, since14Days);
        console.log(`[instagramPipeline] ${workspaceId}/${docId}: 포스트 ${recentPosts.length}개`);

        // ── d. 포스트별 인사이트 순차 수집 (500ms 간격) ──
        const postsWithInsights = [];
        let rateLimited = false;
        for (const post of recentPosts) {
          if (rateLimited) break;
          await sleep(500);
          try {
            const insights = await fetchPostInsights(post.id, accessToken, post);
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
              // 개별 포스트 인사이트 실패는 건너뛰고 계속
              console.warn(`[instagramPipeline] 포스트 인사이트 실패 (${post.id}): ${insightErr.message}`);
            }
          }
        }

        // ── e. 집계 ──
        const validPosts = postsWithInsights.filter((p) => p.reach && p.reach > 0);
        const avgEngagementRate = validPosts.length > 0
          ? +(validPosts.reduce((sum, p) => sum + p.engagementRate, 0) / validPosts.length).toFixed(2)
          : 0;

        // 14일 포스트 shares / saves 합산 (참고용 — 카드에는 account-level dailyShares/dailySaves 사용)
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

        // ── e-2. 최근 2주 전체 포스트 성과 리뷰 ──
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
          posts: postsWithInsights,
          postCount: postsWithInsights.length,
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

        const reportDateRef = db.collection("workspaces").doc(workspaceId)
          .collection("instagram_reports").doc(date);

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
