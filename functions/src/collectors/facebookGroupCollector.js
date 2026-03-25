/**
 * facebookGroupCollector.js
 * Playwright + @sparticuz/chromium 기반 Facebook 공개 그룹 크롤러
 *
 * 주요 함수:
 *   launchBrowser()                          — 헤드리스 Chromium 실행
 *   loadSessionFromFirestore(db, wsId)       — Firestore에서 쿠키 로드
 *   saveSessionToFirestore(db, wsId, data)   — Firestore에 쿠키 저장
 *   markSessionInvalid(db, wsId)             — 세션 만료 마킹
 *   applyCookiesToContext(context, cookies)  — BrowserContext에 쿠키 주입
 *   verifySessionAlive(page)                 — 로그인 유효성 확인
 *   collectGroupPosts(page, groupUrl, date)  — 해당일 게시글 수집
 *   collectPostComments(page, postUrl)       — 게시글 전체 댓글 수집
 */

const chromium = require("@sparticuz/chromium");
const { chromium: playwrightChromium } = require("playwright-core");
const admin = require("firebase-admin");

// ── 상수 ─────────────────────────────────────────────────────────
const SCROLL_MAX = 40;            // 최대 스크롤 횟수
const SCROLL_STEP_PX = 1200;      // 1회 스크롤 픽셀
const NETWORKIDLE_TIMEOUT = 30000; // networkidle 최대 대기 ms
const POST_SCROLL_WAIT_MS = 3000; // 스크롤 후 대기 ms
const COMMENT_BTN_DELAY_MS = 1500; // 댓글 더보기 클릭 후 대기 ms
const COMMENT_EXPAND_MAX = 30;    // 댓글 더보기 클릭 최대 횟수

// ── 브라우저 실행 ──────────────────────────────────────────────────
async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
  return browser;
}

// ── 세션 로드 ─────────────────────────────────────────────────────
async function loadSessionFromFirestore(db, workspaceId) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("facebook_session")
    .doc("main");
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data(); // { cookies[], userAgent, isValid, savedAt }
}

// ── 세션 저장 ─────────────────────────────────────────────────────
async function saveSessionToFirestore(db, workspaceId, { cookies, userAgent = "" }) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("facebook_session")
    .doc("main");
  await ref.set(
    {
      cookies,
      userAgent,
      isValid: true,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastValidatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// ── 세션 만료 마킹 ────────────────────────────────────────────────
async function markSessionInvalid(db, workspaceId) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("facebook_session")
    .doc("main");
  await ref.set({ isValid: false }, { merge: true });
}

// ── 쿠키 주입 ─────────────────────────────────────────────────────
async function applyCookiesToContext(context, cookies) {
  if (!cookies || cookies.length === 0) return;

  // sameSite 정규화 맵 (브라우저 익스텐션 export → Playwright 기대값)
  const sameSiteMap = {
    strict: "Strict",
    lax: "Lax",
    none: "None",
    no_restriction: "None",  // Chrome DevTools 내보내기 값
    unspecified: undefined,
  };

  const sanitized = cookies
    .map((c) => {
      // Playwright가 인식하는 필드만 추출
      // expirationDate(브라우저) → expires(Playwright) 리매핑
      const cookie = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
      };

      // 만료일: expirationDate(브라우저 export) 또는 expires 둘 다 지원
      const expiry = c.expires ?? c.expirationDate;
      if (expiry && !c.session) {
        cookie.expires = Math.floor(expiry); // Playwright는 정수 Unix timestamp
      }

      // sameSite 정규화
      const rawSameSite = (c.sameSite ?? "").toLowerCase();
      const normalizedSameSite = sameSiteMap[rawSameSite];
      if (normalizedSameSite) {
        cookie.sameSite = normalizedSameSite;
      }

      return cookie;
    })
    .filter((c) => c.name && c.value); // name/value 없는 쿠키 제거

  console.log(`[facebookGroupCollector] 쿠키 ${sanitized.length}개 주입`);
  await context.addCookies(sanitized);
}

// ── 세션 유효성 확인 ─────────────────────────────────────────────
async function verifySessionAlive(page) {
  try {
    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: NETWORKIDLE_TIMEOUT,
    });
    const url = page.url();
    if (
      url.includes("/login") ||
      url.includes("login.php") ||
      url.includes("/checkpoint/") ||
      url.includes("/two_step_verification/")
    ) return false;
    // 로그인 버튼이 존재하면 미로그인 상태
    const loginBtn = await page.$('button[name="login"], [data-testid="royal_login_button"]');
    return !loginBtn;
  } catch (err) {
    console.error("[facebookGroupCollector] verifySessionAlive 오류:", err.message);
    return false;
  }
}

