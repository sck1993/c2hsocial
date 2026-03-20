/**
 * reportPresetDailyPipeline.js
 * 리포트 프리셋 일일 파이프라인
 * 활성 프리셋의 각 항목 Firestore 리포트를 조합하여 통합 이메일 발송
 *
 * exports:
 *   runReportPresetPipeline(filterWorkspaceId?, targetDate?, filterPresetId?)
 */

"use strict";

const admin = require("firebase-admin");
const { sendUnifiedEmailReport } = require("./reportDelivery");
const { getKSTYesterdayString } = require("./utils/dateUtils");

const DEFAULT_WORKSPACE = "ws_antigravity";

/**
 * 플랫폼별 Firestore 경로로 해당 날짜 리포트를 조회
 * @returns {object|null} 리포트 데이터 (없으면 null)
 */
async function fetchReportForItem(db, workspaceId, item, date) {
  const { platform, targetId } = item;
  try {
    let ref;
    if (platform === "discord") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("reports").doc(date)
        .collection("guilds").doc(targetId);
    } else if (platform === "instagram") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("instagram_reports").doc(date)
        .collection("accounts").doc(targetId);
    } else if (platform === "facebook") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("facebook_reports").doc(date)
        .collection("groups").doc(targetId);
    } else if (platform === "naver_lounge") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("naver_reports").doc(date)
        .collection("lounges").doc(targetId);
    } else {
      console.warn(`[presetPipeline] 알 수 없는 플랫폼: ${platform}`);
      return null;
    }

    const snap = await ref.get();
    if (!snap.exists) {
      console.warn(`[presetPipeline] 리포트 없음 — platform: ${platform}, targetId: ${targetId}, date: ${date}`);
      return null;
    }
    return snap.data();
  } catch (err) {
    console.error(`[presetPipeline] 리포트 조회 오류 — ${platform}/${targetId}: ${err.message}`);
    return null;
  }
}

/**
 * 활성 프리셋 전체를 순회하며 통합 이메일 발송
 * @param {string|null} filterWorkspaceId
 * @param {string|null} targetDate      YYYY-MM-DD (null → KST 어제)
 * @param {string|null} filterPresetId  특정 프리셋 ID (null → 활성 프리셋 전체)
 */
async function runReportPresetPipeline(filterWorkspaceId = null, targetDate = null, filterPresetId = null) {
  const db = admin.firestore();
  const date = targetDate || getKSTYesterdayString();
  const workspaceId = filterWorkspaceId || DEFAULT_WORKSPACE;

  console.log(`[presetPipeline] 시작 — workspaceId: ${workspaceId}, date: ${date}, presetId: ${filterPresetId || "전체"}`);

  let presetsSnap;
  if (filterPresetId) {
    const docSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("report_presets").doc(filterPresetId)
      .get();
    presetsSnap = { empty: !docSnap.exists, docs: docSnap.exists ? [docSnap] : [] };
  } else {
    presetsSnap = await db
      .collection("workspaces").doc(workspaceId)
      .collection("report_presets")
      .where("isActive", "==", true)
      .get();
  }

  if (presetsSnap.empty) {
    console.log("[presetPipeline] 활성 프리셋 없음 — 종료");
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const results = { processed: 0, skipped: 0, errors: 0 };

  for (const presetDoc of presetsSnap.docs) {
    const preset = presetDoc.data();
    const { name: presetName, items = [], recipients = [] } = preset;

    if (!recipients.length) {
      console.warn(`[presetPipeline] 수신자 없음 — preset: ${presetName}`);
      results.skipped++;
      continue;
    }
    if (!items.length) {
      console.warn(`[presetPipeline] 항목 없음 — preset: ${presetName}`);
      results.skipped++;
      continue;
    }

    const settled = await Promise.all(items.map(item =>
      fetchReportForItem(db, workspaceId, item, date)
        .then(report => report ? { platform: item.platform, targetName: item.targetName, report } : null)
    ));
    const sections = settled.filter(Boolean);

    if (!sections.length) {
      console.warn(`[presetPipeline] 유효한 리포트 없음 — preset: ${presetName}, date: ${date}`);
      results.skipped++;
      continue;
    }

    try {
      await sendUnifiedEmailReport({ recipients, presetName, date, sections });
      console.log(`[presetPipeline] 발송 완료 — preset: ${presetName}, 섹션: ${sections.length}개`);
      results.processed++;
    } catch (err) {
      console.error(`[presetPipeline] 이메일 발송 오류 — preset: ${presetName}: ${err.message}`);
      results.errors++;
    }
  }

  console.log(`[presetPipeline] 완료 — ${JSON.stringify(results)}`);
  return results;
}

module.exports = { runReportPresetPipeline };
