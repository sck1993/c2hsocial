const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { runPipeline } = require("./pipeline");
const { getChannelInfo, getGuildInfo } = require("./collectors/discord");

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

    // ── GET /report ── 최신 리포트 조회
    if (req.method === "GET" && path === "/report") {
      try {
        const db = admin.firestore();
        const workspaceId = req.query.workspaceId || "ws_antigravity";
        const date = req.query.date || new Date().toISOString().split("T")[0];

        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("reports").doc(date)
          .collection("channels")
          .get();

        if (snap.empty) {
          return res.json({ date, channels: [], message: "리포트 없음" });
        }

        const channels = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return res.json({ date, channels });
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
          customPrompt: "",
          alertConfig: {
            isEnabled: false,
            triggerKeywords: [],
            negativeThreshold: 60,
            notifyWebhookUrl: "",
          },
          deliveryConfig: {
            email:       { isEnabled: false, recipients: [] },
            naverworks:  { isEnabled: false },
            googleSheets:{ isEnabled: false, spreadsheetUrl: "" },
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

    // ── PATCH /channels/settings ── 채널 설정 업데이트 (customPrompt, alertConfig)
    if (req.method === "PATCH" && path === "/channels/settings") {
      try {
        const db = admin.firestore();
        const { workspaceId = "ws_antigravity", docId } = req.query;
        const { customPrompt, alertConfig, deliveryConfig } = req.body;

        if (!docId) return res.status(400).json({ error: "docId 필수" });

        const updates = {};
        if (customPrompt    !== undefined) updates.customPrompt    = customPrompt;
        if (alertConfig     !== undefined) updates.alertConfig     = alertConfig;
        if (deliveryConfig  !== undefined) updates.deliveryConfig  = deliveryConfig;

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

    return res.status(404).json({ error: "Not found" });
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
