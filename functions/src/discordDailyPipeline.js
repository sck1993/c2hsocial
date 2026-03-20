"use strict";

const admin = require("firebase-admin");
const { analyzeGuildMessages }               = require("./analyzers/openrouterAnalyzer");
const { sendEmailReport, appendToGoogleSheet } = require("./reportDelivery");
const { getKSTYesterdayString } = require("./utils/dateUtils");

/**
 * 전체 파이프라인 실행.
 * Discord 직접 수집 없이, alertPipeline이 당일 저장한 collected_chunks를
 * 길드별로 집계하여 AI 분석 → 리포트/사용량 저장 → 배포.
 *
 * @param {string|null} filterWorkspaceId - 지정 시 해당 워크스페이스만 처리
 * @returns {Promise<{processed, skipped, errors}>}
 */
// AI 분석 전 채널별 메시지 상한 (토큰/비용 제어)
const MAX_MESSAGES_PER_CHANNEL = 2000;

/**
 * 메시지 배열을 maxCount 이하로 균등 분산 샘플링.
 * 하루 전체(새벽~자정)를 고르게 커버하기 위해 step 간격으로 추출.
 */
function sampleMessages(messages, maxCount) {
  if (messages.length <= maxCount) return messages;
  const step = messages.length / maxCount;
  return Array.from({ length: maxCount }, (_, i) => messages[Math.floor(i * step)]);
}

/**
 * AI가 반환한 이슈의 messageId를 messageQuote 교차 검증으로 교정.
 * AI가 messageQuote(메시지 원문 앞 40자)를 함께 반환할 때,
 * 실제 수집된 messages 배열에서 quote 텍스트를 검색하여 ID 불일치를 자동 수정.
 *
 * @param {Array} issues - AI 분석 결과의 issues 배열
 * @param {Array} channelsWithMessages - 채널별 messages 포함 배열
 * @returns {Array} 교정된 issues 배열
 */
function resolveIssueMessageIds(issues, channelsWithMessages) {
  // 모든 채널 메시지를 flat하게 수집 (channelId 태깅 포함)
  const allMessages = [];
  for (const ch of channelsWithMessages) {
    for (const m of ch.messages || []) {
      allMessages.push({ ...m, _channelId: ch.discordChannelId });
    }
  }

  return (issues || []).map(issue => {
    const quote = issue.messageQuote;
    if (!quote) return issue; // quote 없으면 AI messageId 그대로 사용

    // quote 앞 30자로 실제 메시지 검색 (대소문자 무관)
    const searchStr = quote.substring(0, 30).toLowerCase();
    const matched = allMessages.find(m =>
      m.content && m.content.toLowerCase().includes(searchStr)
    );

    if (matched) {
      // 매칭 성공 → 실제 ID + channelId로 교정
      if (matched.id !== issue.messageId || matched._channelId !== issue.channelId) {
        console.log(`[resolveIssueMessageIds] 교정: "${issue.title}" messageId ${issue.messageId} → ${matched.id}`);
      }
      return { ...issue, messageId: matched.id, channelId: matched._channelId };
    }

    // 매칭 실패 → AI가 반환한 값 그대로 사용 (폴백)
    return issue;
  });
}

/**
 * 이메일 발송 블록 (KO/EN 수신자 분리, 오류 격리).
 * runPipeline 과 reDeliver 양쪽에서 공유.
 */
async function dispatchEmailForGuild(emailCfg, { guildName, guildId, date, report, label }) {
  if (!emailCfg.isEnabled) return;
  const recipientsKo = emailCfg.recipientsKo || emailCfg.recipients || [];
  const recipientsEn = emailCfg.recipientsEn || [];
  if (recipientsKo.length === 0 && recipientsEn.length === 0) {
    console.log(`${label} 이메일 수신자 없음 — 발송 생략`);
    return;
  }
  if (recipientsKo.length > 0) {
    try {
      await sendEmailReport({ recipients: recipientsKo, guildName, guildId, date, report, lang: "ko" });
      console.log(`${label} 이메일(KO) 발송 완료 (${recipientsKo.length}명)`);
    } catch (emailErr) {
      console.error(`${label} 이메일(KO) 발송 실패:`, emailErr.message);
    }
  }
  if (recipientsEn.length > 0) {
    try {
      await sendEmailReport({ recipients: recipientsEn, guildName, guildId, date, report, lang: "en" });
      console.log(`${label} 이메일(EN) 발송 완료 (${recipientsEn.length}명)`);
    } catch (emailErr) {
      console.error(`${label} 이메일(EN) 발송 실패:`, emailErr.message);
    }
  }
}

