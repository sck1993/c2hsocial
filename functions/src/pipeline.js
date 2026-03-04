"use strict";

const admin = require("firebase-admin");
const { analyzeGuildMessages }               = require("./analyzers/openrouter");
const { sendEmailReport, appendToGoogleSheet } = require("./delivery");

/**
 * 전체 파이프라인 실행.
 * Discord 직접 수집 없이, alertPipeline이 당일 저장한 collected_chunks를
 * 길드별로 집계하여 AI 분석 → 리포트/사용량 저장 → 배포.
 *
 * @param {string|null} filterWorkspaceId - 지정 시 해당 워크스페이스만 처리
 * @returns {Promise<{processed, skipped, errors}>}
 */
// AI 분석 전 채널별 메시지 상한 (토큰/비용 제어)
const MAX_MESSAGES_PER_CHANNEL = 5000;

/**
 * 메시지 배열을 maxCount 이하로 균등 분산 샘플링.
 * 하루 전체(새벽~자정)를 고르게 커버하기 위해 step 간격으로 추출.
 */
function sampleMessages(messages, maxCount) {
  if (messages.length <= maxCount) return messages;
  const step = messages.length / maxCount;
  return Array.from({ length: maxCount }, (_, i) => messages[Math.floor(i * step)]);
}

// KST(UTC+9) 기준 어제 날짜 문자열 반환 (오늘 09:00 KST에 전일 리포트 생성)
function getKSTYesterdayString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
}

async function runPipeline(filterWorkspaceId = null) {
  const db = admin.firestore();
  const today = getKSTYesterdayString(); // YYYY-MM-DD (KST 전일) — 전일 리포트 대상 날짜
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

      // 메시지 ID 기준 중복 제거
      for (const m of messages) {
        if (m.id && !ch.seenIds.has(m.id)) {
          ch.seenIds.add(m.id);
          ch.messages.push(m);
        }
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

        // ── 채널별 요약 보강 ────────────────────────────────────
        const channelSummaries = (report.channels || []).map((rc) => {
          const matched = channelsWithMessages.find((c) => c.channelDocId === rc.channelDocId);
          return {
            channelDocId:  rc.channelDocId,
            channelName:   matched?.channelName || rc.channelDocId,
            importance:    matched?.importance  || "normal",
            messageCount:  matched?.originalMessageCount ?? matched?.messages.length ?? 0,
            summary:       rc.summary   || "",
            sentiment:     rc.sentiment || {},
            keywords:      rc.keywords  || [],
          };
        });

        // ── 길드 리포트 저장 ────────────────────────────────────
        const reportRef = db
          .collection("workspaces").doc(workspaceId)
          .collection("reports").doc(today)
          .collection("guilds").doc(guildDocId);

        await reportRef.set({
          discordGuildId:   guildId,
          guildName,
          messageCount:     totalMessages,
          summary:          report.summary   || "",
          sentiment:        report.sentiment || {},
          keywords:         report.keywords  || [],
          issues:           report.issues    || [],
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
          summary:         report.summary   || "",
          sentiment:       report.sentiment || {},
          keywords:        report.keywords  || [],
          issues:          report.issues    || [],
          channels:        channelSummaries,
          messageCount:    totalMessages,
          isAlertTriggered,
        };

        if (emailCfg.isEnabled) {
          const recipients = emailCfg.recipients || [];
          if (recipients.length > 0) {
            try {
              await sendEmailReport({ recipients, guildName, guildId, date: today, report: reportPayload });
              console.log(`${guildLabel} 이메일 발송 완료 (${recipients.length}명)`);
            } catch (emailErr) {
              console.error(`${guildLabel} 이메일 발송 실패:`, emailErr.message);
            }
          } else {
            console.log(`${guildLabel} 이메일 수신자 없음 — 발송 생략`);
          }
        }

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
        sentiment:        r.sentiment         || {},
        keywords:         r.keywords          || [],
        issues:           r.issues            || [],
        channels:         r.channels          || [],
        messageCount:     r.messageCount      || 0,
        isAlertTriggered: r.isAlertTriggered  || false,
      };

      if (emailCfg.isEnabled) {
        const recipients = emailCfg.recipients || [];
        if (recipients.length > 0) {
          try {
            await sendEmailReport({ recipients, guildName: r.guildName, guildId: r.discordGuildId || "", date, report: reportPayload });
            console.log(`${guildLabel} [reDeliver] 이메일 발송 완료`);
          } catch (emailErr) {
            console.error(`${guildLabel} [reDeliver] 이메일 발송 실패:`, emailErr.message);
          }
        }
      }

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