// ── 그룹 게시글 수집 ──────────────────────────────────────────────
/**
 * Facebook 현재 DOM: abbr[data-utime] 제거됨
 * → a[aria-label] 상대시간("2시간", "어제", "3월 17일" 등)으로 날짜 추정
 *
 * @param {import('playwright-core').Page} page
 * @param {string} groupUrl  Facebook 그룹 URL
 * @param {string} targetDate  'YYYY-MM-DD' (KST 기준)
 * @returns {{ posts: object[], skipped: boolean }}
 */
async function collectGroupPosts(page, groupUrl, targetDate) {
  console.log(`[facebookGroupCollector] 그룹 이동: ${groupUrl} | 대상 날짜: ${targetDate}`);

  const base = groupUrl.replace(/\/$/, "");
  const sortedUrl = `${base}/?sorting_setting=CHRONOLOGICAL`;

  await page.goto(sortedUrl, { waitUntil: "networkidle", timeout: NETWORKIDLE_TIMEOUT });

  // 이동 후 인증 화면(계정 선택·비번 요구·체크포인트) 감지 → 세션 만료로 처리
  const afterGotoUrl = page.url();
  if (
    afterGotoUrl.includes("/login") ||
    afterGotoUrl.includes("login.php") ||
    afterGotoUrl.includes("/checkpoint/") ||
    afterGotoUrl.includes("/two_step_verification/")
  ) {
    console.warn(`[facebookGroupCollector] 그룹 이동 후 인증 화면 감지 (${afterGotoUrl}) — SESSION_EXPIRED`);
    throw new Error("SESSION_EXPIRED");
  }

  const seenUrls = new Set();
  const posts = [];
  let reachedOlder = false;

  for (let i = 0; i < SCROLL_MAX; i++) {
    const parsed = await page.evaluate((_td) => {
      const KST_OFFSET = 9 * 60 * 60 * 1000;
      const nowMs = Date.now();

      /**
       * aria-label 상대시간 → KST 'YYYY-MM-DD'
       * 처리 패턴 (한국어/영어):
       *   "X초" / "Xs"               → 오늘
       *   "X분" / "Xm"               → 오늘
       *   "X시간" / "Xh" / "X hours" → 해당 시각 기준 날짜
       *   "어제" / "Yesterday"        → 어제
       *   "X일" / "Xd"               → X일 전
       *   "M월 D일" / "Month D"       → 당해연도 해당 날짜
       *   "YYYY년 M월 D일"            → 해당 날짜
       */
      function labelToKSTDate(label) {
        if (!label) return null;
        const l = label.trim();
        const toKST = (ms) => {
          const d = new Date(ms + KST_OFFSET);
          return [
            d.getUTCFullYear(),
            String(d.getUTCMonth() + 1).padStart(2, "0"),
            String(d.getUTCDate()).padStart(2, "0"),
          ].join("-");
        };

        // 초
        if (/^\d+초$|^\d+s$/.test(l)) return toKST(nowMs);
        // 분
        const minM = l.match(/^(\d+)분$|^(\d+)m$/);
        if (minM) return toKST(nowMs - (minM[1] || minM[2]) * 60 * 1000);
        // 시간
        const hrM = l.match(/^(\d+)시간$|^(\d+)h$|^(\d+)\s*hours?$/i);
        if (hrM) return toKST(nowMs - (hrM[1] || hrM[2] || hrM[3]) * 3600 * 1000);
        // 어제
        if (/^어제$|^yesterday$/i.test(l)) return toKST(nowMs - 86400 * 1000);
        // X일
        const dayM = l.match(/^(\d+)일$|^(\d+)d$|^(\d+)\s*days?$/i);
        if (dayM) return toKST(nowMs - (dayM[1] || dayM[2] || dayM[3]) * 86400 * 1000);
        // M월 D일 / Month D
        const mdM = l.match(/^(\d+)월\s*(\d+)일$|^([A-Za-z]+)\s+(\d+)$/);
        if (mdM) {
          const nowKST = new Date(nowMs + KST_OFFSET);
          const year = nowKST.getUTCFullYear();
          if (mdM[1]) {
            return `${year}-${String(mdM[1]).padStart(2, "0")}-${String(mdM[2]).padStart(2, "0")}`;
          }
          // 영어 월 이름 처리 ("March 17" 등)
          const MONTH_MAP = {
            january:1, february:2, march:3, april:4, may:5, june:6,
            july:7, august:8, september:9, october:10, november:11, december:12,
            jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
          };
          if (mdM[3]) {
            const month = MONTH_MAP[mdM[3].toLowerCase()];
            if (month) {
              return `${year}-${String(month).padStart(2, "0")}-${String(mdM[4]).padStart(2, "0")}`;
            }
          }
        }
        // YYYY년 M월 D일
        const fullM = l.match(/^(\d{4})년\s*(\d+)월\s*(\d+)일$/);
        if (fullM) {
          return `${fullM[1]}-${String(fullM[2]).padStart(2, "0")}-${String(fullM[3]).padStart(2, "0")}`;
        }
        return null;
      }

      const results = [];
      const articles = document.querySelectorAll('[role="article"]');

      for (const art of articles) {
        // ── 타임스탬프: aria-label이 상대시간인 <a> 태그 탐색 ──
        const allLinks = art.querySelectorAll("a[aria-label]");
        let kstDate = null;
        let postUrl = "";

        for (const link of allLinks) {
          const label = link.getAttribute("aria-label") || "";
          const date = labelToKSTDate(label);
          if (date) {
            kstDate = date;
            postUrl = link.href.split("?")[0];
            break;
          }
        }
        if (!kstDate || !postUrl) continue;

        // ── 게시글 텍스트 ──
        const textEl =
          art.querySelector('[data-ad-comet-preview="message"]') ||
          art.querySelector('[dir="auto"]');
        const text = textEl ? textEl.innerText.trim().slice(0, 2000) : "";

        // ── 작성자 ──
        const authorEl = art.querySelector("h2 a, h3 a, strong a");
        const authorName = authorEl ? authorEl.innerText.trim() : "";

        // ── 반응 수 ──
        let reactions = 0;
        const reactionEl = art.querySelector(
          '[aria-label*="reaction"], [aria-label*="명이"], [aria-label*="개의 반응"]'
        );
        if (reactionEl) {
          const m = reactionEl.getAttribute("aria-label").match(/[\d,]+/);
          if (m) reactions = parseInt(m[0].replace(/,/g, ""), 10);
        }

        // ── 첨부 이미지 URL (fbcdn CDN, 최대 3장) ──
        const imageUrls = Array.from(art.querySelectorAll("img"))
          .map((img) => img.src)
          .filter(
            (src) =>
              src &&
              src.includes("fbcdn") &&
              src.length > 100 &&
              !src.includes("emoji") &&
              !src.includes("rsrc.php")
          )
          .slice(0, 3);

        results.push({ kstDate, postUrl, text, authorName, reactions, imageUrls });
      }
      return results;
    }, targetDate);

    for (const p of parsed) {
      if (p.kstDate < targetDate) {
        reachedOlder = true;
        break;
      }
      if (p.kstDate === targetDate && !seenUrls.has(p.postUrl)) {
        seenUrls.add(p.postUrl);
        posts.push({
          postUrl: p.postUrl,
          authorName: p.authorName,
          text: p.text,
          publishedAt: new Date().toISOString(), // 정확한 utime 없으므로 수집 시각 사용
          reactions: p.reactions,
          imageUrls: p.imageUrls || [],
          comments: [],
          commentCount: 0,
        });
      }
    }

    if (reachedOlder) {
      console.log(
        `[facebookGroupCollector] targetDate 이전 게시글 발견 — 스크롤 종료 (수집: ${posts.length}개)`
      );
      break;
    }

    const prevCount = posts.length;
    await page.evaluate((step) => window.scrollBy(0, step), SCROLL_STEP_PX);
    await new Promise((r) => setTimeout(r, POST_SCROLL_WAIT_MS));
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // networkidle 타임아웃은 무시 (동적 피드에서 정상)
    }

    if (posts.length === prevCount && i > 5) {
      console.log(
        `[facebookGroupCollector] 새 게시글 없음 — 스크롤 종료 (수집: ${posts.length}개)`
      );
      break;
    }
  }

  if (posts.length === 0) {
    console.log(`[facebookGroupCollector] ${targetDate} 게시글 없음 — skip`);
    return { posts: [], skipped: true };
  }

  console.log(`[facebookGroupCollector] 게시글 ${posts.length}개 수집 완료`);
  return { posts, skipped: false };
}

