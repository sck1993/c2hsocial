"use strict";
const admin = require("firebase-admin");
const axios = require("axios");

// KST 오늘 날짜 문자열
function getKSTDateString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/**
 * Discord 인사이트 API 호출 → 오늘치 데이터 반환
 * @param {string} guildId
 * @param {string} userToken
 * @param {string} date  YYYY-MM-DD (KST)
 */
async function fetchGuildInsights(guildId, userToken, date) {
  // 해당 날짜 KST 00:00 ~ 23:59 UTC 범위
  const start = new Date(date + "T00:00:00+09:00").toISOString();
  const end   = new Date(date + "T23:59:59+09:00").toISOString();

  const headers = { Authorization: userToken };

  // 두 API 병렬 호출
  const [engagementRes, guildRes] = await Promise.all([
    axios.get(
      `https://discord.com/api/v9/guilds/${guildId}/analytics/engagement/overview` +
      `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&interval=1`,
      { headers, timeout: 15000 }
    ),
    axios.get(
      `https://discord.com/api/v9/guilds/${guildId}?with_counts=true`,
      { headers, timeout: 15000 }
    ),
  ]);

  // Discord 응답: 최상위 배열로 반환됨 (날짜별 항목)
  const arr = Array.isArray(engagementRes.data) ? engagementRes.data : (engagementRes.data.days || []);
  const day = arr[0] || {};
  const guild = guildRes.data || {};

  return {
    totalMembers:          guild.approximate_member_count   ?? null,
    onlineMembers:         guild.approximate_presence_count ?? null,
    communicatingMembers:  day.communicators    ?? null,  // 메시지 전송 멤버 수
    activeMembers:         day.visitors         ?? null,  // 채널 열람 멤버 수
    newMembers:            null,                          // Discord API 미제공
    leavingMembers:        null,                          // Discord API 미제공
    messageCount:          day.messages         ?? null,
    speakingMinutes:       day.speaking_minutes ?? null,
  };
}

/**
 * 전체 워크스페이스 길드 순회 → discordUserToken 있는 길드만 인사이트 수집
 */
async function runInsightCollector(filterWorkspaceId = null) {
  const db = admin.firestore();
  // Discord 인사이트는 전날 데이터까지만 제공 → KST 어제 날짜로 수집
  const yesterday = new Date(Date.now() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];
  const results = { collected: 0, skipped: 0, errors: 0 };

  let workspacesSnap;
  if (filterWorkspaceId) {
    const wsDoc = await db.collection("workspaces").doc(filterWorkspaceId).get();
    workspacesSnap = { docs: wsDoc.exists ? [wsDoc] : [] };
  } else {
    workspacesSnap = await db.collection("workspaces").get();
  }

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;
    const guildsSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("guilds").get();

    for (const guildDoc of guildsSnap.docs) {
      const guild = guildDoc.data();
      const { discordUserToken, guildName } = guild;
      // discordGuildId가 명시적으로 없으면 문서 ID(discord_XXXXXXX)에서 파싱
      const discordGuildId = guild.discordGuildId || guildDoc.id.replace(/^discord_/, "");

      if (!discordUserToken || !discordGuildId) {
        results.skipped++;
        continue;
      }

      const docId = `${guildDoc.id}_${yesterday}`;
      try {
        const metrics = await fetchGuildInsights(discordGuildId, discordUserToken, yesterday);

        await db
          .collection("workspaces").doc(workspaceId)
          .collection("weekly_insights").doc(docId)
          .set({
            guildDocId:  guildDoc.id,
            guildId:     discordGuildId,
            guildName:   guildName || "",
            date:        yesterday,
            ...metrics,
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

        console.log(`[insightCollector] ${workspaceId}/${guildDoc.id} (${yesterday}) 수집 완료`);
        results.collected++;
      } catch (err) {
        console.error(`[insightCollector] ${workspaceId}/${guildDoc.id} 오류:`, err.message);
        results.errors++;
      }
    }
  }

  console.log("[insightCollector] 완료 —", results);
  return results;
}

module.exports = { runInsightCollector };
