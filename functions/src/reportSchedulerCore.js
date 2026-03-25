const admin = require("firebase-admin");

const SCHEDULER_TIMEZONE = "Asia/Seoul";
const SCHEDULER_SETTINGS_DOC_ID = "schedulers";

const SCHEDULER_DEFINITIONS = Object.freeze([
  {
    key: "alertPipeline",
    name: "Discord 증분 수집 + 키워드 알림",
    description: "Discord 채널 증분 수집과 키워드 알림을 수행합니다.",
    type: "interval",
    intervalHours: 2,
    minute: 0,
  },
  {
    key: "dailyPipeline",
    name: "Discord 일간 리포트",
    description: "Discord 일간 리포트를 생성합니다.",
    type: "daily",
    hour: 9,
    minute: 0,
  },
  {
    key: "insightCollector",
    name: "Discord Insights 수집",
    description: "Discord Guild Insights를 수집합니다.",
    type: "daily",
    hour: 9,
    minute: 30,
  },
  {
    key: "weeklyPipeline",
    name: "Discord 주간 리포트",
    description: "Discord 주간 리포트를 생성하고 발송합니다.",
    type: "weekly",
    weekday: 1,
    hour: 10,
    minute: 0,
  },
  {
    key: "instagramPipeline",
    name: "Instagram 일간 파이프라인",
    description: "Instagram 수집, 분석, 이메일 발송을 수행합니다.",
    type: "daily",
    hour: 9,
    minute: 0,
  },
  {
    key: "facebookGroupPipeline",
    name: "Facebook 그룹 일간 파이프라인",
    description: "Facebook 그룹 크롤링, 분석, 이메일 발송을 수행합니다.",
    type: "daily",
    hour: 9,
    minute: 0,
  },
  {
    key: "facebookPagePipeline",
    name: "Facebook 페이지 일간 파이프라인",
    description: "Facebook 페이지 API 수집, 분석, 이메일 발송을 수행합니다.",
    type: "daily",
    hour: 9,
    minute: 5,
  },
  {
    key: "naverLoungePipeline",
    name: "네이버 라운지 일간 파이프라인",
    description: "네이버 라운지 수집, 분석, 이메일 발송을 수행합니다.",
    type: "daily",
    hour: 9,
    minute: 10,
  },
  {
    key: "dcinsidePipeline",
    name: "DCInside 일간 파이프라인",
    description: "Firestore에 저장된 DCInside 수집 데이터를 분석하고 이메일을 발송합니다.",
    type: "daily",
    hour: 9,
    minute: 0,
  },
  {
    key: "youtubePipeline",
    name: "YouTube 일간 파이프라인",
    description: "YouTube 신규 업로드 수집, 분석, 이메일 발송을 수행합니다.",
    type: "daily",
    hour: 8,
    minute: 50,
  },
  {
    key: "presetPipeline",
    name: "통합 프리셋 이메일 발송",
    description: "활성 프리셋 통합 이메일을 발송합니다.",
    type: "daily",
    hour: 9,
    minute: 30,
  },
]);

const SCHEDULER_DEFINITION_MAP = Object.freeze(
  SCHEDULER_DEFINITIONS.reduce((acc, def) => {
    acc[def.key] = def;
    return acc;
  }, {})
);

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function clampMinute5(value, fallback) {
  const minute = clampInt(value, 0, 59, fallback);
  return Math.floor(minute / 5) * 5;
}

function getTaskDefaults(def) {
  return {
    enabled: true,
    type: def.type,
    hour: def.hour ?? 0,
    minute: def.minute ?? 0,
    weekday: def.weekday ?? 1,
    intervalHours: def.intervalHours ?? 1,
    lastRunKey: "",
    lastRunAt: null,
    lastStatus: "",
    lastError: "",
  };
}

function buildDefaultSchedulerTasks() {
  return SCHEDULER_DEFINITIONS.reduce((acc, def) => {
    acc[def.key] = getTaskDefaults(def);
    return acc;
  }, {});
}

function normalizeTaskConfig(taskKey, input = {}, base = null) {
  const def = SCHEDULER_DEFINITION_MAP[taskKey];
  if (!def) throw new Error(`알 수 없는 스케줄러: ${taskKey}`);

  const defaults = base ? { ...getTaskDefaults(def), ...base } : getTaskDefaults(def);
  const merged = { ...defaults, ...(input || {}) };
  const normalized = {
    enabled: merged.enabled !== false,
    type: def.type,
    hour: clampInt(merged.hour, 0, 23, defaults.hour),
    minute: clampMinute5(merged.minute, defaults.minute),
    weekday: clampInt(merged.weekday, 1, 7, defaults.weekday),
    intervalHours: clampInt(merged.intervalHours, 1, 24, defaults.intervalHours),
    lastRunKey: typeof merged.lastRunKey === "string" ? merged.lastRunKey : "",
    lastRunAt: merged.lastRunAt || null,
    lastStatus: typeof merged.lastStatus === "string" ? merged.lastStatus : "",
    lastError: typeof merged.lastError === "string" ? merged.lastError : "",
  };
  return normalized;
}