async function runPipeline(filterWorkspaceId = null) {
  const db = admin.firestore();
  const today = getKSTYesterdayString(); // YYYY-MM-DD (KST 전일) — 전일 리포트 대상 날짜
  const dayStartMs = new Date(today + "T00:00:00+09:00").getTime(); // KST 00:00:00 (UTC ms)
  const dayEndMs   = dayStartMs + 24 * 60 * 60 * 1000;             // KST 다음날 00:00:00 (exclusive)
  const results = { processed: 0, skipped: 0, errors: 0 };

  console.log(`[pipeline] 시작 — ${today}${filterWorkspaceId ? ` (워크스페이스: ${filterWorkspaceId})` : ""}`);

  let workspacesSnap;
  if (filterWorkspaceId) {
    const wsDoc = await db.collection("workspaces").doc(filterWorkspaceId).get();
    workspacesSnap = { docs: wsDoc.exists ? [wsDoc] : [] };
  } else {
    workspacesSnap = await db.collection("workspaces").get();
  }

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;

    // ── 당일 수집된 청크 읽기 ─────────────────────────────────
    const chunksSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("collected_chunks")
      .where("date", "==", today)
      .get();

    if (chunksSnap.empty) {
      console.log(`[pipeline] ${workspaceId} — 당일 수집 청크 없음, 스킵`);
      results.skipped++;
      continue;
    }

    // ── 청크를 guildId 기준으로 집계 ─────────────────────────
    // guildId → { guildName, channels: Map(channelDocId → channelMeta) }
    const guildMap = new Map();

    for (const chunkDoc of chunksSnap.docs) {
      const c = chunkDoc.data();
      const guildId = c.discordGuildId;
      if (!guildId) continue;

      if (!guildMap.has(guildId)) {
        guildMap.set(guildId, {
          guildName: c.guildName || guildId,
          // channelDocId → { channelName, importance, customPrompt, discordChannelId, seenIds, messages, alertTriggered }
          channels:  new Map(),
        });
      }

      const guild = guildMap.get(guildId);
      const { channelDocId, channelName, importance, customPrompt, discordChannelId, messages = [], alertTriggered } = c;

      if (!guild.channels.has(channelDocId)) {
        guild.channels.set(channelDocId, {
          channelDocId,
          channelName:      channelName      || channelDocId,
          importance:       importance       || "normal",
          customPrompt:     customPrompt     || "",
          discordChannelId: discordChannelId || "",
          seenIds:          new Set(),
          messages:         [],
          alertTriggered:   false,
        });
      }

      const ch = guild.channels.get(channelDocId);

      // 메시지 ID 기준 중복 제거 + 대상 날짜(KST) 범위 필터링
      for (const m of messages) {
        if (!m.id || ch.seenIds.has(m.id)) continue;
        const ts = new Date(m.timestamp).getTime();
        if (isNaN(ts) || ts < dayStartMs || ts >= dayEndMs) continue; // 유효하지 않거나 대상 날짜 외 메시지 제외
        ch.seenIds.add(m.id);
        ch.messages.push(m);
      }

      if (alertTriggered) ch.alertTriggered = true;
    }

    // ── 길드별 처리 ──────────────────────────────────────────
    for (const [guildId, { guildName, channels }] of guildMap) {
      const guildDocId = `discord_${guildId}`;
      const guildLabel = `[${workspaceId}/${guildDocId}]`;

      try {
        // 타임스탬프 오름차순 정렬 + 메시지 있는 채널만 추출
        const channelsWithMessages = [];
        let isAlertTriggered = false;

        for (const ch of channels.values()) {
          if (ch.messages.length === 0) continue;
          ch.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

          const originalCount   = ch.messages.length;
          const sampledMessages = sampleMessages(ch.messages, MAX_MESSAGES_PER_CHANNEL);
          if (sampledMessages.length < originalCount) {
            console.log(`${guildLabel} #${ch.channelName}: ${originalCount}개 → ${sampledMessages.length}개 균등 샘플링`);
          }

          channelsWithMessages.push({
            channelDocId:         ch.channelDocId,
            channelName:          ch.channelName,
            importance:           ch.importance,
            customPrompt:         ch.customPrompt,
            discordChannelId:     ch.discordChannelId,
            messages:             sampledMessages,
            originalMessageCount: originalCount,
          });
          if (ch.alertTriggered) isAlertTriggered = true;
        }

        if (channelsWithMessages.length === 0) {
          console.log(`${guildLabel} 메시지 없음 — 스킵`);
          results.skipped++;
          continue;
        }

        const totalMessages = channelsWithMessages.reduce((s, c) => s + (c.originalMessageCount ?? c.messages.length), 0);
        console.log(`${guildLabel} AI 분석 중... (${channelsWithMessages.length}개 채널, ${totalMessages}개 메시지)`);

        // ── 길드 설정 로드 (summaryPrompt + deliveryConfig) ────
        const guildConfigDoc = await db
          .collection("workspaces").doc(workspaceId)
          .collection("guilds").doc(guildDocId)
          .get();

        const summaryPrompt = guildConfigDoc.exists
          ? (guildConfigDoc.data().summaryPrompt || "")
          : "";

        // ── AI 분석 ────────────────────────────────────────────
        const { report, usage } = await analyzeGuildMessages(channelsWithMessages, guildName, guildId, summaryPrompt);
        console.log(`${guildLabel} AI 분석 완료 (tokens: ${usage?.total_tokens ?? 0})`);

        // ── 이슈 messageId 교차 검증 (messageQuote → 실제 메시지 ID 교정) ──
        const resolvedIssues = resolveIssueMessageIds(report.issues || [], channelsWithMessages);

        // ── 채널별 요약 보강 ────────────────────────────────────
        const channelSummaries = (report.channels || []).map((rc) => {
          const matched = channelsWithMessages.find((c) => c.channelDocId === rc.channelDocId);
          return {
            channelDocId:  rc.channelDocId,
            channelName:   matched?.channelName || rc.channelDocId,
            importance:    matched?.importance  || "normal",
            messageCount:  matched?.originalMessageCount ?? matched?.messages.length ?? 0,
            summary:       rc.summary    || "",
            summary_en:    rc.summary_en || "",
            sentiment:     rc.sentiment  || {},
            keywords:      rc.keywords   || [],
          };
        });

        // ── 길드 감정: 채널별 메시지 수 가중 평균 (채널 중요도 무관) ──
        const _totalMsgCount = channelSummaries.reduce((s, c) => s + (c.messageCount || 0), 0);
        const guildSentiment = _totalMsgCount > 0
          ? (() => {
              const pos = Math.round(channelSummaries.reduce((s, c) => s + (c.sentiment?.positive || 0) * (c.messageCount || 0), 0) / _totalMsgCount);
              const neu = Math.round(channelSummaries.reduce((s, c) => s + (c.sentiment?.neutral  || 0) * (c.messageCount || 0), 0) / _totalMsgCount);
              const neg = 100 - pos - neu; // 합산이 정확히 100이 되도록 보정
              return { positive: pos, neutral: neu, negative: neg };
            })()
          : (report.sentiment || {});

        // ── 길드 리포트 저장 ────────────────────────────────────
        const reportRef = db
          .collection("workspaces").doc(workspaceId)
          .collection("reports").doc(today)
          .collection("guilds").doc(guildDocId);

        await reportRef.set({
          discordGuildId:   guildId,
          guildName,
          messageCount:     totalMessages,
          summary:          report.summary    || "",
          summary_en:       report.summary_en || "",
          sentiment:        guildSentiment,
          keywords:         report.keywords   || [],
          keywords_en:      report.keywords_en || [],
          issues:           resolvedIssues,
          channels:         channelSummaries,
          isAlertTriggered,
          model:            process.env.OPENROUTER_MODEL || "",
          promptTokens:     usage?.prompt_tokens     || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens:      usage?.total_tokens      || 0,
          cost:             usage?.cost              ?? null,
          createdAt:        admin.firestore.FieldValue.serverTimestamp(),
        });

        // ── 사용량 로그 ─────────────────────────────────────────
        await db
          .collection("workspaces").doc(workspaceId)
          .collection("usage_logs")
          .add({
            date:             today,
            guildDocId,
            platform:         "discord",
            messageCount:     totalMessages,
            promptTokens:     usage?.prompt_tokens     || 0,
            completionTokens: usage?.completion_tokens || 0,
            totalTokens:      usage?.total_tokens      || 0,
            createdAt:        admin.firestore.FieldValue.serverTimestamp(),
          });

        // ── 리포트 배포 (길드 단위 deliveryConfig 사용) ──────────
        const guildDelivery = guildConfigDoc.exists
          ? (guildConfigDoc.data().deliveryConfig || {})
          : {};

        const emailCfg  = guildDelivery.email        || {};
        const sheetsCfg = guildDelivery.googleSheets || {};

        const reportPayload = {
          summary:         report.summary    || "",
          summary_en:      report.summary_en || "",
          sentiment:       guildSentiment,
          keywords:        report.keywords   || [],
          keywords_en:     report.keywords_en || [],
          issues:          resolvedIssues,
          channels:        channelSummaries,
          messageCount:    totalMessages,
          isAlertTriggered,
        };

        await dispatchEmailForGuild(emailCfg, { guildName, guildId, date: today, report: reportPayload, label: guildLabel });

        if (sheetsCfg.isEnabled && sheetsCfg.spreadsheetUrl) {
          try {
            await appendToGoogleSheet({
              spreadsheetUrl: sheetsCfg.spreadsheetUrl,
              guildName,
              date:           today,
              report:         reportPayload,
            });
            console.log(`${guildLabel} 구글 시트 기록 완료`);
          } catch (sheetErr) {
            console.error(`${guildLabel} 구글 시트 기록 실패:`, sheetErr.message);
          }
        }

        console.log(`${guildLabel} 저장 완료`);
        results.processed++;

      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error(`${guildLabel} 오류:`, detail);
        results.errors++;
      }
    }
  }

  console.log("[pipeline] 완료 —", results);
  return results;
}

