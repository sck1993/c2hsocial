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
const { sendUnifiedEmailReport } = require("./reportPresetDelivery");
const { logDelivery, logDeliveryFailure } = require("./reportDelivery");
const { getKSTYesterdayString } = require("./utils/dateUtils");

const DEFAULT_WORKSPACE = "ws_antigravity";

/**
 * 플랫폼별 Firestore 경로로 해당 날짜 리포트를 조회
 * @returns {object|null} 리포트 데이터 (없으면 null)
 */
async function fetchReportForItem(db, workspaceId, item, date, cache = null) {
  const { platform, targetId } = item;
  const cacheKey = `${workspaceId}::${date}::${platform}::${targetId}`;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  try {
    let ref;
    if (platform === "discord") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("reports").doc(date)
        .collection("guilds").doc(targetId);
    } else if (platform === "instagram") {
      const docId = targetId.startsWith("instagram_") ? targetId : `instagram_${targetId}`;
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("instagram_reports").doc(date)
        .collection("accounts").doc(docId);
    } else if (platform === "facebook") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("facebook_reports").doc(date)
        .collection("groups").doc(targetId);
    } else if (platform === "naver_lounge") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("naver_reports").doc(date)
        .collection("lounges").doc(targetId);
    } else if (platform === "facebook_page") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("facebook_page_reports").doc(date)
        .collection("pages").doc(targetId);
    } else if (platform === "dcinside") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("dcinside_reports").doc(date)
        .collection("galleries").doc(targetId);
    } else if (platform === "youtube") {
      ref = db.collection("workspaces").doc(workspaceId)
        .collection("youtube_reports").doc(date)
        .collection("groups").doc(targetId);
    } else {
      console.warn(`[presetPipeline] 알 수 없는 플랫폼: ${platform}`);
      return null;
    }

    const snap = await ref.get();
    if (!snap.exists) {
      console.warn(`[presetPipeline] 리포트 없음 — platform: ${platform}, targetId: ${targetId}, date: ${date}`);
      if (cache) cache.set(cacheKey, null);
      return null;
    }
    const data = snap.data();
    if (cache) cache.set(cacheKey, data);
    return data;
  } catch (err) {
    console.error(`[presetPipeline] 리포트 조회 오류 — ${platform}/${targetId}: ${err.message}`);
    if (cache) cache.set(cacheKey, null);
    return null;
  }
}

function resolvePresetEmailConfig(preset = {}) {
  const email = preset.deliveryConfig?.email || {};
  return {
    isEnabled: email.isEnabled !== false,
    recipientsKo: email.recipientsKo || preset.recipientsKo || email.recipients || preset.recipients || [],
    recipientsEn: email.recipientsEn || preset.recipientsEn || [],
  };
}

/**
 * 활성 프리셋 전체를 순회하며 통합 이메일 발송
 * @param {string|null} filterWorkspaceId
 * @param {string|null} targetDate      YYYY-MM-DD (null → KST 어제)
 * @param {string|null} filterPresetId  특정 프리셋 ID (null → 활성 프리셋 전체)
 */
async function runReportPresetPipeline(filterWorkspaceId = null, targetDate = null, filterPresetId = null, options = {}) {
  const { triggerSource = "schedule" } = options;
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
  const reportCache = new Map();

  for (const presetDoc of presetsSnap.docs) {
    const preset = presetDoc.data();
    const { name: presetName, nameEn = "", items = [], theme = {} } = preset;
    const emailConfig = resolvePresetEmailConfig(preset);
    const langRecipients = [
      { lang: "ko", recipients: emailConfig.recipientsKo || [] },
      { lang: "en_ko", recipients: emailConfig.recipientsEn || [] },
    ];
    const hasAnyRecipients = langRecipients.some(({ recipients }) => recipients.length > 0);

    if (!emailConfig.isEnabled || !hasAnyRecipients) {
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
      fetchReportForItem(db, workspaceId, item, date, reportCache)
        .then(report => report ? {
          platform: item.platform,
          targetName: item.targetName,
          targetNameEn: item.targetNameEn || report.groupNameEn || item.targetName,
          report,
        } : null)
    ));
    const sections = settled.filter(Boolean);

    if (!sections.length) {
      console.warn(`[presetPipeline] 유효한 리포트 없음 — preset: ${presetName}, date: ${date}`);
      results.skipped++;
      continue;
    }

    let sentAny = false;
    let hadError = false;
    const displayPresetNameKo = presetName;
    const displayPresetNameEn = String(nameEn || "").trim() || presetName;
    const localizedSectionsKo = sections.map((section) => ({
      ...section,
      targetName: section.targetName,
    }));
    const localizedSectionsEn = sections.map((section) => ({
      ...section,
      targetName: String(section.targetNameEn || "").trim() || section.targetName,
    }));
    for (const { lang, recipients } of langRecipients) {
      if (!recipients.length) continue;
      const isEnglishBundle = lang === "en_ko";
      const displayPresetName = isEnglishBundle ? displayPresetNameEn : displayPresetNameKo;
      const localizedSections = isEnglishBundle ? localizedSectionsEn : localizedSectionsKo;
      try {
        await sendUnifiedEmailReport({
          recipients,
          presetName: displayPresetName,
          presetNameKo: displayPresetNameKo,
          presetNameEn: displayPresetNameEn,
          date,
          sections: localizedSections,
          sectionsKo: isEnglishBundle ? localizedSectionsKo : null,
          theme,
          lang,
        });
        console.log(`[presetPipeline] 발송 완료 — preset: ${presetName}, lang: ${lang}, 섹션: ${localizedSections.length}개`);
        logDelivery(db, workspaceId, {
          platform: "report_preset",
          target: presetName,
          targetId: presetDoc.id,
          reportType: "preset",
          reportDate: date,
          lang,
          recipientCount: recipients.length,
          triggerSource,
        });
        sentAny = true;
      } catch (err) {
        console.error(`[presetPipeline] 이메일 발송 오류 — preset: ${presetName}, lang: ${lang}: ${err.message}`);
        logDeliveryFailure(db, workspaceId, {
          platform: "report_preset",
          target: presetName,
          targetId: presetDoc.id,
          reportType: "preset",
          reportDate: date,
          lang,
          recipientCount: recipients.length,
          triggerSource,
          errorMessage: err.message,
        });
        hadError = true;
      }
    }

    if (sentAny) results.processed++;
    if (hadError) {
      results.errors++;
    }
  }

  console.log(`[presetPipeline] 완료 — ${JSON.stringify(results)}`);
  return results;
}

module.exports = { runReportPresetPipeline };