// ── 게시글 첨부 이미지 base64 변환 ───────────────────────────────
/**
 * 브라우저 컨텍스트(쿠키 인증 포함)로 이미지 URL을 fetch → base64 변환
 *
 * @param {import('playwright-core').Page} page
 * @param {string[]} imageUrls  fbcdn CDN 이미지 URL 배열 (최대 3개 권장)
 * @returns {Promise<Array<{base64: string, mimeType: string}|null>>}
 */
async function fetchPostImages(page, imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return [];

  try {
    const results = await page.evaluate(async (urls) => {
      const out = [];
      for (const url of urls) {
        try {
          const resp = await fetch(url, { credentials: "include" });
          if (!resp.ok) { out.push(null); continue; }

          const mimeType = (resp.headers.get("content-type") || "image/jpeg")
            .split(";")[0]
            .trim();

          const buffer  = await resp.arrayBuffer();
          const bytes   = new Uint8Array(buffer);
          const chunkSz = 8192;
          let binary    = "";
          for (let i = 0; i < bytes.byteLength; i += chunkSz) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSz, bytes.byteLength)));
          }
          out.push({ base64: btoa(binary), mimeType });
        } catch (_) {
          out.push(null);
        }
      }
      return out;
    }, imageUrls);

    return results.filter(Boolean);
  } catch (err) {
    console.warn("[facebookGroupCollector] fetchPostImages 실패:", err.message);
    return [];
  }
}