/**
 * 기존 Firestore 리포트 데이터를 이용해 이메일/시트 발송만 재실행.
 * 과거 날짜 수동 트리거 시 사용.
 *
 * @param {string} workspaceId
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<{redelivered, errors}>}
 */
async function reDeliver(workspaceId, date) {
  const db = admin.firestore();
  const results = { redelivered: 0, errors: 0 };

  const guildsSnap = await db
    .collection("workspaces").doc(workspaceId)
    .collection("reports").doc(date)
    .collection("guilds")
    .get();

  if (guildsSnap.empty) {
    console.log(`[reDeliver] ${workspaceId}/${date} — 리포트 없음`);
    return results;
  }

  for (const guildDoc of guildsSnap.docs) {
    const guildDocId = guildDoc.id;
    const r = guildDoc.data();
    const guildLabel = `[${workspaceId}/${guildDocId}]`;

    try {
      const guildConfigDoc = await db
        .collection("workspaces").doc(workspaceId)
        .collection("guilds").doc(guildDocId)
        .get();

      const guildDelivery = guildConfigDoc.exists
        ? (guildConfigDoc.data().deliveryConfig || {})
        : {};

      const emailCfg  = guildDelivery.email        || {};
      const sheetsCfg = guildDelivery.googleSheets || {};

      const reportPayload = {
        summary:          r.summary          || "",
        summary_en:       r.summary_en       || "",
        sentiment:        r.sentiment        || {},
        keywords:         r.keywords         || [],
        keywords_en:      r.keywords_en      || [],
        issues:           r.issues           || [],
        channels:         r.channels         || [],
        messageCount:     r.messageCount     || 0,
        isAlertTriggered: r.isAlertTriggered || false,
      };

      await dispatchEmailForGuild(emailCfg, { guildName: r.guildName, guildId: r.discordGuildId || "", date, report: reportPayload, label: `${guildLabel} [reDeliver]` });

      if (sheetsCfg.isEnabled && sheetsCfg.spreadsheetUrl) {
        try {
          await appendToGoogleSheet({
            spreadsheetUrl: sheetsCfg.spreadsheetUrl,
            guildName:      r.guildName,
            date,
            report:         reportPayload,
          });
          console.log(`${guildLabel} [reDeliver] 구글 시트 기록 완료`);
        } catch (sheetErr) {
          console.error(`${guildLabel} [reDeliver] 구글 시트 기록 실패:`, sheetErr.message);
        }
      }

      results.redelivered++;
    } catch (err) {
      console.error(`${guildLabel} [reDeliver] 오류:`, err.message);
      results.errors++;
    }
  }

  console.log(`[reDeliver] 완료 —`, results);
  return results;
}

module.exports = { runPipeline, reDeliver };
