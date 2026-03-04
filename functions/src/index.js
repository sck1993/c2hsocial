const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { runPipeline, reDeliver } = require("./pipeline");
const { runAlertPipeline }       = require("./alertPipeline");
const { getChannelInfo, getGuildInfo } = require("./collectors/discord");
const { sendEmailReport, appendToGoogleSheet } = require("./delivery");

admin.initializeApp();

// 모든 함수 기본 리전: 서울
setGlobalOptions({ region: "asia-northeast3" });

// ═══════════════════════════════════════════════════════
//  HTTP API  —  /api/*
//  모든 관리 엔드포인트를 단일 함수로 묶어 Cold Start 최소화
// ═══════════════════════════════════════════════════════
exports.api = onRequest(
  { timeoutSeconds: 540, memory: "512MiB", invoker: "public" },
  async (req, res) => {
    // CORS 허용 (개발 편의)
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH");
      res.set("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
      return res.status(204).send("");
    }

    const path = req.path;

    // ── GET /ping ── 헬스 체크
    if (req.method === "GET" && path === "/ping") {
      return res.json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // ── 이하 모든 엔드포인트는 Admin Secret 필요 ──
    if (req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // ── POST /alert/trigger ── 위기알림 파이프라인 수동 실행
    if (req.method === "POST" && path === "/alert/trigger") {
      try {
        const { workspaceId, guildId } = req.body || {};
        const results = await runAlertPipeline(workspaceId || null, guildId || null);
        return res.json({ success: true, results });
      } catch (err) {
        console.error("[/alert/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /trigger ── 파이프라인 수동 실행 (테스트용)
    if (req.method === "POST" && path === "/trigger") {
      try {
        const results = await runPipeline();
        return res.json({ success: true, results });
      } catch (err) {
        console.error("[/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /report/trigger ── 특정 날짜 리포트 수동 재실행 + 발송
    if (req.method === "POST" && path === "/report/trigger") {
      const { workspaceId, date } = req.body || {};
      if (!workspaceId || !date) {
        return res.status(400).json({ error: "workspaceId, date 필수" });
      }
      try {
        const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0]; // KST
        if (date === today) {
          // 오늘: 파이프라인 전체 재실행 (메시지 수집 → 분석 → 저장 → 발송)
          const results = await runPipeline(workspaceId);
          return res.json({ success: true, mode: "full", results });
        } else {
          // 과거 날짜: 기존 리포트로 발송만 재실행
          const results = await reDeliver(workspaceId, date);
          return res.json({ success: true, mode: "redeliver", results });
        }
      } catch (err) {
        console.error("[/report/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /report ── 리포트 조회 (길드 단위)
    if (req.method === "GET" && path === "/report") {
      try {
        const db = admin.firestore();
        const workspaceId = req.query.workspaceId || "ws_antigravity";
        const date = req.query.date || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0]; // KST

        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("reports").doc(date)
          .collection("guilds")
          .get();

        if (snap.empty) {
          return res.json({ date, guilds: [], message: "리포트 없음" });
        }

        const guilds = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return res.json({ date, guilds });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /seed ── 초기 워크스페이스 + 채널 데이터 생성
    if (req.method === "POST" && path === "/seed") {
      try {
        const result = await seedWorkspace(req.body);
        return res.json({ success: true, result });
      } catch (err) {
        console.error("[/seed] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /guild ── Discord 서버 정보 조회 (서버명)
    if (req.method === "GET" && path === "/guild") {
      const { guildId } = req.query;
      if (!guildId) return res.status(400).json({ error: "guildId 필수" });
      try {
        const info = await getGuildInfo(guildId);
        return res.json(info);
      } catch (e) {
        return res.status(400).json({ error: "서버 정보를 불러올 수 없습니다." });
      }
    }

    // ── GET /channels ── 구독 채널 목록 조회
    if (req.method === "GET" && path === "/channels") {
      try {
        const db = admin.firestore();
        const workspaceId = req.query.workspaceId || "ws_antigravity";
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("subscribed_channels")
          .orderBy("createdAt", "asc")
          .get();
        const channels = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
        return res.json({ channels });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /channels ── 채널 추가 (Discord API로 채널 정보 검증)
    if (req.method === "POST" && path === "/channels") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", guildId, channelId } = req.body;

        if (!channelId) {
          return res.status(400).json({ error: "channelId 필수" });
        }

        // Discord API로 채널 정보 검증
        let channelInfo;
        try {
          channelInfo = await getChannelInfo(channelId);
        } catch (e) {
          return res.status(400).json({ error: "채널을 찾을 수 없습니다. 채널 ID를 확인하거나 봇이 해당 서버에 초대되었는지 확인하세요." });
        }

        // guildId가 제공된 경우 일치 여부 검증
        if (guildId && channelInfo.guildId !== guildId) {
          return res.status(400).json({ error: "서버 ID와 채널 ID가 일치하지 않습니다." });
        }

        // Guild 이름 조회 (탭 이름 생성용)
        let guildName = "";
        try {
          const guildInfo = await getGuildInfo(channelInfo.guildId);
          guildName = guildInfo.name || "";
        } catch (_) {}

        const channelDocId = `discord_${channelId}`;
        const chRef = db
          .collection("workspaces").doc(workspaceId)
          .collection("subscribed_channels").doc(channelDocId);

        const existing = await chRef.get();
        if (existing.exists) {
          return res.status(409).json({ error: "이미 등록된 채널입니다." });
        }

        await chRef.set({
          platform: "discord",
          channelName: channelInfo.name,
          discordChannelId: channelId,
          discordGuildId: channelInfo.guildId,
          guildName,
          isActive: true,
          importance: "normal",
          customPrompt: "",
          alertConfig: {
            isEnabled: false,
            triggerKeywords: [],
            negativeThreshold: 60,
            notifyWebhookUrl: "",
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.json({ success: true, docId: channelDocId, channelName: channelInfo.name });
      } catch (err) {
        console.error("[POST /channels] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /channels ── 채널 활성화/비활성화 토글
    if (req.method === "PATCH" && path === "/channels") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", docId } = req.query;
        const { isActive } = req.body;

        if (!docId) return res.status(400).json({ error: "docId 필수" });

        await db
          .collection("workspaces").doc(workspaceId)
          .collection("subscribed_channels").doc(docId)
          .update({ isActive: Boolean(isActive) });

        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /channels/settings ── 채널 설정 업데이트
    if (req.method === "PATCH" && path === "/channels/settings") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", docId } = req.query;
        const { customPrompt, alertConfig, importance } = req.body;

        if (!docId) return res.status(400).json({ error: "docId 필수" });

        const updates = {};
        if (customPrompt !== undefined) updates.customPrompt = customPrompt;
        if (alertConfig  !== undefined) updates.alertConfig  = alertConfig;
        if (importance   !== undefined) {
          if (!["low", "normal", "high"].includes(importance)) {
            return res.status(400).json({ error: "importance는 low/normal/high 중 하나여야 합니다." });
          }
          updates.importance = importance;
        }

        if (!Object.keys(updates).length) {
          return res.status(400).json({ error: "변경할 필드 없음" });
        }

        await db
          .collection("workspaces").doc(workspaceId)
          .collection("subscribed_channels").doc(docId)
          .update(updates);

        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /guilds ── 길드 목록 + deliveryConfig 조회
    if (req.method === "GET" && path === "/guilds") {
      try {
        const db = admin.firestore();
        const workspaceId = req.query.workspaceId || "ws_antigravity";
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("guilds")
          .get();
        const guilds = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
        return res.json({ guilds });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /guilds/settings ── 길드 deliveryConfig 업데이트
    if (req.method === "PATCH" && path === "/guilds/settings") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", docId } = req.query;
        const { deliveryConfig, guildName, discordGuildId, summaryPrompt } = req.body;

        if (!docId) return res.status(400).json({ error: "docId 필수" });

        const updates = {};
        if (deliveryConfig  !== undefined) updates.deliveryConfig  = deliveryConfig;
        if (guildName       !== undefined) updates.guildName       = guildName;
        if (discordGuildId  !== undefined) updates.discordGuildId  = discordGuildId;
        if (summaryPrompt   !== undefined) updates.summaryPrompt   = summaryPrompt;

        await db
          .collection("workspaces").doc(workspaceId)
          .collection("guilds").doc(docId)
          .set(updates, { merge: true });

        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /channels ── 채널 삭제
    if (req.method === "DELETE" && path === "/channels") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", docId } = req.query;

        if (!docId) return res.status(400).json({ error: "docId 필수" });

        await db
          .collection("workspaces").doc(workspaceId)
          .collection("subscribed_channels").doc(docId)
          .delete();

        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /guilds/test-delivery ── 이메일/시트 연동 테스트 (목업 데이터 발송)
    if (req.method === "POST" && path === "/guilds/test-delivery") {
      try {
        const { guildName = "테스트 서버", type, config } = req.body;

        const mockReport = {
          summary: "이것은 Social Listener 연동 테스트를 위한 샘플 리포트입니다. 실제 운영 시에는 Discord 채널 메시지를 기반으로 AI가 생성합니다.",
          sentiment: { positive: 65, neutral: 25, negative: 10 },
          keywords: ["테스트", "샘플", "연동확인", "소셜리스너", "디스코드"],
          issues: [
            { title: "샘플 이슈: 테스트 오류 제보", description: "이것은 연동 테스트용 샘플 이슈입니다. 실제 이슈가 아닙니다.", count: 3, channel: "general" },
          ],
          channels: [
            {
              channelDocId: "discord_test_sample",
              channelName: "general",
              importance: "normal",
              messageCount: 42,
              summary: "테스트 채널 요약입니다. 유저들이 활발하게 대화 중입니다.",
              sentiment: { positive: 60, neutral: 30, negative: 10 },
              keywords: ["테스트", "샘플"],
            },
            {
              channelDocId: "discord_test_sample2",
              channelName: "bug-report",
              importance: "high",
              messageCount: 7,
              summary: "버그 제보 채널 테스트 요약입니다. 실제 이슈가 없습니다.",
              sentiment: { positive: 20, neutral: 40, negative: 40 },
              keywords: ["버그", "테스트"],
            },
          ],
          messageCount: 49,
          isAlertTriggered: false,
        };

        const today = new Date().toISOString().split("T")[0];

        if (type === "email") {
          const recipients = config?.recipients || [];
          if (!recipients.length) return res.status(400).json({ error: "수신자 이메일을 입력하세요." });
          await sendEmailReport({ recipients, guildName, date: today, report: mockReport });
          return res.json({ success: true });
        }

        if (type === "sheets") {
          const spreadsheetUrl = config?.spreadsheetUrl || "";
          if (!spreadsheetUrl) return res.status(400).json({ error: "스프레드시트 URL을 입력하세요." });
          await appendToGoogleSheet({ spreadsheetUrl, guildName, date: today, report: mockReport });
          return res.json({ success: true });
        }

        return res.status(400).json({ error: "type은 email 또는 sheets 중 하나여야 합니다." });
      } catch (err) {
        console.error("[/guilds/test-delivery] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /data/logs ── 오늘치 수집 로그 타임라인 조회
    if (req.method === "GET" && path === "/data/logs") {
      try {
        const db = admin.firestore();
        const workspaceId = req.query.workspaceId || "ws_antigravity";
        const targetDate  = req.query.date ||
          new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0]; // KST 오늘

        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("collection_logs")
          .where("date", "==", targetDate)
          .orderBy("collectedAt", "asc")
          .get();

        const logs = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
          collectedAt: d.data().collectedAt?.toDate().toISOString() ?? null,
        }));

        return res.json({ logs, date: targetDate });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /channels/reset ── 채널 수집 데이터 초기화
    if (req.method === "POST" && path === "/channels/reset") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", docId } = req.query;

        if (!docId) return res.status(400).json({ error: "docId 필수" });

        const wsRef = db.collection("workspaces").doc(workspaceId);

        // 1. lastCollectedSnowflake 필드 삭제 → 다음 수집 시 오늘 0시부터 재수집
        await wsRef.collection("subscribed_channels").doc(docId)
          .update({ lastCollectedSnowflake: admin.firestore.FieldValue.delete() });

        // 2. collected_chunks 일괄 삭제 (channelDocId 기준, 500개씩 배치)
        let chunksDeleted = 0;
        let chunksSnap;
        do {
          chunksSnap = await wsRef.collection("collected_chunks")
            .where("channelDocId", "==", docId)
            .limit(500)
            .get();
          if (!chunksSnap.empty) {
            const batch = db.batch();
            chunksSnap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            chunksDeleted += chunksSnap.docs.length;
          }
        } while (!chunksSnap.empty);

        // 3. collection_logs 일괄 삭제 (channelDocId 기준, 500개씩 배치)
        let logsDeleted = 0;
        let logsSnap;
        do {
          logsSnap = await wsRef.collection("collection_logs")
            .where("channelDocId", "==", docId)
            .limit(500)
            .get();
          if (!logsSnap.empty) {
            const batch = db.batch();
            logsSnap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            logsDeleted += logsSnap.docs.length;
          }
        } while (!logsSnap.empty);

        console.log(`[/channels/reset] 완료 — ${workspaceId}/${docId}: chunks=${chunksDeleted}, logs=${logsDeleted}`);
        return res.json({ success: true, deleted: { chunks: chunksDeleted, logs: logsDeleted } });
      } catch (err) {
        console.error("[/channels/reset] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(404).json({ error: "Not found" });
  }
);

// ═══════════════════════════════════════════════════════
//  Cloud Scheduler  —  매 2시간 (증분 수집 + 위기 감지)
// ═══════════════════════════════════════════════════════
exports.alertPipeline = onSchedule(
  { schedule: "0 */2 * * *", timeoutSeconds: 300, memory: "512MiB" },
  async () => {
    console.log("[alertPipeline] 스케줄 실행 시작");
    await runAlertPipeline();
    console.log("[alertPipeline] 스케줄 실행 완료");
  }
);

// ═══════════════════════════════════════════════════════
//  Cloud Scheduler  —  매일 UTC 00:00 (KST 09:00) 실행
// ═══════════════════════════════════════════════════════
exports.dailyPipeline = onSchedule(
  { schedule: "0 0 * * *", timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    console.log("[dailyPipeline] 스케줄 실행 시작");
    await runPipeline();
    console.log("[dailyPipeline] 스케줄 실행 완료");
  }
);

// ═══════════════════════════════════════════════════════
//  내부 함수: 워크스페이스 + 채널 Firestore 초기 데이터 생성
// ═══════════════════════════════════════════════════════
async function seedWorkspace(body = {}) {
  const db = admin.firestore();

  const workspaceId    = body.workspaceId    || "ws_antigravity";
  const companyName    = body.companyName    || "ANTIGRAVITY";
  const billingEmail   = body.billingEmail   || "admin@antigravity.com";
  const guildId        = body.guildId        || "1452534795488989349";
  const channelId      = body.channelId      || "1452534796403343362";
  const channelName    = body.channelName    || "general";
  const customPrompt   = body.customPrompt   || "";

  // 워크스페이스 문서
  const wsRef = db.collection("workspaces").doc(workspaceId);
  await wsRef.set(
    {
      companyName,
      billingEmail,
      baseMonthlyFee: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // 구독 채널 문서
  const channelDocId = `discord_${channelId}`;
  const chRef = wsRef.collection("subscribed_channels").doc(channelDocId);
  await chRef.set(
    {
      platform: "discord",
      channelName,
      discordChannelId: channelId,
      discordGuildId: guildId,
      isActive: true,
      importance: "normal",
      customPrompt,
      alertConfig: {
        isEnabled: false,
        triggerKeywords: [],
        negativeThreshold: 60,
        notifyWebhookUrl: "",
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(`[seed] 완료 — workspace: ${workspaceId}, channel: ${channelDocId}`);
  return { workspaceId, channelDocId };
}
