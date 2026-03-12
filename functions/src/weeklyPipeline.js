"use strict";
const admin  = require("firebase-admin");
const { analyzeWeeklySummary }   = require("./analyzers/openrouter");
const { sendWeeklyEmailReport }  = require("./delivery");

// 이번 주 월요일 기준 직전 주 월~일 날짜 계산 (KST)
function getLastWeekRange() {
  const nowKST  = new Date(Date.now() + 9 * 60 * 60 * 1000);
  // 이번 주 월요일 00:00 KST
  const dayOfWeek = nowKST.getUTCDay() || 7; // 0(일)→7
  const thisMonday = new Date(nowKST);
  thisMonday.setUTCDate(nowKST.getUTCDate() - (dayOfWeek - 1));
  thisMonday.setUTCHours(0, 0, 0, 0);

  // 직전 주 월요일 ~ 일요일
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCDate(thisMonday.getUTCDate() - 1);

  const fmt = d => d.toISOString().split("T")[0];
  return { weekStart: fmt(lastMonday), weekEnd: fmt(lastSunday) };
}

// weekStart 기준 7일 날짜 배열 생성
function getWeekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().split("T")[0];
  });
}

async function runWeeklyPipeline(filterWorkspaceId = null, overrideWeekStart = null) {
  const db = admin.firestore();
  const { weekStart, weekEnd } = overrideWeekStart
    ? { weekStart: overrideWeekStart, weekEnd: (() => {
        const d = new Date(overrideWeekStart + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + 6);
        return d.toISOString().split("T")[0];
      })() }
    : getLastWeekRange();

  const dates = getWeekDates(weekStart);
  console.log(`[weeklyPipeline] 시작 — ${weekStart} ~ ${weekEnd}`);

  let workspacesSnap;
  if (filterWorkspaceId) {
    const wsDoc = await db.collection("workspaces").doc(filterWorkspaceId).get();
    workspacesSnap = { docs: wsDoc.exists ? [wsDoc] : [] };
  } else {
    workspacesSnap = await db.collection("workspaces").get();
  }

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;
    const guildsSnap  = await db
      .collection("workspaces").doc(workspaceId)
      .collection("guilds").get();

    for (const guildDoc of guildsSnap.docs) {
      const guild = guildDoc.data();
      const guildId   = guildDoc.id;
      const label     = `[${workspaceId}/${guildId}]`;

      try {
        // 1. 7일치 일일 리포트 읽기
        const dailyReports = [];
        let resolvedGuildName = guild.guildName || null;
        for (const date of dates) {
          const snap = await db
            .collection("workspaces").doc(workspaceId)
            .collection("reports").doc(date)
            .collection("guilds").doc(guild.discordGuildId || guildId)
            .get();
          if (snap.exists) {
            const d = snap.data();
            // 일일 리포트에서 실제 서버 이름 추출 (guilds 컬렉션에 guildName 미설정 대비)
            if (!resolvedGuildName && d.guildName) resolvedGuildName = d.guildName;
            dailyReports.push({ date, summary: d.summary || "", issues: d.issues || [] });
          }
        }
        const guildName = resolvedGuildName || guildId;

        if (dailyReports.length === 0) {
          console.log(`${label} 일일 리포트 없음, 스킵`);
          continue;
        }

        // 2. 7일치 인사이트 읽기
        const insightsChart = [];
        const sentimentChart = [];
        for (const date of dates) {
          const insightSnap = await db
            .collection("workspaces").doc(workspaceId)
            .collection("weekly_insights").doc(`${guildId}_${date}`)
            .get();
          insightsChart.push(insightSnap.exists
            ? { date, ...insightSnap.data() }
            : { date, totalMembers: null, communicatingMembers: null, activeMembers: null,
                newMembers: null, leavingMembers: null, messageCount: null });

          const rSnap = await db
            .collection("workspaces").doc(workspaceId)
            .collection("reports").doc(date)
            .collection("guilds").doc(guild.discordGuildId || guildId)
            .get();
          const sentiment = rSnap.exists ? (rSnap.data().sentiment || {}) : {};
          sentimentChart.push({
            date,
            positive: sentiment.positive ?? null,
            neutral:  sentiment.neutral  ?? null,
            negative: sentiment.negative ?? null,
          });
        }

        // 3. AI 주간 요약 + 이슈 병합 (유사 이슈 하나로 합산)
        console.log(`${label} AI 주간 요약 생성 중...`);
        const { aiSummary, aiSummary_en, weeklyIssues, usage } = await analyzeWeeklySummary(dailyReports, guildName);
        console.log(`${label} AI 완료. 토큰: ${usage?.total_tokens}, 병합 이슈: ${weeklyIssues.length}건`);

        // 4. Firestore 저장
        const report = { weekStart, weekEnd, guildName, guildId: guild.discordGuildId || guildId,
          aiSummary, aiSummary_en: aiSummary_en || "", insightsChart, sentimentChart, weeklyIssues,
          generatedAt: admin.firestore.FieldValue.serverTimestamp() };

        await db
          .collection("workspaces").doc(workspaceId)
          .collection("weekly_reports").doc(weekStart)
          .collection("guilds").doc(guildId)
          .set(report);
        console.log(`${label} weekly_reports 저장 완료`);

        // 5. 이메일 발송
        const deliveryConfig = guild.deliveryConfig || {};
        const emailCfg = deliveryConfig.email || {};
        const recipientsKo = emailCfg.recipientsKo || emailCfg.recipients || [];
        const recipientsEn = emailCfg.recipientsEn || [];
        if (recipientsKo.length > 0) {
          await sendWeeklyEmailReport({ recipients: recipientsKo, guildName, weekStart, weekEnd, report, lang: "ko" });
          console.log(`${label} 이메일(KO) 발송 완료`);
        }
        if (recipientsEn.length > 0) {
          await sendWeeklyEmailReport({ recipients: recipientsEn, guildName, weekStart, weekEnd, report, lang: "en" });
          console.log(`${label} 이메일(EN) 발송 완료`);
        }
        if (recipientsKo.length === 0 && recipientsEn.length === 0) {
          console.log(`${label} 이메일 수신자 없음, 발송 스킵`);
        }

      } catch (err) {
        console.error(`${label} 오류:`, err.message);
      }
    }
  }

  console.log(`[weeklyPipeline] 완료 — ${weekStart} ~ ${weekEnd}`);
}

module.exports = { runWeeklyPipeline };
