"use strict";

/** KST(UTC+9) 기준 오늘 날짜 문자열 (YYYY-MM-DD) */
function getKSTDateString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/** KST 기준 어제 날짜 문자열 (YYYY-MM-DD) */
function getKSTYesterdayString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/** KST 기준 오늘 자정(00:00 KST)의 UTC 타임스탬프(ms) */
function getKSTMidnightMs(kstDateStr) {
  return new Date(kstDateStr + "T00:00:00+09:00").getTime();
}

/** UTC 타임스탬프(ms)를 KST 날짜 문자열(YYYY-MM-DD)로 변환 */
function getKSTDateFromMs(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/** ISO/UTC 타임스탬프 문자열을 KST 날짜 문자열(YYYY-MM-DD)로 변환. 잘못된 값이면 null 반환. */
function getKSTDateFromTimestamp(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/** ms 동안 대기하는 범용 헬퍼 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * KST 날짜 문자열 기준 UTC 초 단위 since/until 범위 반환.
 * Facebook Graph API 등 Unix timestamp 기반 API에서 사용.
 */
function getUtcRangeForKstDate(kstDateStr) {
  const startMs = getKSTMidnightMs(kstDateStr);
  const endMs   = startMs + 24 * 60 * 60 * 1000;
  return { since: Math.floor(startMs / 1000), until: Math.floor(endMs / 1000) };
}

/**
 * 현재 시각 기준 직전 주(월~일) KST 날짜 범위 반환.
 * @returns {{ weekStart: string, weekEnd: string }} YYYY-MM-DD 형식
 */
function getLastWeekRange() {
  const nowKST    = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dayOfWeek = nowKST.getUTCDay() || 7; // 0(일)→7
  const thisMonday = new Date(nowKST);
  thisMonday.setUTCDate(nowKST.getUTCDate() - (dayOfWeek - 1));
  thisMonday.setUTCHours(0, 0, 0, 0);

  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCDate(thisMonday.getUTCDate() - 1);

  const fmt = (d) => d.toISOString().split("T")[0];
  return { weekStart: fmt(lastMonday), weekEnd: fmt(lastSunday) };
}

/**
 * weekStart 기준 7일 날짜 배열 반환. (YYYY-MM-DD[])
 * @param {string} weekStart - 'YYYY-MM-DD'
 */
function getWeekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().split("T")[0];
  });
}

module.exports = {
  getKSTDateString,
  getKSTYesterdayString,
  getKSTMidnightMs,
  getKSTDateFromMs,
  getKSTDateFromTimestamp,
  sleep,
  getUtcRangeForKstDate,
  getLastWeekRange,
  getWeekDates,
};
