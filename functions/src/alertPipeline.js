"use strict";

const admin = require("firebase-admin");
const axios  = require("axios");
const { fetchChannelMessages } = require("./collectors/discord");

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4시간
const CHUNK_TTL_MS      = 48 * 60 * 60 * 1000; // 48시간
const MAX_BATCHES       = 30; // 배치당 최대 50페이지 × 최대 30배치 = 채널당 최대 150,000개

/**
 * 2시간마다 실행되는 증분 수집 파이프라인.
 * - 채널별 lastCollectedSnowflake 이후 새 메시지만 수집
 * - MAX_PAGES(50) 도달 시 hitMaxPages=true → 다음 배치 즉시 수집 (배치 루프)
 * - collected_chunks 컬렉션에 배치별 청크 저장 (expireAt = +48h, Firestore TTL 자동 삭제)
 * - 위기 키워드 감지 → 웹훅 알림
 *
 * @param {string|null} filterWorkspaceId - 지정 시 해당 워크스페이스만 처리
 * @param {string|null} filterGuildId     - 지정 시 해당 길드만 처리
 * @returns {Promise<{collected, alerted, errors}>}
 */
// KST(UTC+9) 기준 오늘 날짜 문자열 반환
function getKSTDateString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

// KST 기준 오늘 자정(00:00 KST)의 UTC 타임스탬프(ms) 반환
function getKSTMidnightMs(kstDateStr) {
  return new Date(kstDateStr + "T00:00:00+09:00").getTime();
}

// UTC 타임스탬프(ms)를 KST 날짜 문자열(YYYY-MM-DD)로 변환
function getKSTDateFromMs(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

async function runAlertPipeline(filterWorkspaceId = null, filterGuildId = null) {
  const db = admin.firestore();
  const today = getKSTDateString(); // YYYY-MM-DD (KST)
  const runId = new Date().toISOString(); // 이번 실행 식별자 (collection_logs 그룹핑용)
  const results = { collected: 0, alerted: 0, errors: 0 };

  console.log(`[alertPipeline] 시작 — ${new Date().toISOString()}${filterWorkspaceId ? ` (워크스페이스: ${filterWorkspaceId})` : ""}${filterGuildId ? ` (길드: ${filterGuildId})` : ""}`);

  let workspacesSnap;
  if (filterWorkspaceId) {
    const wsDoc = await db.collection("workspaces").doc(filterWorkspaceId).get();
    workspacesSnap = { docs: wsDoc.exists ? [wsDoc] : [] };
  } else {
    workspacesSnap = await db.collection("workspaces").get();
  }

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;

    let channelsQuery = db
      .collection("workspaces").doc(workspaceId)
      .collection("subscribed_channels")
      .where("isActive", "==", true)
      .where("platform", "==", "discord");

    if (filterGuildId) {
      channelsQuery = channelsQuery.where("discordGuildId", "==", filterGuildId);
    }

    const channelsSnap = await channelsQuery.get();

    if (channelsSnap.empty) {
      console.log(`[alertPipeline] ${workspaceId} — 활성 채널 없음, 스킵`);
      continue;
    }

    for (const chDoc of channelsSnap.docs) {
      const ch           = chDoc.data();
      const channelDocId = chDoc.id;
      const chLabel      = `[${workspaceId}/${channelDocId}]`;

      try {
        // 초기 설정: lastCollectedSnowflake 이후 증분 수집, 최초엔 KST 자정부터
        const isInitial      = !ch.lastCollectedSnowflake; // 로그 type 판별용 (배치 전 캡처)
        let currentSnowflake = ch.lastCollectedSnowflake || null;
        let hoursBack = 2; // afterSnowflake가 있을 때는 fetchChannelMessages 내부에서 무시됨

        if (!currentSnowflake) {
          const kstMidnightMs = getKSTMidnightMs(today);
          hoursBack = (Date.now() - kstMidnightMs) / (60 * 60 * 1000);
          console.log(`${chLabel} 수집 시작 (최초 — KST 자정부터 ${hoursBack.toFixed(1)}시간치)`);
        } else {
          console.log(`${chLabel} 수집 시작 (증분 — snowflake: ${currentSnowflake})`);
        }

        let channelCollected        = false; // 채널 단위 collected 카운트 중복 방지
        let channelAlerted          = false; // 채널 단위 alerted 카운트 중복 방지
        let totalMessagesCollected  = 0;     // 배치 전체 합산 메시지 수 (로그용)

        // ── 배치 루프: hitMaxPages=true이면 다음 배치 즉시 수집 ──────────────
        for (let batchIdx = 0; batchIdx < MAX_BATCHES; batchIdx++) {
          let fetchResult;
          try {
            fetchResult = await fetchChannelMessages(ch.discordChannelId, hoursBack, currentSnowflake);
          } catch (fetchErr) {
            console.error(`${chLabel} 수집 실패 (배치 ${batchIdx + 1}):`, fetchErr.message);
            if (!channelCollected) results.errors++;
            break;
          }

          const { messages, hitMaxPages, lastRawId } = fetchResult;

          if (messages.length === 0) {
            if (batchIdx === 0) console.log(`${chLabel} 새 메시지 없음`);
            break;
          }

          const batchSuffix = batchIdx > 0 ? ` [배치 ${batchIdx + 1}]` : "";
          console.log(`${chLabel}${batchSuffix} ${messages.length}개 메시지 수집`);
          totalMessagesCollected += messages.length;

          // 위기 감지 (배치마다 수행, 채널당 최초 감지만 alerted 카운트)
          const alertTriggered = await checkAndSendAlert(db, chDoc, ch, messages, workspaceId, channelDocId);
          if (alertTriggered && !channelAlerted) {
            results.alerted++;
            channelAlerted = true;
          }

          // 청크 저장
          const now      = Date.now();
          const expireAt = new Date(now + CHUNK_TTL_MS);
          const chunkDocId = `${channelDocId}_${now}`;

          // windowStart를 ms로 계산 → 메시지가 속하는 KST 날짜 파생
          const windowStartMs = currentSnowflake
            ? now - 2 * 60 * 60 * 1000  // 증분: 약 2시간 전
            : getKSTMidnightMs(today);   // 최초: KST 자정
          const windowStart = new Date(windowStartMs).toISOString();
          const chunkDate   = getKSTDateFromMs(windowStartMs); // 메시지 기준 KST 날짜

          await db
            .collection("workspaces").doc(workspaceId)
            .collection("collected_chunks")
            .doc(chunkDocId)
            .set({
              channelDocId,
              discordChannelId: ch.discordChannelId || "",
              discordGuildId:   ch.discordGuildId   || "",
              guildName:        ch.guildName        || "",
              channelName:      ch.channelName      || "",
              importance:       ch.importance       || "normal",
              customPrompt:     ch.customPrompt     || "",
              date:             chunkDate,
              windowStart,
              messages,
              messageCount:     messages.length,
              alertTriggered,
              collectedAt:      admin.firestore.FieldValue.serverTimestamp(),
              expireAt,
            });

          // lastCollectedSnowflake 업데이트 (오름차순 반환이라 마지막이 최신)
          const latestId = messages[messages.length - 1].id;
          await chDoc.ref.update({ lastCollectedSnowflake: latestId });

          console.log(`${chLabel}${batchSuffix} 청크 저장 완료 (lastSnowflake: ${latestId})`);

          if (!channelCollected) {
            results.collected++;
            channelCollected = true;
          }

          if (!hitMaxPages) break; // 더 이상 수집할 메시지 없음

          // 다음 배치: lastRawId 이후 메시지 수집 (봇 필터 전 마지막 ID → 커서)
          currentSnowflake = lastRawId;
          console.log(`${chLabel} 다음 배치 준비 (snowflake: ${currentSnowflake})`);
        }

        // ── collection_logs 기록 (채널당 1개, 배치 루프 완료 후) ──────────────
        if (channelCollected) {
          try {
            await db
              .collection("workspaces").doc(workspaceId)
              .collection("collection_logs")
              .add({
                runId,
                channelDocId,
                channelName:    ch.channelName    || "",
                discordGuildId: ch.discordGuildId || "",
                guildName:      ch.guildName      || "",
                type:           isInitial ? "initial" : "incremental",
                messageCount:   totalMessagesCollected,
                date:           today,
                collectedAt:    admin.firestore.FieldValue.serverTimestamp(),
              });
          } catch (logErr) {
            console.warn(`${chLabel} collection_logs 기록 실패 (무시):`, logErr.message);
          }
        }

      } catch (err) {
        console.error(`${chLabel} 오류:`, err.message);
        results.errors++;
      }
    }
  }

  console.log("[alertPipeline] 완료 —", results);
  return results;
}

