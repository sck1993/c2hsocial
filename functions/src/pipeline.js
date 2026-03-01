const admin = require("firebase-admin");
const axios  = require("axios");
const { fetchChannelMessages }               = require("./collectors/discord");
const { analyzeMessages }                    = require("./analyzers/openrouter");
const { sendEmailReport, appendToGoogleSheet } = require("./delivery");

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4시간

/**
 * 전체 파이프라인 실행.
 * Firestore의 모든 활성 워크스페이스 → 활성 Discord 채널을 순회하며
 * 메시지 수집 → AI 분석 → 위기 감지 → 리포트/사용량 저장.
 *
 * @returns {Promise<{processed, skipped, errors}>}
 */
async function runPipeline() {
  const db = admin.firestore();
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD (UTC)
  const results = { processed: 0, skipped: 0, errors: 0 };

  console.log(`[pipeline] 시작 — ${today}`);

  const workspacesSnap = await db.collection("workspaces").get();

  for (const wsDoc of workspacesSnap.docs) {
    const workspaceId = wsDoc.id;

    // 활성 Discord 채널만 조회
    const channelsSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("subscribed_channels")
      .where("isActive", "==", true)
      .where("platform", "==", "discord")
      .get();

    if (channelsSnap.empty) {
      console.log(`[pipeline] ${workspaceId} — 활성 채널 없음, 스킵`);
      continue;
    }

    for (const chDoc of channelsSnap.docs) {
      const ch = chDoc.data();
      const channelDocId = chDoc.id;
      const label = `[${workspaceId}/${channelDocId}]`;

      try {
        // ── 1. 메시지 수집 ──────────────────────────────
        console.log(`${label} 수집 시작 (discordChannelId: ${ch.discordChannelId})`);
        const messages = await fetchChannelMessages(ch.discordChannelId, 24);

        if (messages.length === 0) {
          console.log(`${label} 메시지 없음 — 스킵`);
          results.skipped++;
          continue;
        }
        console.log(`${label} ${messages.length}개 메시지 수집 완료`);

        // ── 2. AI 분석 ──────────────────────────────────
        console.log(`${label} AI 분석 중...`);
        const { report, usage } = await analyzeMessages(
          messages,
          ch.channelName,
          ch.customPrompt || ""
        );
        console.log(`${label} AI 분석 완료 (tokens: ${usage?.total_tokens ?? 0})`);

        // ── 3. 위기 감지 판정 ────────────────────────────
        let isAlertTriggered = false;
        const alertConfig = ch.alertConfig || {};

        if (alertConfig.isEnabled && alertConfig.notifyWebhookUrl) {
          const negative    = report.sentiment?.negative ?? 0;
          const threshold   = alertConfig.negativeThreshold ?? 60;
          const keywords    = alertConfig.triggerKeywords || [];

          const thresholdMet = negative >= threshold;

          // 메시지 전문에서 키워드 검색
          const fullText = messages.map((m) => m.content).join(" ").toLowerCase();
          const matchedKeywords = keywords.filter((kw) =>
            fullText.includes(kw.toLowerCase())
          );
          const keywordMet = matchedKeywords.length > 0;

          if (thresholdMet || keywordMet) {
            // 쿨타임 체크 (채널당 4시간)
            const lastAlert = ch.lastAlertAt?.toDate ? ch.lastAlertAt.toDate() : null;
            const cooldownOk = !lastAlert || Date.now() - lastAlert.getTime() > ALERT_COOLDOWN_MS;

            if (cooldownOk) {
              try {
                await sendAlertWebhook(alertConfig.notifyWebhookUrl, {
                  channelName: ch.channelName,
                  negative,
                  threshold,
                  matchedKeywords,
                  workspaceId,
                  channelDocId,
                });
                isAlertTriggered = true;

                // 쿨타임 갱신
                await chDoc.ref.update({
                  lastAlertAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                console.log(`${label} 위기 알림 발송 완료 (neg: ${negative}%, keywords: ${matchedKeywords})`);
              } catch (webhookErr) {
                console.error(`${label} 웹훅 발송 실패:`, webhookErr.message);
              }
            } else {
              console.log(`${label} 위기 감지됐으나 쿨타임 중 — 알림 생략`);
            }
          }
        }

        // ── 4. 리포트 저장 ──────────────────────────────
        const reportRef = db
          .collection("workspaces").doc(workspaceId)
          .collection("reports").doc(today)
          .collection("channels").doc(channelDocId);

        await reportRef.set({
          platform: "discord",
          channelName: ch.channelName,
          discordChannelId: ch.discordChannelId,
          messageCount: messages.length,
          summary: report.summary || "",
          custom_answer: report.custom_answer || "",
          sentiment: report.sentiment || {},
          keywords: report.keywords || [],
          issues: report.issues || [],
          isAlertTriggered,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // ── 5. 사용량 로그 ──────────────────────────────
        await db
          .collection("workspaces").doc(workspaceId)
          .collection("usage_logs")
          .add({
            date: today,
            channelDocId,
            platform: "discord",
            messageCount: messages.length,
            promptTokens: usage?.prompt_tokens || 0,
            completionTokens: usage?.completion_tokens || 0,
            totalTokens: usage?.total_tokens || 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

        // ── 6. 리포트 전달 (이메일 + 구글 시트) ──────────
        const deliveryConfig = ch.deliveryConfig || {};
        const emailCfg       = deliveryConfig.email        || {};
        const sheetsCfg      = deliveryConfig.googleSheets || {};
        const reportPayload  = {
          summary:         report.summary       || "",
          custom_answer:   report.custom_answer || "",
          sentiment:       report.sentiment      || {},
          keywords:        report.keywords       || [],
          issues:          report.issues         || [],
          messageCount:    messages.length,
          isAlertTriggered,
        };

        // 6a. 이메일 발송
        if (emailCfg.isEnabled) {
          const recipients = emailCfg.recipients || [];
          if (recipients.length > 0) {
            try {
              await sendEmailReport({
                recipients,
                channelName: ch.channelName,
                guildName:   ch.guildName || "",
                date:        today,
                report:      reportPayload,
              });
              console.log(`${label} 이메일 발송 완료 (${recipients.length}명)`);
            } catch (emailErr) {
              console.error(`${label} 이메일 발송 실패:`, emailErr.message);
            }
          } else {
            console.log(`${label} 이메일 수신자 없음 — 발송 생략`);
          }
        }

        // 6b. 구글 시트 기록
        if (sheetsCfg.isEnabled && sheetsCfg.spreadsheetUrl) {
          try {
            await appendToGoogleSheet({
              spreadsheetUrl: sheetsCfg.spreadsheetUrl,
              channelName:    ch.channelName,
              guildName:      ch.guildName || "",
              date:           today,
              report:         reportPayload,
            });
            console.log(`${label} 구글 시트 기록 완료`);
          } catch (sheetErr) {
            console.error(`${label} 구글 시트 기록 실패:`, sheetErr.message);
          }
        }

        console.log(`${label} 저장 완료 (alert: ${isAlertTriggered})`);
        results.processed++;

      } catch (err) {
        const detail = err.response?.data
          ? JSON.stringify(err.response.data)
          : err.message;
        console.error(`${label} 오류:`, detail);
        results.errors++;
      }
    }
  }

  console.log("[pipeline] 완료 —", results);
  return results;
}

/**
 * 위기 알림 웹훅 발송.
 * Discord Webhook이면 임베드 메시지, 일반 URL이면 JSON payload.
 */
async function sendAlertWebhook(url, { channelName, negative, threshold, matchedKeywords, workspaceId }) {
  const isDiscord = url.includes("discord.com/api/webhooks");

  if (isDiscord) {
    const lines = [
      `🚨 **위기 감지 알림** — \`#${channelName}\``,
      ``,
      `부정 감정: **${negative}%** (임계치: ${threshold}%)`,
    ];
    if (matchedKeywords.length) {
      lines.push(`감지된 키워드: **${matchedKeywords.join(", ")}**`);
    }
    lines.push(``, `워크스페이스: \`${workspaceId}\``);

    await axios.post(url, { content: lines.join("\n") });
  } else {
    await axios.post(url, {
      event: "crisis_alert",
      channelName,
      negative,
      threshold,
      matchedKeywords,
      workspaceId,
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = { runPipeline };
