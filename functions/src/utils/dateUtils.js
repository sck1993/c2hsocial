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

module.exports = { getKSTDateString, getKSTYesterdayString, getKSTMidnightMs, getKSTDateFromMs };