/**
 * 채널별 위기 감지 및 웹훅 알림 (키워드 기반).
 * @returns {boolean} 알림 발송 여부
 */
async function checkAndSendAlert(db, chDoc, ch, messages, workspaceId, channelDocId) {
  const alertConfig = ch.alertConfig || {};
  if (!alertConfig.isEnabled || !alertConfig.notifyWebhookUrl) return false;
  if (messages.length === 0) return false;

  const fullText        = messages.map((m) => m.content).join(" ").toLowerCase();
  const keywords        = alertConfig.triggerKeywords || [];
  const matchedKeywords = keywords.filter((kw) => fullText.includes(kw.toLowerCase()));

  if (matchedKeywords.length === 0) return false;

  const lastAlert  = ch.lastAlertAt?.toDate ? ch.lastAlertAt.toDate() : null;
  const cooldownOk = !lastAlert || Date.now() - lastAlert.getTime() > ALERT_COOLDOWN_MS;

  if (!cooldownOk) {
    console.log(`[${workspaceId}/${channelDocId}] 키워드 감지됐으나 쿨타임 중 — 알림 생략`);
    return false;
  }

  try {
    await sendAlertWebhook(alertConfig.notifyWebhookUrl, {
      channelName:      ch.channelName,
      matchedKeywords,
      workspaceId,
      threshold:        alertConfig.negativeThreshold ?? 60,
    });
    await chDoc.ref.update({ lastAlertAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`[${workspaceId}/${channelDocId}] 키워드 알림 발송 완료 (${matchedKeywords})`);
    return true;
  } catch (webhookErr) {
    console.error(`[${workspaceId}/${channelDocId}] 웹훅 발송 실패:`, webhookErr.message);
    return false;
  }
}

/**
 * 위기 알림 웹훅 발송.
 */
async function sendAlertWebhook(url, { channelName, matchedKeywords, workspaceId, threshold }) {
  const isDiscord = url.includes("discord.com/api/webhooks");

  if (isDiscord) {
    const lines = [`🚨 **위기 감지 알림** — \`#${channelName}\``];
    if (matchedKeywords.length) lines.push(`감지된 키워드: **${matchedKeywords.join(", ")}**`);
    lines.push(``, `워크스페이스: \`${workspaceId}\``);
    await axios.post(url, { content: lines.join("\n") });
  } else {
    await axios.post(url, {
      event:           "crisis_alert",
      channelName,
      matchedKeywords,
      workspaceId,
      timestamp:       new Date().toISOString(),
    });
  }
}

module.exports = { runAlertPipeline };
