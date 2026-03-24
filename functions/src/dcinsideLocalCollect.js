"use strict";

/**
 * dcinsideLocalCollect.js
 * Mac Mini에서 직접 실행하는 DCInside 수집 스크립트.
 * Cloud Run 대신 로컬 IP로 DCInside에 접근하여 수집 후 Firestore에 저장한다.
 *
 * 실행:
 *   cd functions
 *   node src/dcinsideLocalCollect.js              # KST 어제 날짜
 *   node src/dcinsideLocalCollect.js 2026-03-23   # 특정 날짜
 */

const os = require("os");
const path = require("path");
const admin = require("firebase-admin");

// serviceAccountKey.json은 functions/ 디렉토리에 위치해야 함
const serviceAccount = require(path.join(__dirname, "../serviceAccountKey.json"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const {
  loadDcSession,
  markDcSessionInvalid,
  collectGalleryPosts,
} = require("./collectors/dcinsideCollector");
const { getKSTYesterdayString } = require("./utils/dateUtils");

const WORKSPACE_ID = "ws_antigravity";
const GALLERY_GAP_MS = 3000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const targetDate = process.argv[2] || getKSTYesterdayString();
  console.log(`[DC Local Collect] 시작 — date: ${targetDate}, host: ${os.hostname()}`);

  // ── 세션 로드 ──────────────────────────────────────────────────
  let session;
  try {
    session = await loadDcSession(db, WORKSPACE_ID);
  } catch (err) {
    console.error("[DC Local Collect] 세션 로드 실패:", err.message);
    process.exit(1);
  }

  if (!session || !session.cookieHeader || !session.userAgent) {
    console.error("[DC Local Collect] 유효한 세션 없음 — 대시보드에서 세션을 등록해 주세요.");
    process.exit(1);
  }

  // ── 갤러리 목록 조회 ───────────────────────────────────────────
  const gallerySnap = await db
    .collection("workspaces")
    .doc(WORKSPACE_ID)
    .collection("dcinside_galleries")
    .where("isActive", "==", true)
    .get();

  if (gallerySnap.empty) {
    console.log("[DC Local Collect] 활성 갤러리 없음 — 종료");
    process.exit(0);
  }

  const collectorHost = os.hostname();
  let processed = 0;
  let skippedCount = 0;
  let errors = 0;

  // ── 갤러리 순회 ────────────────────────────────────────────────
  for (const gDoc of gallerySnap.docs) {
    const gData = gDoc.data();
    const galleryId   = gData.galleryId   || "";
    const galleryType = gData.galleryType || "general";
    const galleryName = gData.galleryName || galleryId;
    const galleryUrl  = gData.galleryUrl  || "";

    if (!galleryId) {
      console.warn(`[DC Local Collect] galleryId 없음 — skip (${gDoc.id})`);
      skippedCount++;
      continue;
    }

    console.log(`[DC Local Collect] 수집 중: ${galleryName} (${galleryId})`);

    try {
      const { posts, skipped } = await collectGalleryPosts({
        session,
        galleryId,
        galleryType,
        targetDate,
      });

      const docRef = db
        .collection("workspaces").doc(WORKSPACE_ID)
        .collection("dcinside_collected").doc(targetDate)
        .collection("galleries").doc(gDoc.id);

      await db
        .collection("workspaces").doc(WORKSPACE_ID)
        .collection("dcinside_collected").doc(targetDate)
        .set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      await docRef.set({
        galleryId,
        galleryName,
        galleryType,
        galleryUrl,
        date:          targetDate,
        posts:         skipped ? [] : posts,
        postCount:     skipped ? 0 : posts.length,
        skipped:       !!skipped,
        collectedAt:   admin.firestore.FieldValue.serverTimestamp(),
        collectorHost,
      });

      if (skipped) {
        console.log(`[DC Local Collect] ${galleryName}: 해당일 게시글 없음 — skip`);
        skippedCount++;
      } else {
        console.log(`[DC Local Collect] ${galleryName}: ${posts.length}개 저장 완료`);
        processed++;
      }
    } catch (err) {
      if (err.code === "DC_AUTH") {
        console.error("[DC Local Collect] 세션 만료 감지 — isValid=false 마킹 후 종료");
        await markDcSessionInvalid(db, WORKSPACE_ID);
        process.exit(1);
      }
      console.error(`[DC Local Collect] ${galleryName} 오류: ${err.message}`);
      errors++;
    }

    await sleep(GALLERY_GAP_MS);
  }

  console.log(
    `[DC Local Collect] 완료 — processed: ${processed}, skipped: ${skippedCount}, errors: ${errors}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[DC Local Collect] 치명적 오류:", err);
  process.exit(1);
});
