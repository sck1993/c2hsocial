const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const { runPipeline, reDeliver } = require("./discordDailyPipeline");
const { runAlertPipeline }       = require("./discordAlertPipeline");
const { getChannelInfo, getGuildInfo } = require("./collectors/discordCollector");
const { sendEmailReport, appendToGoogleSheet } = require("./reportDelivery");
const { runInsightCollector } = require("./collectors/discordInsightCollector");
const { runWeeklyPipeline }   = require("./discordWeeklyPipeline");
const {
  listConnectedInstagramAccounts,
  refreshToken: refreshIgToken,
  debugToken: debugIgToken,
  fetchAllPosts: fetchAllIgFacebookPosts,
} = require("./collectors/instagramCollector");
const {
  debugIgDirectToken,
  refreshDirectToken,
  fetchAllPosts: fetchAllIgDirectPosts,
} = require("./collectors/instagramDirectCollector");
const { runInstagramPipeline, runInstagramEmailSender } = require("./instagramDailyPipeline");
const { runFacebookGroupPipeline, runFacebookGroupEmailSender } = require("./facebookGroupDailyPipeline");
const {
  loadSessionFromFirestore: loadFbSession,
  saveSessionToFirestore: saveFbSession,
  markSessionInvalid: markFbSessionInvalid,
  launchBrowser: launchFbBrowser,
  applyCookiesToContext: applyFbCookies,
  verifySessionAlive: verifyFbSessionAlive,
} = require("./collectors/facebookGroupCollector");
const { runNaverLoungePipeline, runNaverLoungeEmailSender } = require("./naverLoungeDailyPipeline");
const { runReportPresetPipeline } = require("./reportPresetDailyPipeline");
const {
  loadSessionFromFirestore: loadNlSession,
  saveSessionToFirestore: saveNlSession,
} = require("./collectors/naverLoungeCollector");

admin.initializeApp();

// 모든 함수 기본 리전: 서울
setGlobalOptions({ region: "asia-northeast3" });

/** workspaceId 미제공 시 기본값 사용 + warn 로그 */
function resolveWorkspaceId(value, fallback = "ws_antigravity") {
  if (!value) {
    console.warn("[API] workspaceId 미제공 — 기본값 사용:", fallback);
    return fallback;
  }
  return value;
}

const IG_PERFORMANCE_REVIEW_MODELS = new Set([
  "google/gemini-3-flash-preview",
  "openai/gpt-5.4-mini",
  "google/gemini-3.1-flash-lite-preview",
]);
const FB_ANALYSIS_MODELS = new Set([
  "openai/gpt-5.4-mini",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite-preview",
]);
const NL_ANALYSIS_MODELS = new Set([
  "openai/gpt-5.4-mini",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite-preview",
]);
const DEFAULT_IG_PERFORMANCE_REVIEW_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_IG_POST_COMMENT_PROMPT = `당신은 Instagram 콘텐츠 분석가입니다.
이메일 리포트의 게시물 표 아래에 붙일 아주 짧은 코멘트 1~2문장만 작성하세요.
반드시 아래 원칙을 지키세요.
- 게시물 내용, 실제 댓글 반응, 성과 지표를 함께 반영
- 최근 1주 전체 게시물 맥락과 비교해 상대적인 위치를 짚어도 좋습니다
- 과장하거나 단정하지 말고 관찰 기반으로 작성
- 댓글이 거의 없으면 댓글 반응이 아직 제한적이라는 점을 자연스럽게 언급
- 표에 이미 숫자가 나오므로 조회수, 댓글수, 참여율 같은 구체적인 숫자를 반복해서 쓰지 마세요
- 대신 이번 기간 중 상위권 반응, 평균 대비 강함/약함, 저장/공유 중심, 댓글 대화 중심 같은 비교형 표현을 우선 사용하세요
- 마크다운, HTML, 이모지, 따옴표 없이 순수 텍스트만 출력
- 120자 안팎의 짧은 한국어 코멘트로 작성`;