// ── 게시글 댓글 전체 수집 ────────────────────────────────────────
/**
 * @param {import('playwright-core').Page} page
 * @param {string} postUrl  게시글 퍼말링크
 * @returns {{ comments: object[], error: string|null }}
 */
async function collectPostComments(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: "networkidle", timeout: NETWORKIDLE_TIMEOUT });

    // 이동 후 인증 화면 감지
    const commentPageUrl = page.url();
    if (
      commentPageUrl.includes("/login") ||
      commentPageUrl.includes("login.php") ||
      commentPageUrl.includes("/checkpoint/") ||
      commentPageUrl.includes("/two_step_verification/")
    ) {
      console.warn(`[facebookGroupCollector] 댓글 페이지 이동 후 인증 화면 감지 — SESSION_EXPIRED`);
      throw new Error("SESSION_EXPIRED");
    }

    // "댓글 더 보기" 반복 클릭
    let clickCount = 0;
    while (clickCount < COMMENT_EXPAND_MAX) {
      // 다국어 지원: 한국어 / 영어 버튼 모두 탐색
      const moreBtn = await page.$(
        '[role="button"]:text-is("댓글 더 보기"), [role="button"]:text-is("View more comments"), [role="button"]:text-is("더 보기")'
      );
      if (!moreBtn) break;

      try {
        await moreBtn.click();
        await new Promise((r) => setTimeout(r, COMMENT_BTN_DELAY_MS));
        await page.waitForLoadState("networkidle", { timeout: 5000 });
      } catch {
        // 클릭 중 오류는 무시하고 루프 종료
        break;
      }
      clickCount++;
    }

    // 댓글 추출
    const comments = await page.evaluate(() => {
      const results = [];
      // 댓글 컨테이너: role="article" 하위의 중첩 role="article"
      // 최상위 post article 제외 (depth 기준)
      const allArticles = Array.from(document.querySelectorAll('[role="article"]'));

      // 첫 번째 article이 포스트 본문이므로 나머지에서 댓글 추출
      const commentArticles = allArticles.slice(1);

      for (const el of commentArticles) {
        // 텍스트 추출: [dir="auto"] 첫 번째
        const textEl = el.querySelector('[dir="auto"]');
        const text = textEl ? textEl.innerText.trim() : "";
        if (!text) continue;

        // 작성자
        const authorEl = el.querySelector("a[role='link'] span, h3 a, strong a");
        const author = authorEl ? authorEl.innerText.trim() : "";

        // 좋아요 수
        let likesCount = 0;
        const likeEl = el.querySelector('[aria-label*="Like"], [aria-label*="좋아요"]');
        if (likeEl) {
          const m = likeEl.getAttribute("aria-label").match(/\d+/);
          if (m) likesCount = parseInt(m[0], 10);
        }

        results.push({ author, text, likesCount });
      }
      return results;
    });

    return { comments, error: null };
  } catch (err) {
    console.error(
      `[facebookGroupCollector] collectPostComments 오류 (${postUrl}): ${err.message}`
    );
    return { comments: [], error: err.message };
  }
}

module.exports = {
  launchBrowser,
  loadSessionFromFirestore,
  saveSessionToFirestore,
  markSessionInvalid,
  applyCookiesToContext,
  verifySessionAlive,
  collectGroupPosts,
  collectPostComments,
  fetchPostImages,
};