function mergeSchedulerSettings(raw = {}) {
  const sourceTasks = raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {};
  const tasks = {};
  for (const def of SCHEDULER_DEFINITIONS) {
    tasks[def.key] = normalizeTaskConfig(def.key, sourceTasks[def.key], sourceTasks[def.key]);
  }
  return {
    timezone: SCHEDULER_TIMEZONE,
    tasks,
    updatedAt: raw.updatedAt || null,
  };
}

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

function serializeSchedulerSettings(raw = {}) {
  const merged = mergeSchedulerSettings(raw);
  return {
    timezone: merged.timezone,
    updatedAt: serializeTimestamp(merged.updatedAt),
    tasks: SCHEDULER_DEFINITIONS.map((def) => ({
      key: def.key,
      name: def.name,
      description: def.description,
      ...merged.tasks[def.key],
      lastRunAt: serializeTimestamp(merged.tasks[def.key].lastRunAt),
    })),
  };
}

function getKstParts(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const weekday = kst.getUTCDay() === 0 ? 7 : kst.getUTCDay();
  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    minute,
    weekday,
  };
}

function getDueKey(task, now = new Date()) {
  if (!task || task.enabled === false) return null;
  const parts = getKstParts(now);

  if (task.type === "interval") {
    if (parts.minute !== task.minute) return null;
    if (parts.hour % task.intervalHours !== 0) return null;
    return `${parts.dateKey}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  }

  if (parts.minute !== task.minute || parts.hour !== task.hour) return null;
  if (task.type === "weekly" && parts.weekday !== task.weekday) return null;

  return `${parts.dateKey}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function getSchedulerSettingsRef(db, workspaceId) {
  return db.collection("workspaces").doc(workspaceId)
    .collection("settings").doc(SCHEDULER_SETTINGS_DOC_ID);
}

async function readSchedulerSettings(db, workspaceId) {
  const snap = await getSchedulerSettingsRef(db, workspaceId).get();
  return snap.exists ? snap.data() : {};
}

async function saveSchedulerSettings(db, workspaceId, tasks, options = {}) {
  const current = await readSchedulerSettings(db, workspaceId);
  const mergedCurrent = mergeSchedulerSettings(current);
  const nextTasks = {};

  for (const def of SCHEDULER_DEFINITIONS) {
    nextTasks[def.key] = normalizeTaskConfig(
      def.key,
      tasks?.[def.key],
      mergedCurrent.tasks[def.key]
    );
  }

  await getSchedulerSettingsRef(db, workspaceId).set({
    timezone: SCHEDULER_TIMEZONE,
    tasks: nextTasks,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...options.extraFields,
  }, { merge: true });
}

async function claimScheduledTask(db, workspaceId, taskKey, now = new Date()) {
  const ref = getSchedulerSettingsRef(db, workspaceId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const merged = mergeSchedulerSettings(snap.exists ? snap.data() : {});
    const task = merged.tasks[taskKey];
    const dueKey = getDueKey(task, now);

    if (!dueKey) {
      return { shouldRun: false, reason: "not_due", task };
    }
    if (task.lastRunKey === dueKey) {
      return { shouldRun: false, reason: "already_ran", task, dueKey };
    }

    tx.set(ref, {
      timezone: SCHEDULER_TIMEZONE,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      tasks: {
        [taskKey]: {
          lastRunKey: dueKey,
          lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: "running",
          lastError: "",
        },
      },
    }, { merge: true });

    return { shouldRun: true, task, dueKey };
  });
}

async function finalizeScheduledTask(db, workspaceId, taskKey, status, errorMessage = "") {
  await getSchedulerSettingsRef(db, workspaceId).set({
    timezone: SCHEDULER_TIMEZONE,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    tasks: {
      [taskKey]: {
        lastStatus: status,
        lastError: errorMessage ? String(errorMessage).slice(0, 1000) : "",
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    },
  }, { merge: true });
}

module.exports = {
  SCHEDULER_DEFINITIONS,
  SCHEDULER_TIMEZONE,
  buildDefaultSchedulerTasks,
  claimScheduledTask,
  finalizeScheduledTask,
  getDueKey,
  mergeSchedulerSettings,
  readSchedulerSettings,
  saveSchedulerSettings,
  serializeSchedulerSettings,
};