// ═══════════════════════════════════════════════════════
//  HTTP API  —  /api/*
//  모든 관리 엔드포인트를 단일 함수로 묶어 Cold Start 최소화
// ═══════════════════════════════════════════════════════
exports.api = onRequest(
  { timeoutSeconds: 800, memory: "2GiB", invoker: "public" },
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
    if (req.headers["x-admin-secret"] !== (process.env.ADMIN_SECRET || "").trim()) {
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
          const targetDate = new Date(Date.now() + 9 * 60 * 60 * 1000 - 86400000).toISOString().split("T")[0]; // KST 어제
          return res.json({ success: true, mode: "full", targetDate, results });
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

    // ── GET /available-dates ── 데이터가 존재하는 날짜 목록
    if (req.method === "GET" && path === "/available-dates") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const type = req.query.type || "daily"; // "daily" | "weekly"

        const colName = type === "weekly" ? "weekly_reports" : "reports";
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection(colName)
          .select() // 문서 필드 미로드, doc ID만 조회 (비용 절감)
          .get();

        const dates = snap.docs.map(d => d.id).sort().reverse();
        return res.json({ type, dates });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /report ── 리포트 조회 (길드 단위)
    if (req.method === "GET" && path === "/report") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
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
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
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
        const { workspaceId: _wsId0, guildId, channelId } = req.body;
        const workspaceId = resolveWorkspaceId(_wsId0);

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
          channelType: channelInfo.type,
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
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const { isActive } = req.body;

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
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const { customPrompt, alertConfig, importance } = req.body;

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
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
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
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const { deliveryConfig, guildName, discordGuildId, summaryPrompt, discordUserToken } = req.body;

        const updates = {};
        if (deliveryConfig !== undefined) {
          if (typeof deliveryConfig !== 'object' || deliveryConfig === null || Array.isArray(deliveryConfig)) {
            return res.status(400).json({ error: 'deliveryConfig는 객체여야 합니다' });
          }
          updates.deliveryConfig = deliveryConfig;
        }
        if (guildName       !== undefined) updates.guildName       = guildName;
        if (discordGuildId  !== undefined) updates.discordGuildId  = discordGuildId;
        if (summaryPrompt   !== undefined) updates.summaryPrompt   = summaryPrompt;
        if (discordUserToken  !== undefined) updates.discordUserToken  = discordUserToken;

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
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

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
          summary: "이것은 AI Social Listening 연동 테스트를 위한 샘플 리포트입니다. 실제 운영 시에는 Discord 채널 메시지를 기반으로 AI가 생성합니다.",
          summary_en: "This is a sample report for AI Social Listening integration testing. In production, AI generates this based on Discord channel messages.",
          sentiment: { positive: 65, neutral: 25, negative: 10 },
          keywords: ["테스트", "샘플", "연동확인", "소셜리스너", "디스코드"],
          keywords_en: ["test", "sample", "integration", "social-listener", "discord"],
          issues: [
            {
              title: "샘플 이슈: 테스트 오류 제보", title_en: "Sample Issue: Test Error Report",
              description: "이것은 연동 테스트용 샘플 이슈입니다. 실제 이슈가 아닙니다.", description_en: "This is a sample issue for integration testing. Not a real issue.",
              count: 3, channel: "general",
            },
          ],
          channels: [
            {
              channelDocId: "discord_test_sample",
              channelName: "general",
              importance: "normal",
              messageCount: 42,
              summary: "테스트 채널 요약입니다. 유저들이 활발하게 대화 중입니다.",
              summary_en: "Test channel summary. Users are actively chatting.",
              sentiment: { positive: 60, neutral: 30, negative: 10 },
              keywords: ["테스트", "샘플"],
            },
            {
              channelDocId: "discord_test_sample2",
              channelName: "bug-report",
              importance: "high",
              messageCount: 7,
              summary: "버그 제보 채널 테스트 요약입니다. 실제 이슈가 없습니다.",
              summary_en: "Bug report channel test summary. No actual issues.",
              sentiment: { positive: 20, neutral: 40, negative: 40 },
              keywords: ["버그", "테스트"],
            },
          ],
          messageCount: 49,
          isAlertTriggered: false,
        };

        const today = new Date().toISOString().split("T")[0];

        if (type === "email-ko" || type === "email") {
          const recipients = config?.recipientsKo || config?.recipients || [];
          if (!recipients.length) return res.status(400).json({ error: "수신자 이메일을 입력하세요." });
          await sendEmailReport({ recipients, guildName, date: today, report: mockReport, lang: "ko" });
          return res.json({ success: true });
        }

        if (type === "email-en") {
          const recipients = config?.recipientsEn || config?.recipients || [];
          if (!recipients.length) return res.status(400).json({ error: "수신자 이메일을 입력하세요." });
          await sendEmailReport({ recipients, guildName, date: today, report: mockReport, lang: "en" });
          return res.json({ success: true });
        }

        if (type === "sheets") {
          const spreadsheetUrl = config?.spreadsheetUrl || "";
          if (!spreadsheetUrl) return res.status(400).json({ error: "스프레드시트 URL을 입력하세요." });
          await appendToGoogleSheet({ spreadsheetUrl, guildName, date: today, report: mockReport });
          return res.json({ success: true });
        }

        return res.status(400).json({ error: "type은 email-ko, email-en, 또는 sheets 중 하나여야 합니다." });
      } catch (err) {
        console.error("[/guilds/test-delivery] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /data/logs ── 오늘치 수집 로그 타임라인 조회
    if (req.method === "GET" && path === "/data/logs") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
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
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

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

    // ── POST /insights/trigger ── 인사이트 수동 수집
    if (req.method === "POST" && path === "/insights/trigger") {
      try {
        const { workspaceId } = req.body;
        const result = await runInsightCollector(workspaceId || null);
        return res.json({ success: true, result });
      } catch (err) {
        console.error("[/insights/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /weekly-report ── 주간 리포트 조회
    // weekly_reports가 없어도 weekly_insights + reports에서 차트 데이터를 직접 구성해 반환.
    // AI 요약(aiSummary, weeklyIssues)은 weekly_reports가 생성된 경우에만 포함됨.
    if (req.method === "GET" && path === "/weekly-report") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const weekStart   = req.query.weekStart;
        if (!weekStart) return res.status(400).json({ error: "weekStart 필수 (YYYY-MM-DD)" });

        // weekStart 포함 7일 날짜 배열
        const dates = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(weekStart + "T00:00:00Z");
          d.setUTCDate(d.getUTCDate() + i);
          return d.toISOString().split("T")[0];
        });
        const weekEnd = dates[6];
        const wsRef = db.collection("workspaces").doc(workspaceId);

        // 저장된 weekly_reports (aiSummary, weeklyIssues — 없어도 무관)
        const weeklySnap = await wsRef.collection("weekly_reports").doc(weekStart).collection("guilds").get();
        const weeklyMap = {};
        for (const doc of weeklySnap.docs) weeklyMap[doc.id] = doc.data();

        // 길드 목록
        const guildsSnap = await wsRef.collection("guilds").get();
        if (guildsSnap.empty) return res.json({ weekStart, guilds: [] });

        // 길드별 인사이트 + 감정 차트 구성 (병렬)
        const guilds = await Promise.all(guildsSnap.docs.map(async (guildDoc) => {
          const guild      = guildDoc.data();
          const guildDocId = guildDoc.id;
          const guildId    = guild.discordGuildId || guildDocId.replace(/^discord_/, "");

          // insightsChart: weekly_insights에서 직접 읽기 (매일 갱신됨)
          const insightsChart = await Promise.all(dates.map(date =>
            wsRef.collection("weekly_insights").doc(`${guildDocId}_${date}`).get()
              .then(snap => snap.exists
                ? { date, ...snap.data() }
                : { date, totalMembers: null, communicatingMembers: null, activeMembers: null,
                    newMembers: null, leavingMembers: null, messageCount: null })
          ));

          // sentimentChart: reports에서 읽기 (저장 키 = guildDocId = discord_XXXXX)
          const sentimentChart = await Promise.all(dates.map(date =>
            wsRef.collection("reports").doc(date).collection("guilds").doc(guildDocId).get()
              .then(snap => {
                const s = snap.exists ? (snap.data().sentiment || {}) : {};
                return { date, positive: s.positive ?? null, neutral: s.neutral ?? null, negative: s.negative ?? null };
              })
          ));

          const weeklyData = weeklyMap[guildDocId] || {};
          return {
            id:           guildDocId,
            guildName:    weeklyData.guildName || guild.guildName || guildDocId,
            guildId,
            weekStart,
            weekEnd,
            aiSummary:    weeklyData.aiSummary    || null,
            weeklyIssues: weeklyData.weeklyIssues || [],
            insightsChart,
            sentimentChart,
          };
        }));

        // 데이터가 하나라도 있는 길드만 반환
        const activeGuilds = guilds.filter(g =>
          g.insightsChart.some(d => d.totalMembers !== null) ||
          g.sentimentChart.some(d => d.positive !== null)    ||
          weeklyMap[g.id]
        );

        return res.json({ weekStart, guilds: activeGuilds });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /analytics ── 커스텀 기간 인사이트 + 감정 분석
    if (req.method === "GET" && path === "/analytics") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) return res.status(400).json({ error: "startDate, endDate 필수 (YYYY-MM-DD)" });

        const start    = new Date(startDate + "T00:00:00Z");
        const end      = new Date(endDate   + "T00:00:00Z");
        const diffDays = Math.round((end - start) / 86400000) + 1;
        if (diffDays < 1)   return res.status(400).json({ error: "종료일이 시작일보다 앞섬" });
        if (diffDays > 90)  return res.status(400).json({ error: "최대 90일 범위까지 조회 가능합니다" });

        const dates = Array.from({ length: diffDays }, (_, i) => {
          const d = new Date(start);
          d.setUTCDate(start.getUTCDate() + i);
          return d.toISOString().split("T")[0];
        });

        const wsRef      = db.collection("workspaces").doc(workspaceId);
        const guildsSnap = await wsRef.collection("guilds").get();
        if (guildsSnap.empty) return res.json({ startDate, endDate, guilds: [] });

        const guilds = await Promise.all(guildsSnap.docs.map(async (guildDoc) => {
          const guild      = guildDoc.data();
          const guildDocId = guildDoc.id;
          const guildId    = guild.discordGuildId || guildDocId.replace(/^discord_/, "");

          const insightsChart = await Promise.all(dates.map(date =>
            wsRef.collection("weekly_insights").doc(`${guildDocId}_${date}`).get()
              .then(snap => snap.exists
                ? { date, ...snap.data() }
                : { date, totalMembers: null, communicatingMembers: null, activeMembers: null,
                    newMembers: null, leavingMembers: null, messageCount: null })
          ));

          let reportGuildName = null;
          const sentimentChart = await Promise.all(dates.map(date =>
            wsRef.collection("reports").doc(date).collection("guilds").doc(guildDocId).get()
              .then(snap => {
                if (snap.exists) {
                  const data = snap.data();
                  if (!reportGuildName && data.guildName) reportGuildName = data.guildName;
                  const s = data.sentiment || {};
                  return { date, positive: s.positive ?? null, neutral: s.neutral ?? null, negative: s.negative ?? null };
                }
                return { date, positive: null, neutral: null, negative: null };
              })
          ));

          return {
            id:        guildDocId,
            guildName: guild.guildName || reportGuildName || guildDocId,
            guildId,
            insightsChart,
            sentimentChart,
          };
        }));

        const activeGuilds = guilds.filter(g =>
          g.insightsChart.some(d => d.totalMembers !== null) ||
          g.sentimentChart.some(d => d.positive !== null)
        );

        return res.json({ startDate, endDate, guilds: activeGuilds });
      } catch (err) {
        console.error("[/analytics] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /weekly-report/trigger ── 주간 리포트 수동 생성
    if (req.method === "POST" && path === "/weekly-report/trigger") {
      try {
        const { workspaceId, weekStart } = req.body;
        await runWeeklyPipeline(workspaceId || null, weekStart || null);
        return res.json({ success: true });
      } catch (err) {
        console.error("[/weekly-report/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ══════════════════════════════════════════════════════
    //  Instagram API 라우트
    // ══════════════════════════════════════════════════════

    // ── GET /instagram/accounts ── 계정 목록
    if (req.method === "GET" && path === "/instagram/accounts") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts")
          .orderBy("createdAt", "asc")
          .get();
        const accounts = snap.docs.map((d) => {
          // accessToken, appSecret을 명시적으로 제외한 후 나머지 필드만 반환
          const { accessToken: _token, appSecret: _secret, ...safeData } = d.data();
          return {
            docId: d.id,
            ...safeData,
            apiType: safeData.apiType || "facebook",
            tokenExpiresAt: safeData.tokenExpiresAt?.toDate?.()?.toISOString() ?? null,
            tokenRefreshedAt: safeData.tokenRefreshedAt?.toDate?.()?.toISOString() ?? null,
            createdAt: safeData.createdAt?.toDate?.()?.toISOString() ?? null,
            performanceReviewPrompt: safeData.performanceReviewPrompt || null,
            performanceReviewModel: safeData.performanceReviewModel || DEFAULT_IG_PERFORMANCE_REVIEW_MODEL,
            postCommentPrompt: safeData.postCommentPrompt || safeData.reactionAnalysisPrompt || DEFAULT_IG_POST_COMMENT_PROMPT,
          };
        });
        return res.json({ accounts });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /instagram/accounts ── 계정 추가
    if (req.method === "POST" && path === "/instagram/accounts") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId1, accessToken, appId, appSecret, igUserId: selectedIgUserId, apiType: reqApiType } = req.body;
        const workspaceId = resolveWorkspaceId(_wsId1);
        const apiType = reqApiType === "instagram" ? "instagram" : "facebook";
        if (!accessToken) return res.status(400).json({ error: "accessToken 필수" });

        let igUserId, username, pageId = "", pageName = "";
        let tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

        if (apiType === "instagram") {
          // ── Instagram Graph API (Business Login for Instagram) ──
          // /me 엔드포인트로 토큰 유효성 검증 + igUserId/username 직접 획득
          let tokenInfo;
          try {
            tokenInfo = await debugIgDirectToken(accessToken);
          } catch (e) {
            return res.status(400).json({ error: `토큰 검증 실패: ${e.message}` });
          }
          igUserId = tokenInfo.igUserId;
          username = tokenInfo.username;
        } else {
          // ── Facebook Graph API (Facebook Login for Business) ──
          if (!appId)     return res.status(400).json({ error: "appId 필수" });
          if (!appSecret) return res.status(400).json({ error: "appSecret 필수" });

          // 토큰 검증 + 연결 가능한 IG 계정 조회
          let candidates;
          try {
            candidates = await listConnectedInstagramAccounts(accessToken);
          } catch (e) {
            return res.status(400).json({ error: `토큰 검증 실패: ${e.message}` });
          }
          if (!candidates.length) {
            return res.status(400).json({ error: "연결된 Instagram 비즈니스/크리에이터 계정을 찾을 수 없습니다." });
          }

          let selectedAccount = null;
          if (selectedIgUserId) {
            selectedAccount = candidates.find((c) => c.igUserId === selectedIgUserId) || null;
            if (!selectedAccount) {
              return res.status(400).json({ error: "선택한 Instagram 계정을 현재 토큰에서 찾을 수 없습니다." });
            }
          } else if (candidates.length === 1) {
            selectedAccount = candidates[0];
          } else {
            return res.json({
              success: false,
              requiresSelection: true,
              candidates: candidates.map((c) => ({
                igUserId: c.igUserId,
                username: c.username,
                pageId: c.pageId,
                pageName: c.pageName,
              })),
            });
          }

          ({ igUserId, username, pageId = "", pageName = "" } = selectedAccount);

          // debug_token으로 실제 만료일 조회 (실패 시 60일 fallback)
          try {
            const tokenDbgInfo = await debugIgToken(accessToken, appId, appSecret);
            if (tokenDbgInfo.expiresAt) tokenExpiresAt = tokenDbgInfo.expiresAt;
          } catch (e) {
            console.warn(`[POST /instagram/accounts] debug_token 실패, 60일 fallback: ${e.message}`);
          }
        }

        const docId = `instagram_${igUserId}`;
        const ref = db.collection("workspaces").doc(workspaceId).collection("instagram_accounts").doc(docId);
        const existingSnap = await ref.get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() || {};
          return res.status(409).json({
            error: "이미 등록된 계정입니다.",
            duplicate: {
              selected: { igUserId, username, pageId, pageName },
              existing: {
                docId,
                igUserId: existingData.igUserId || igUserId,
                username: existingData.username || username,
                pageId: existingData.pageId || "",
                pageName: existingData.pageName || "",
              },
            },
          });
        }

        const docData = {
          platform: "instagram",
          apiType,
          username,
          igUserId,
          pageId,
          pageName,
          accessToken,
          tokenExpiresAt: admin.firestore.Timestamp.fromDate(tokenExpiresAt),
          tokenRefreshedAt: admin.firestore.Timestamp.fromDate(new Date()),
          isActive: true,
          deliveryConfig: { email: { isEnabled: false, recipients: [] } },
          analyticsSheet: { spreadsheetUrl: "" },
          performanceReviewModel: DEFAULT_IG_PERFORMANCE_REVIEW_MODEL,
          postCommentPrompt: DEFAULT_IG_POST_COMMENT_PROMPT,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        // Facebook API 계정에만 appId/appSecret 저장 (토큰 갱신에 필요)
        if (apiType === "facebook") {
          docData.appId = appId;
          docData.appSecret = appSecret;
        }

        await ref.set(docData);
        return res.json({ success: true, docId, username });
      } catch (err) {
        console.error("[POST /instagram/accounts] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /instagram/accounts ── isActive 토글
    if (req.method === "PATCH" && path === "/instagram/accounts") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const { isActive } = req.body;
        await db.collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts").doc(docId)
          .update({ isActive: Boolean(isActive) });
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /instagram/accounts/settings ── deliveryConfig / 프롬프트 수정
    if (req.method === "PATCH" && path === "/instagram/accounts/settings") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const {
          deliveryConfig,
          analyticsSheet,
          performanceReviewPrompt,
          performanceReviewModel,
          postCommentPrompt,
        } = req.body;

        const updates = {};
        if (deliveryConfig !== undefined) {
          if (typeof deliveryConfig !== 'object' || deliveryConfig === null || Array.isArray(deliveryConfig)) {
            return res.status(400).json({ error: 'deliveryConfig는 객체여야 합니다' });
          }
          updates.deliveryConfig = deliveryConfig;
        }
        if (analyticsSheet !== undefined) {
          if (typeof analyticsSheet !== "object" || analyticsSheet === null || Array.isArray(analyticsSheet)) {
            return res.status(400).json({ error: "analyticsSheet는 객체여야 합니다" });
          }
          if (
            analyticsSheet.spreadsheetUrl !== undefined &&
            analyticsSheet.spreadsheetUrl !== null &&
            typeof analyticsSheet.spreadsheetUrl !== "string"
          ) {
            return res.status(400).json({ error: "analyticsSheet.spreadsheetUrl은 문자열이어야 합니다" });
          }
          updates.analyticsSheet = {
            spreadsheetUrl: analyticsSheet.spreadsheetUrl || "",
          };
        }
        if (performanceReviewPrompt !== undefined)  updates.performanceReviewPrompt  = performanceReviewPrompt || null;
        if (postCommentPrompt !== undefined) updates.postCommentPrompt = postCommentPrompt || DEFAULT_IG_POST_COMMENT_PROMPT;
        if (performanceReviewModel !== undefined) {
          if (!IG_PERFORMANCE_REVIEW_MODELS.has(performanceReviewModel)) {
            return res.status(400).json({ error: "지원하지 않는 AI 모델입니다" });
          }
          updates.performanceReviewModel = performanceReviewModel;
        }

        if (Object.keys(updates).length === 0) return res.status(400).json({ error: "변경할 필드 없음" });

        await db.collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts").doc(docId)
          .set(updates, { merge: true });
        return res.json({ success: true });
      } catch (err) {
        console.error("[PATCH /instagram/accounts/settings] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /instagram/accounts ── 계정 삭제
    if (req.method === "DELETE" && path === "/instagram/accounts") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

        // 계정 문서 삭제
        await db.collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts").doc(docId)
          .delete();

        // 해당 계정의 리포트 데이터 정리 (instagram_reports/{date}/accounts/{docId})
        const reportsSnap = await db.collection("workspaces").doc(workspaceId)
          .collection("instagram_reports")
          .get();
        const deleteOps = [];
        for (const dateDoc of reportsSnap.docs) {
          const reportRef = dateDoc.ref.collection("accounts").doc(docId);
          const reportSnap = await reportRef.get();
          if (reportSnap.exists) deleteOps.push(reportRef.delete());
        }
        if (deleteOps.length > 0) await Promise.all(deleteOps);

        return res.json({ success: true, reportsDeleted: deleteOps.length });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /instagram/posts/init ── 전체 게시물 초기화 (최초 1회 전수 수집)
    if (req.method === "POST" && path === "/instagram/posts/init") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.body;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

        const accRef = db.collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts").doc(docId);
        const accSnap = await accRef.get();
        if (!accSnap.exists) return res.status(404).json({ error: "계정 없음" });

        const acc = accSnap.data();
        const { igUserId, accessToken, apiType = "facebook" } = acc;
        if (!igUserId || !accessToken) {
          return res.status(400).json({ error: "igUserId 또는 accessToken 없음" });
        }

        const fetchFn = apiType === "instagram" ? fetchAllIgDirectPosts : fetchAllIgFacebookPosts;
        const allPosts = await fetchFn(igUserId, accessToken);
        console.log(`[/instagram/posts/init] ${docId}: ${allPosts.length}개 포스트 수집 완료`);

        const postsColRef = accRef.collection("posts");
        const now = admin.firestore.FieldValue.serverTimestamp();
        const BATCH_SIZE = 400;
        for (let i = 0; i < allPosts.length; i += BATCH_SIZE) {
          const chunk = allPosts.slice(i, i + BATCH_SIZE);
          const batch = db.batch();
          for (const post of chunk) {
            const postRef = postsColRef.doc(post.id);
            batch.set(postRef, {
              id: post.id,
              igUserId,
              timestamp: post.timestamp || null,
              permalink: post.permalink || null,
              mediaType: (() => {
                const t = String(post.media_type || "").toUpperCase();
                if (!t) return null;
                if (t === "REELS") return "VIDEO";
                return t;
              })(),
              caption: post.caption || null,
              views: post.views != null && Number.isFinite(Number(post.views)) ? Math.round(Number(post.views)) : null,
              reach: post.reach != null && Number.isFinite(Number(post.reach)) ? Math.round(Number(post.reach)) : null,
              likes: post.likes != null && Number.isFinite(Number(post.likes)) ? Math.round(Number(post.likes)) : null,
              comments: post.comments != null && Number.isFinite(Number(post.comments)) ? Math.round(Number(post.comments)) : null,
              shares: post.shares != null && Number.isFinite(Number(post.shares)) ? Math.round(Number(post.shares)) : null,
              saves: post.saves != null && Number.isFinite(Number(post.saves)) ? Math.round(Number(post.saves)) : null,
              follows: post.follows != null && Number.isFinite(Number(post.follows)) ? Math.round(Number(post.follows)) : null,
              profileVisits: post.profileVisits != null && Number.isFinite(Number(post.profileVisits)) ? Math.round(Number(post.profileVisits)) : null,
              reelAvgWatchTime: post.reelAvgWatchTime ?? null,
              totalInteractions: post.totalInteractions != null && Number.isFinite(Number(post.totalInteractions)) ? Math.round(Number(post.totalInteractions)) : null,
              engagementRate: post.engagementRate ?? 0,
              firstSyncedAt: now,
              lastUpdatedAt: now,
            }, { merge: true });
          }
          await batch.commit();
        }

        await accRef.update({
          postsInitialized: true,
          postsLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.json({ success: true, count: allPosts.length });
      } catch (err) {
        console.error("[POST /instagram/posts/init] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /instagram/report ── 리포트 조회
    if (req.method === "GET" && path === "/instagram/report") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const date = req.query.date || new Date(Date.now() + 9 * 60 * 60 * 1000 - 86400000).toISOString().split("T")[0];
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("instagram_reports").doc(date)
          .collection("accounts")
          .get();
        if (snap.empty) return res.json({ date, accounts: [], message: "리포트 없음" });
        const accounts = snap.docs.map((d) => {
          const data = d.data();
          // Firestore Timestamp → ISO string 직렬화
          if (data.collectedAt?.toDate) data.collectedAt = data.collectedAt.toDate().toISOString();
          if (data.createdAt?.toDate) data.createdAt = data.createdAt.toDate().toISOString();
          return { id: d.id, ...data };
        });
        return res.json({ date, accounts });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /instagram/analytics ── 기간별 트렌드 + 게시물 목록
    if (req.method === "GET" && path === "/instagram/analytics") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const { startDate, endDate, docId } = req.query;
        if (!startDate || !endDate) {
          return res.status(400).json({ error: "startDate, endDate 필수 (YYYY-MM-DD)" });
        }

        const start = new Date(startDate + "T00:00:00Z");
        const end = new Date(endDate + "T00:00:00Z");
        const diffDays = Math.round((end - start) / 86400000) + 1;
        if (diffDays < 1) return res.status(400).json({ error: "종료일이 시작일보다 앞섬" });
        if (diffDays > 90) return res.status(400).json({ error: "최대 90일 범위까지 조회 가능합니다" });

        const trendDates = Array.from({ length: diffDays }, (_, i) => {
          const d = new Date(start);
          d.setUTCDate(start.getUTCDate() + i);
          return d.toISOString().split("T")[0];
        });
        const trendDateSet = new Set(trendDates);

        const postLookaheadDays = 6;
        const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const todayKstDate = todayKst.toISOString().split("T")[0];
        const scanEnd = new Date(end);
        scanEnd.setUTCDate(scanEnd.getUTCDate() + postLookaheadDays);
        const effectiveScanEnd = scanEnd.toISOString().split("T")[0] > todayKstDate
          ? new Date(todayKstDate + "T00:00:00Z")
          : scanEnd;
        const scanDiffDays = Math.round((effectiveScanEnd - start) / 86400000) + 1;
        const reportScanDates = Array.from({ length: Math.max(scanDiffDays, diffDays) }, (_, i) => {
          const d = new Date(start);
          d.setUTCDate(start.getUTCDate() + i);
          return d.toISOString().split("T")[0];
        });

        const toNumberOrNull = (value) => {
          if (value === null || value === undefined || value === "") return null;
          const n = Number(value);
          return Number.isFinite(n) ? n : null;
        };

        const pickLatestByReportDate = (existing, candidate) => {
          if (!existing) return candidate;
          if ((candidate._reportDate || "") >= (existing._reportDate || "")) return candidate;
          return existing;
        };

        // KST startDate 00:00 → UTC, KST endDate 23:59:59 → UTC 로 변환하여 timestamp 범위 필터링
        const startUtc = new Date(startDate + "T00:00:00+09:00").toISOString();
        const endUtc = new Date(endDate + "T23:59:59+09:00").toISOString();

        const readFirestorePosts = async (accountDocId) => {
          const snap = await wsRef
            .collection("instagram_accounts").doc(accountDocId)
            .collection("posts")
            .where("timestamp", ">=", startUtc)
            .where("timestamp", "<=", endUtc)
            .orderBy("timestamp", "desc")
            .get();
          return snap.docs.map((d) => {
            const data = d.data();
            if (data.firstSyncedAt?.toDate) data.firstSyncedAt = data.firstSyncedAt.toDate().toISOString();
            if (data.lastUpdatedAt?.toDate) data.lastUpdatedAt = data.lastUpdatedAt.toDate().toISOString();
            return data;
          });
        };

        const sanitizeCommentOverlay = (post, reportDate) => ({
          aiComment: post.aiComment || null,
          aiCommentStatus: post.aiCommentStatus || null,
          aiCommentedAt: post.aiCommentedAt || null,
          aiCommentSourceCommentsCount: toNumberOrNull(post.aiCommentSourceCommentsCount),
          _reportDate: reportDate,
        });

        const wsRef = db.collection("workspaces").doc(workspaceId);
        const accountMap = new Map();
        const accountSnap = await wsRef
          .collection("instagram_accounts")
          .orderBy("createdAt", "asc")
          .get();

        for (const accountDoc of accountSnap.docs) {
          if (docId && accountDoc.id !== docId) continue;
          const data = accountDoc.data();
          accountMap.set(accountDoc.id, {
            id: accountDoc.id,
            docId: accountDoc.id,
            igUserId: data.igUserId || null,
            username: data.username || null,
            _trendByDate: new Map(),
            _aiCommentsByPostId: new Map(),
          });
        }

        for (const date of reportScanDates) {
          const snap = await wsRef
            .collection("instagram_reports").doc(date)
            .collection("accounts")
            .get();

          for (const accountDoc of snap.docs) {
            if (docId && accountDoc.id !== docId) continue;

            const data = accountDoc.data();
            if (!accountMap.has(accountDoc.id)) {
              accountMap.set(accountDoc.id, {
                id: accountDoc.id,
                docId: accountDoc.id,
                igUserId: data.igUserId || null,
                username: data.username || null,
                _trendByDate: new Map(),
                _aiCommentsByPostId: new Map(),
              });
            }

            const acc = accountMap.get(accountDoc.id);
            if (!acc.username && data.username) acc.username = data.username;
            if (!acc.igUserId && data.igUserId) acc.igUserId = data.igUserId;

            if (trendDateSet.has(date)) {
              acc._trendByDate.set(date, {
                date,
                followerCount: toNumberOrNull(data.followerCount),
                dailyViews: toNumberOrNull(data.dailyViews),
              });
            }

            for (const post of Array.isArray(data.posts) ? data.posts : []) {
              if (!post?.id || !post.aiComment) continue;
              const candidate = sanitizeCommentOverlay(post, date);
              const existing = acc._aiCommentsByPostId.get(post.id);
              acc._aiCommentsByPostId.set(post.id, pickLatestByReportDate(existing, candidate));
            }
          }
        }

        const accounts = await Promise.all(Array.from(accountMap.values()).map(async (acc) => {
          let posts = [];
          try {
            posts = await readFirestorePosts(acc.docId);
          } catch (fsErr) {
            console.warn(`[instagram/analytics] Firestore 게시물 로드 실패 — ${acc.docId}: ${fsErr.message}`);
          }

          const mergedPosts = posts
            .map((post) => {
              const comment = post.id ? acc._aiCommentsByPostId.get(post.id) : null;
              if (!comment) return post;
              return {
                ...post,
                aiComment: comment.aiComment,
                aiCommentStatus: comment.aiCommentStatus,
                aiCommentedAt: comment.aiCommentedAt,
                aiCommentSourceCommentsCount: comment.aiCommentSourceCommentsCount,
              };
            })
            .sort((a, b) => {
              const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
              const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
              return tb - ta;
            });

          return {
            id: acc.id,
            docId: acc.docId,
            igUserId: acc.igUserId,
            username: acc.username || acc.igUserId || acc.id,
            trendChart: trendDates.map((date) => acc._trendByDate.get(date) || {
              date,
              followerCount: null,
              dailyViews: null,
            }),
            posts: mergedPosts,
          };
        }));

        const filteredAccounts = accounts
          .filter((acc) =>
            acc.trendChart.some((row) => row.followerCount !== null || row.dailyViews !== null) ||
            acc.posts.length > 0
          )
          .sort((a, b) => String(a.username || "").localeCompare(String(b.username || "")));

        return res.json({ startDate, endDate, accounts: filteredAccounts });
      } catch (err) {
        console.error("[/instagram/analytics] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /instagram/available-dates ── 리포트 날짜 목록
    if (req.method === "GET" && path === "/instagram/available-dates") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("instagram_reports")
          .select()
          .get();
        const dates = snap.docs.map((d) => d.id).sort().reverse();
        return res.json({ dates });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /instagram/pipeline/trigger ── 수동 파이프라인 실행 (리포트 생성만, 이메일 미발송)
    if (req.method === "POST" && path === "/instagram/pipeline/trigger") {
      try {
        const { workspaceId, date, skipEmail, forceRegenerateComments } = req.body || {};
        const result = await runInstagramPipeline(
          workspaceId || null,
          date || null,
          {
            skipEmail: skipEmail !== false,  // 기본 true (생성만), skipEmail:false 명시 시만 이메일 발송
            forceRegenerateComments: Boolean(forceRegenerateComments),
          }
        );
        return res.json({ success: true, result });
      } catch (err) {
        console.error("[/instagram/pipeline/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /instagram/email/trigger ── 수동 이메일 발송
    if (req.method === "POST" && path === "/instagram/email/trigger") {
      try {
        const { workspaceId, date } = req.body || {};
        const result = await runInstagramEmailSender(workspaceId || null, date || null);
        return res.json({ success: true, result });
      } catch (err) {
        console.error("[/instagram/email/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /instagram/tokens ── 계정별 토큰 상태 조회
    if (req.method === "GET" && path === "/instagram/tokens") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts")
          .orderBy("createdAt", "asc")
          .get();

        const now = Date.now();
        const accounts = snap.docs.map((d) => {
          const data = d.data();
          const expiresAt = data.tokenExpiresAt?.toDate?.() ?? null;
          const refreshedAt = data.tokenRefreshedAt?.toDate?.() ?? null;
          const daysUntilExpiry = expiresAt
            ? Math.floor((expiresAt.getTime() - now) / 86400000)
            : null;
          const status = daysUntilExpiry === null ? "unknown"
            : daysUntilExpiry < 0  ? "expired"
            : daysUntilExpiry < 14 ? "expiring_soon"
            : "active";
          return {
            docId: d.id,
            username: data.username,
            isActive: data.isActive,
            apiType: data.apiType || "facebook",
            tokenExpiresAt: expiresAt?.toISOString() ?? null,
            tokenRefreshedAt: refreshedAt?.toISOString() ?? null,
            daysUntilExpiry,
            status,
          };
        });
        return res.json({ accounts });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /instagram/tokens/refresh ── 특정 계정 토큰 즉시 갱신
    if (req.method === "POST" && path === "/instagram/tokens/refresh") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

        const ref = db.collection("workspaces").doc(workspaceId)
          .collection("instagram_accounts").doc(docId);
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });

        const { accessToken: currentToken, appId, appSecret, username, apiType: accApiType } = doc.data();
        const isDirectApi = accApiType === "instagram";

        let newToken, expiresIn;
        if (isDirectApi) {
          // Instagram API: ig_refresh_token 방식 (appId/appSecret 불필요)
          ({ accessToken: newToken, expiresIn } = await refreshDirectToken(currentToken));
        } else {
          // Facebook API: fb_exchange_token 방식
          ({ accessToken: newToken, expiresIn } = await refreshIgToken(currentToken, appId, appSecret));
        }

        // 만료일 계산 (Facebook API만 debug_token으로 실제 만료일 확인)
        let newExpiresAt = new Date(Date.now() + (expiresIn || 5184000) * 1000);
        if (!isDirectApi) {
          try {
            const tokenInfo = await debugIgToken(newToken, appId, appSecret);
            if (tokenInfo.expiresAt) newExpiresAt = tokenInfo.expiresAt;
          } catch (_) { /* fallback to expiresIn */ }
        }

        await ref.update({
          accessToken: newToken,
          tokenExpiresAt: admin.firestore.Timestamp.fromDate(newExpiresAt),
          tokenRefreshedAt: admin.firestore.Timestamp.fromDate(new Date()),
        });

        return res.json({ success: true, username, newExpiresAt: newExpiresAt.toISOString() });
      } catch (err) {
        console.error("[POST /instagram/tokens/refresh] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ════════════════════════════════════════════════════════
    //  Facebook 그룹 API
    // ════════════════════════════════════════════════════════

    // ── GET /facebook/groups ── 그룹 목록 조회
    if (req.method === "GET" && path === "/facebook/groups") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("facebook_groups")
          .orderBy("createdAt", "asc")
          .get();
        const groups = snap.docs.map((d) => {
          const { ...data } = d.data();
          return { docId: d.id, ...data };
        });
        return res.json({ groups });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /facebook/groups ── 그룹 추가
    if (req.method === "POST" && path === "/facebook/groups") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, groupUrl, groupName } = req.body || {};
        if (!groupUrl) return res.status(400).json({ error: "groupUrl 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

        // groupId: URL에서 추출 (/groups/{id} or /groups/{name})
        const groupIdMatch = String(groupUrl).match(/\/groups\/([^/?#]+)/);
        const groupId = groupIdMatch ? groupIdMatch[1] : groupUrl;

        // 중복 확인
        const existing = await db
          .collection("workspaces").doc(workspaceId)
          .collection("facebook_groups")
          .where("groupId", "==", groupId)
          .get();
        if (!existing.empty) {
          return res.status(409).json({ error: "이미 등록된 그룹입니다", docId: existing.docs[0].id });
        }

        const docRef = await db
          .collection("workspaces").doc(workspaceId)
          .collection("facebook_groups")
          .add({
            platform: "facebook",
            groupId,
            groupName: groupName || groupId,
            groupUrl: String(groupUrl).replace(/\/$/, ""),
            isActive: true,
            deliveryConfig: { email: { isEnabled: false, recipients: [] } },
            analysisPrompt: "",
            analysisModel: "",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

        return res.json({ success: true, docId: docRef.id, groupId });
      } catch (err) {
        console.error("[POST /facebook/groups] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /facebook/groups ── isActive 토글
    if (req.method === "PATCH" && path === "/facebook/groups") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const { isActive } = req.body || {};
        const workspaceId = resolveWorkspaceId(_wsId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("facebook_groups").doc(docId)
          .update({ isActive: Boolean(isActive) });
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /facebook/groups/settings ── 그룹 설정 수정
    if (req.method === "PATCH" && path === "/facebook/groups/settings") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const { deliveryConfig, analysisPrompt, analysisModel, groupName } = req.body || {};
        const update = {};
        if (deliveryConfig !== undefined) update.deliveryConfig = deliveryConfig;
        if (analysisPrompt !== undefined) update.analysisPrompt = String(analysisPrompt);
        if (analysisModel  !== undefined) {
          if (!FB_ANALYSIS_MODELS.has(analysisModel)) {
            return res.status(400).json({ error: "지원하지 않는 AI 모델입니다" });
          }
          update.analysisModel = analysisModel;
        }
        if (groupName      !== undefined) update.groupName      = String(groupName);
        await db.collection("workspaces").doc(workspaceId)
          .collection("facebook_groups").doc(docId)
          .update(update);
        return res.json({ success: true });
      } catch (err) {
        console.error("[PATCH /facebook/groups/settings] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /facebook/groups ── 그룹 삭제 + 리포트 정리
    if (req.method === "DELETE" && path === "/facebook/groups") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("facebook_groups").doc(docId).delete();
        const reportsSnap = await db.collection("workspaces").doc(workspaceId)
          .collection("facebook_reports").get();
        const deleteOps = [];
        for (const dateDoc of reportsSnap.docs) {
          const ref = dateDoc.ref.collection("groups").doc(docId);
          const snap = await ref.get();
          if (snap.exists) deleteOps.push(ref.delete());
        }
        if (deleteOps.length) await Promise.all(deleteOps);
        return res.json({ success: true, reportsDeleted: deleteOps.length });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /facebook/report ── 리포트 조회
    if (req.method === "GET" && path === "/facebook/report") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const { date } = req.query;
        if (!date) return res.status(400).json({ error: "date 필수 (YYYY-MM-DD)" });
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("facebook_reports").doc(date)
          .collection("groups").get();
        const reports = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
        return res.json({ date, reports });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /facebook/available-dates ── 리포트 존재 날짜 목록
    if (req.method === "GET" && path === "/facebook/available-dates") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("facebook_reports")
          .orderBy("updatedAt", "desc")
          .limit(60)
          .get();
        const dates = snap.docs.map((d) => d.id);
        return res.json({ dates });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /facebook/pipeline/trigger ── 파이프라인 수동 실행 (이메일 미발송)
    if (req.method === "POST" && path === "/facebook/pipeline/trigger") {
      try {
        const { workspaceId, date } = req.body || {};
        const results = await runFacebookGroupPipeline(workspaceId || null, date || null, { skipEmail: true });
        return res.json({ success: true, results });
      } catch (err) {
        console.error("[/facebook/pipeline/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /facebook/email/trigger ── 이메일 수동 발송 (주의: 실제 발송)
    if (req.method === "POST" && path === "/facebook/email/trigger") {
      try {
        const { workspaceId, date } = req.body || {};
        const result = await runFacebookGroupEmailSender(workspaceId || null, date || null);
        return res.json({ success: true, result });
      } catch (err) {
        console.error("[/facebook/email/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /facebook/session ── 쿠키 JSON 저장
    if (req.method === "PATCH" && path === "/facebook/session") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, cookies, userAgent } = req.body || {};
        if (!cookies || !Array.isArray(cookies)) {
          return res.status(400).json({ error: "cookies 배열 필수" });
        }
        const workspaceId = resolveWorkspaceId(_wsId);
        await saveFbSession(db, workspaceId, { cookies, userAgent: userAgent || "" });
        return res.json({ success: true, cookieCount: cookies.length });
      } catch (err) {
        console.error("[PATCH /facebook/session] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /facebook/session/status ── 세션 상태 조회
    if (req.method === "GET" && path === "/facebook/session/status") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const session = await loadFbSession(db, workspaceId);
        if (!session) return res.json({ exists: false, isValid: false });
        return res.json({
          exists: true,
          isValid: session.isValid ?? false,
          cookieCount: (session.cookies || []).length,
          savedAt: session.savedAt?.toDate?.()?.toISOString() ?? null,
          lastValidatedAt: session.lastValidatedAt?.toDate?.()?.toISOString() ?? null,
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /facebook/session ── 세션 삭제
    if (req.method === "DELETE" && path === "/facebook/session") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("facebook_session").doc("main").delete();
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /facebook/session/verify ── 세션 유효성 재검증 (브라우저 실행)
    if (req.method === "POST" && path === "/facebook/session/verify") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.body?.workspaceId || req.query.workspaceId);
        const session = await loadFbSession(db, workspaceId);
        if (!session || !(session.cookies || []).length) {
          return res.status(404).json({ error: "저장된 세션 없음" });
        }

        let browser;
        try {
          browser = await launchFbBrowser();
          const context = await browser.newContext({
            userAgent: session.userAgent || undefined,
            locale: "ko-KR",
            extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9" },
          });
          await applyFbCookies(context, session.cookies);
          const page = await context.newPage();
          const isValid = await verifyFbSessionAlive(page);

          await db
            .collection("workspaces").doc(workspaceId)
            .collection("facebook_session").doc("main")
            .set({ isValid, lastValidatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

          return res.json({ isValid, lastValidatedAt: new Date().toISOString() });
        } finally {
          try { await browser?.close(); } catch (_) {}
        }
      } catch (err) {
        console.error("[POST /facebook/session/verify] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ════════════════════════════════════════════════════════
    //  네이버 라운지 API
    // ════════════════════════════════════════════════════════

    // ── GET /naver/lounges ── 라운지 목록 조회
    if (req.method === "GET" && path === "/naver/lounges") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("naver_lounges")
          .orderBy("createdAt", "asc")
          .get();
        const lounges = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
        return res.json({ lounges });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /naver/lounges ── 라운지 등록
    if (req.method === "POST" && path === "/naver/lounges") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, loungeUrl, loungeName } = req.body || {};
        if (!loungeUrl) return res.status(400).json({ error: "loungeUrl 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);

        // loungeId: URL에서 추출 (/lounge/{id}/board)
        const loungeIdMatch = String(loungeUrl).match(/\/lounge\/([^/?#]+)/);
        const loungeId = loungeIdMatch ? loungeIdMatch[1] : loungeUrl;

        // 중복 확인
        const existing = await db
          .collection("workspaces").doc(workspaceId)
          .collection("naver_lounges")
          .where("loungeId", "==", loungeId)
          .get();
        if (!existing.empty) {
          return res.status(409).json({ error: "이미 등록된 라운지입니다", docId: existing.docs[0].id });
        }

        const docRef = await db
          .collection("workspaces").doc(workspaceId)
          .collection("naver_lounges")
          .add({
            platform: "naver_lounge",
            loungeId,
            loungeName: loungeName || loungeId,
            loungeUrl: String(loungeUrl).replace(/\/$/, ""),
            isActive: true,
            deliveryConfig: { email: { isEnabled: false, recipients: [] } },
            analysisPrompt: "",
            analysisModel: "",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

        return res.json({ success: true, docId: docRef.id, loungeId });
      } catch (err) {
        console.error("[POST /naver/lounges] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /naver/lounges ── isActive 토글
    if (req.method === "PATCH" && path === "/naver/lounges") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const { isActive } = req.body || {};
        const workspaceId = resolveWorkspaceId(_wsId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("naver_lounges").doc(docId)
          .update({ isActive: Boolean(isActive) });
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /naver/lounges/settings ── 라운지 설정 수정
    if (req.method === "PATCH" && path === "/naver/lounges/settings") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const { deliveryConfig, analysisPrompt, analysisModel, loungeName } = req.body || {};
        const update = {};
        if (deliveryConfig  !== undefined) update.deliveryConfig  = deliveryConfig;
        if (analysisPrompt  !== undefined) update.analysisPrompt  = String(analysisPrompt);
        if (analysisModel   !== undefined) {
          if (!NL_ANALYSIS_MODELS.has(analysisModel)) {
            return res.status(400).json({ error: "지원하지 않는 AI 모델입니다" });
          }
          update.analysisModel = analysisModel;
        }
        if (loungeName !== undefined) update.loungeName = String(loungeName);
        await db.collection("workspaces").doc(workspaceId)
          .collection("naver_lounges").doc(docId)
          .update(update);
        return res.json({ success: true });
      } catch (err) {
        console.error("[PATCH /naver/lounges/settings] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /naver/lounges ── 라운지 삭제 + 리포트 정리
    if (req.method === "DELETE" && path === "/naver/lounges") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, docId } = req.query;
        if (!docId) return res.status(400).json({ error: "docId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("naver_lounges").doc(docId).delete();
        const reportsSnap = await db.collection("workspaces").doc(workspaceId)
          .collection("naver_reports").get();
        const deleteOps = [];
        for (const dateDoc of reportsSnap.docs) {
          const ref = dateDoc.ref.collection("lounges").doc(docId);
          const snap = await ref.get();
          if (snap.exists) deleteOps.push(ref.delete());
        }
        if (deleteOps.length) await Promise.all(deleteOps);
        return res.json({ success: true, reportsDeleted: deleteOps.length });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /naver/report ── 리포트 조회
    if (req.method === "GET" && path === "/naver/report") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const { date } = req.query;
        if (!date) return res.status(400).json({ error: "date 필수 (YYYY-MM-DD)" });
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("naver_reports").doc(date)
          .collection("lounges").get();
        const reports = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
        return res.json({ date, reports });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /naver/available-dates ── 리포트 존재 날짜 목록
    if (req.method === "GET" && path === "/naver/available-dates") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db
          .collection("workspaces").doc(workspaceId)
          .collection("naver_reports")
          .orderBy("updatedAt", "desc")
          .limit(60)
          .get();
        const dates = snap.docs.map((d) => d.id);
        return res.json({ dates });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /naver/pipeline/trigger ── 파이프라인 수동 실행 (이메일 미발송)
    if (req.method === "POST" && path === "/naver/pipeline/trigger") {
      try {
        const { workspaceId, date } = req.body || {};
        const results = await runNaverLoungePipeline(workspaceId || null, date || null, { skipEmail: true });
        return res.json({ success: true, results });
      } catch (err) {
        console.error("[/naver/pipeline/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /naver/email/trigger ── 이메일 수동 발송 (주의: 실제 발송)
    if (req.method === "POST" && path === "/naver/email/trigger") {
      try {
        const { workspaceId, date } = req.body || {};
        const result = await runNaverLoungeEmailSender(workspaceId || null, date || null);
        return res.json({ success: true, result });
      } catch (err) {
        console.error("[/naver/email/trigger] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /naver/session ── 쿠키 JSON 저장
    if (req.method === "PATCH" && path === "/naver/session") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, cookies, userAgent } = req.body || {};
        if (!cookies || !Array.isArray(cookies)) {
          return res.status(400).json({ error: "cookies 배열 필수" });
        }
        const workspaceId = resolveWorkspaceId(_wsId);
        await saveNlSession(db, workspaceId, { cookies, userAgent: userAgent || "" });
        return res.json({ success: true, cookieCount: cookies.length });
      } catch (err) {
        console.error("[PATCH /naver/session] 오류:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /naver/session/status ── 세션 상태 조회
    if (req.method === "GET" && path === "/naver/session/status") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const session = await loadNlSession(db, workspaceId);
        if (!session) return res.json({ exists: false, isValid: false });
        return res.json({
          exists: true,
          isValid: session.isValid ?? false,
          cookieCount: (session.cookies || []).length,
          savedAt: session.savedAt?.toDate?.()?.toISOString() ?? null,
          lastValidatedAt: session.lastValidatedAt?.toDate?.()?.toISOString() ?? null,
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /naver/session ── 세션 삭제
    if (req.method === "DELETE" && path === "/naver/session") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("naver_session").doc("main").delete();
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── GET /report-presets ── 프리셋 목록 조회
    if (req.method === "GET" && path === "/report-presets") {
      try {
        const db = admin.firestore();
        const workspaceId = resolveWorkspaceId(req.query.workspaceId);
        const snap = await db.collection("workspaces").doc(workspaceId)
          .collection("report_presets")
          .orderBy("createdAt", "desc")
          .get();
        const presets = snap.docs.map((d) => ({ presetId: d.id, ...d.data() }));
        return res.json({ presets });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /report-presets ── 프리셋 생성
    if (req.method === "POST" && path === "/report-presets") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, name, items = [], recipients = [] } = req.body || {};
        if (!name) return res.status(400).json({ error: "name 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const ref = await db.collection("workspaces").doc(workspaceId)
          .collection("report_presets")
          .add({
            name,
            items,
            recipients,
            isActive: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        return res.json({ success: true, presetId: ref.id });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PATCH /report-presets ── 프리셋 수정
    if (req.method === "PATCH" && path === "/report-presets") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, presetId, ...fields } = req.body || {};
        if (!presetId) return res.status(400).json({ error: "presetId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        const allowed = ["name", "items", "recipients", "isActive"];
        const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        for (const key of allowed) {
          if (fields[key] !== undefined) update[key] = fields[key];
        }
        await db.collection("workspaces").doc(workspaceId)
          .collection("report_presets").doc(presetId)
          .update(update);
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── DELETE /report-presets ── 프리셋 삭제
    if (req.method === "DELETE" && path === "/report-presets") {
      try {
        const db = admin.firestore();
        const { workspaceId: _wsId, presetId } = req.body || {};
        if (!presetId) return res.status(400).json({ error: "presetId 필수" });
        const workspaceId = resolveWorkspaceId(_wsId);
        await db.collection("workspaces").doc(workspaceId)
          .collection("report_presets").doc(presetId)
          .delete();
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── POST /report-presets/email/trigger ── 통합 이메일 수동 발송 (주의: 실제 발송)
    if (req.method === "POST" && path === "/report-presets/email/trigger") {
      try {
        const { workspaceId, presetId, date } = req.body || {};
        const results = await runReportPresetPipeline(workspaceId || null, date || null, presetId || null);
        return res.json({ success: true, results });
      } catch (err) {
        console.error("[/report-presets/email/trigger] 오류:", err.message);
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

// ══════════════════════════════════════════════════════
//  Cloud Scheduler — 매일 KST 09:30 (인사이트 수집)
// ══════════════════════════════════════════════════════
exports.insightCollector = onSchedule(
  { schedule: "30 0 * * *", timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    console.log("[insightCollector] 스케줄 실행 시작");
    await runInsightCollector();
    console.log("[insightCollector] 스케줄 실행 완료");
  }
);

// ══════════════════════════════════════════════════════
//  Cloud Scheduler — 매주 월요일 KST 10:00 (주간 리포트)
// ══════════════════════════════════════════════════════
exports.weeklyPipeline = onSchedule(
  { schedule: "0 1 * * 1", timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    console.log("[weeklyPipeline] 스케줄 실행 시작");
    await runWeeklyPipeline();
    console.log("[weeklyPipeline] 스케줄 실행 완료");
  }
);

// ══════════════════════════════════════════════════════
//  Cloud Scheduler — 매일 KST 09:00 (Instagram 리포트 생성 + 이메일 발송)
//  UTC 00:00 = KST 09:00 = 전날 UTC 하루 완성 직후 → 어제 KST 기준 완전 데이터 보장
// ══════════════════════════════════════════════════════
exports.instagramPipeline = onSchedule(
  { schedule: "0 0 * * *", timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    console.log("[instagramPipeline] 스케줄 실행 시작 (KST 09:00)");
    await runInstagramPipeline(null, null, { skipEmail: false });
    console.log("[instagramPipeline] 스케줄 실행 완료");
  }
);

// ══════════════════════════════════════════════════════
//  Cloud Scheduler — 매일 KST 09:00 (Facebook 그룹 크롤링 + 리포트 생성 + 이메일 발송)
//  UTC 00:00 = KST 09:00 | memory: 2GiB (Chromium 안정성 확보)
// ══════════════════════════════════════════════════════
exports.facebookGroupPipeline = onSchedule(
  { schedule: "0 0 * * *", timeoutSeconds: 800, memory: "2GiB" },
  async () => {
    console.log("[facebookGroupPipeline] 스케줄 실행 시작 (KST 09:00)");
    await runFacebookGroupPipeline(null, null, { skipEmail: false });
    console.log("[facebookGroupPipeline] 스케줄 실행 완료");
  }
);

// ══════════════════════════════════════════════════════
//  Cloud Scheduler — 매일 KST 10:30 (통합 프리셋 이메일)
//  UTC 01:30 = KST 10:30 | 모든 개별 파이프라인 완료 후 실행
// ══════════════════════════════════════════════════════
exports.presetPipeline = onSchedule(
  { schedule: "30 1 * * *", timeoutSeconds: 300, memory: "512MiB" },
  async () => {
    console.log("[presetPipeline] 스케줄 실행 시작 (KST 10:30)");
    await runReportPresetPipeline();
    console.log("[presetPipeline] 스케줄 실행 완료");
  }
);

// ══════════════════════════════════════════════════════
//  [비활성화] 구 방식: KST 18:00 생성 + KST 09:00 발송 (롤백 시 아래 두 블록 복원)
//  exports.instagramPipeline = onSchedule(
//    { schedule: "0 9 * * *", timeoutSeconds: 540, memory: "512MiB" },
//    async () => { await runInstagramPipeline(null, null, { skipEmail: true }); }
//  );
//  exports.instagramEmailSender = onSchedule(
//    { schedule: "0 0 * * *", timeoutSeconds: 120, memory: "256MiB" },
//    async () => { await runInstagramEmailSender(); }
//  );
// ══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  내부 함수: 워크스페이스 + 채널 Firestore 초기 데이터 생성
// ═══════════════════════════════════════════════════════
async function seedWorkspace(body = {}) {
  const db = admin.firestore();

  const workspaceId    = resolveWorkspaceId(body.workspaceId);
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
