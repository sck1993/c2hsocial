/**
 * naverLoungeCollector.js
 * Playwright + @sparticuz/chromium 기반 네이버 라운지 크롤러
 *
 * 주요 함수:
 *   launchBrowser()                           — 헤드리스 Chromium 실행
 *   loadSessionFromFirestore(db, wsId)        — Firestore에서 쿠키 로드
 *   saveSessionToFirestore(db, wsId, data)    — Firestore에 쿠키 저장
 *   markSessionInvalid(db, wsId)              — 세션 만료 마킹
 *   applyCookiesToContext(context, cookies)   — BrowserContext에 쿠키 주입
 *   verifySessionAlive(page)                  — 로그인 유효성 확인
 *   collectLoungePosts(page, loungeUrl, date) — 해당일 게시글 목록 수집
 *   collectPostContent(page, postUrl)         — 게시글 상세 본문 수집
 *   collectPostComments(page, postUrl)        — 게시글 전체 댓글 수집
 *
 * NOTE: game.naver.com은 React/Next.js 기반이므로
 *       DOM 선택자는 실제 라이브 페이지에서 검증 후 조정 필요.
 */

const chromium = require("@sparticuz/chromium");
const { chromium: playwrightChromium } = require("playwright-core");
const admin = require("firebase-admin");

// ── 상수 ─────────────────────────────────────────────────────────
const NETWORKIDLE_TIMEOUT = 30000;   // networkidle 최대 대기 ms
const PAGE_WAIT_MS = 2000;           // 페이지 로드 후 추가 대기 ms
const COMMENT_BTN_DELAY_MS = 1500;   // 댓글 더보기 클릭 후 대기 ms
const COMMENT_EXPAND_MAX = 20;       // 댓글 더보기 클릭 최대 횟수
const POST_MAX = 50;                 // 최대 수집 게시글 수

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
    .collection("naver_session")
    .doc("main");
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data(); // { cookies[], userAgent, isValid, savedAt, lastValidatedAt }
}

// ── 세션 저장 ─────────────────────────────────────────────────────
async function saveSessionToFirestore(db, workspaceId, { cookies, userAgent = "" }) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("naver_session")
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
    .collection("naver_session")
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
    no_restriction: "None",
    unspecified: undefined,
  };

  const sanitized = cookies
    .filter((c) => {
      // .naver.com 계열 쿠키만 주입
      const domain = String(c.domain || "");
      return domain.includes("naver.com");
    })
    .map((c) => {
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
        cookie.expires = Math.floor(expiry);
      }

      // sameSite 정규화
      const rawSameSite = (c.sameSite ?? "").toLowerCase();
      const normalizedSameSite = sameSiteMap[rawSameSite];
      if (normalizedSameSite) {
        cookie.sameSite = normalizedSameSite;
      }

      return cookie;
    })
    .filter((c) => c.name && c.value);

  console.log(`[naverLoungeCollector] 쿠키 ${sanitized.length}개 주입`);
  await context.addCookies(sanitized);
}

// ── 세션 유효성 확인 ─────────────────────────────────────────────
/**
 * www.naver.com 접속 후 로그인 상태 감지
 * NOTE: 실제 naver.com DOM 구조에서 선택자 검증 필요
 */
async function verifySessionAlive(page) {
  try {
    await page.goto("https://www.naver.com/", {
      waitUntil: "domcontentloaded",
      timeout: NETWORKIDLE_TIMEOUT,
    });
    // 로그인 링크 존재 = 미로그인 상태
    const loginLink = await page.$(
      'a[href*="nid.naver.com/nidlogin"], a[href*="login.naver.com"]'
    );
    return !loginLink;
  } catch (err) {
    console.error("[naverLoungeCollector] verifySessionAlive 오류:", err.message);
    return false;
  }
}

// ── 라운지 게시글 목록 수집 ──────────────────────────────────────
/**
 * 네이버 라운지 게시판 목록 크롤링
 *
 * URL 구조: https://game.naver.com/lounge/{loungeId}/board
 * 게시글 URL 구조: https://game.naver.com/lounge/{loungeId}/board/view/{articleId}
 *
 * NOTE: game.naver.com은 React 기반 동적 렌더링.
 *       아래 선택자는 실제 DOM에서 검증 필요.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} loungeUrl  라운지 보드 URL
 * @param {string} targetDate  'YYYY-MM-DD' (KST 기준)
 * @returns {{ posts: object[], skipped: boolean }}
 */
async function collectLoungePosts(page, loungeUrl, targetDate) {
  console.log(
    `[naverLoungeCollector] 라운지 이동: ${loungeUrl} | 대상 날짜: ${targetDate}`
  );

  await page.goto(loungeUrl, { waitUntil: "networkidle", timeout: NETWORKIDLE_TIMEOUT });
  await new Promise((r) => setTimeout(r, PAGE_WAIT_MS));

  const postLinks = await page.evaluate((td) => {
    const results = [];
    const KST_OFFSET = 9 * 60 * 60 * 1000;
    const nowMs = Date.now();

    function toKST(ms) {
      const d = new Date(ms + KST_OFFSET);
      return [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0"),
      ].join("-");
    }

    /**
     * 날짜 텍스트 → 'YYYY-MM-DD' (KST)
     * 지원 패턴: "방금 전", "X분 전", "X시간 전", "어제", "YYYY.MM.DD", "MM.DD."
     */
    function parseDateText(t) {
      if (!t) return null;
      const s = t.trim();
      if (/방금|초 전/.test(s)) return toKST(nowMs);
      if (/분 전/.test(s)) return toKST(nowMs);
      if (/시간 전/.test(s)) {
        const m = s.match(/(\d+)시간/);
        const hrs = m ? parseInt(m[1], 10) : 1;
        return toKST(nowMs - hrs * 3600 * 1000);
      }
      if (/어제/.test(s)) return toKST(nowMs - 86400 * 1000);
      // YYYY.MM.DD 또는 YYYY-MM-DD
      const fullM = s.match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
      if (fullM) {
        return `${fullM[1]}-${String(fullM[2]).padStart(2, "0")}-${String(
          fullM[3]
        ).padStart(2, "0")}`;
      }
      // MM.DD. (당해 연도)
      const shortM = s.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
      if (shortM) {
        const nowKST = new Date(nowMs + KST_OFFSET);
        return `${nowKST.getUTCFullYear()}-${String(shortM[1]).padStart(
          2,
          "0"
        )}-${String(shortM[2]).padStart(2, "0")}`;
      }
      return null;
    }

    // ── 게시글 아이템 선택자 (우선순위 순으로 시도) ──
    // NOTE: 아래 선택자는 game.naver.com 실제 DOM에서 검증 필요
    const itemSelectors = [
      "ul.board_list li",
      "ul.article_list li",
      "li[class*='BoardItem']",
      "li[class*='board_item']",
      "li[class*='article']",
    ];

    let items = [];
    for (const sel of itemSelectors) {
      try {
        items = Array.from(document.querySelectorAll(sel));
        if (items.length > 0) break;
      } catch (_) {}
    }

    // 폴백: /board/view/ 링크를 갖는 부모 요소 탐색
    if (items.length === 0) {
      const links = Array.from(
        document.querySelectorAll('a[href*="/board/view/"]')
      );
      const seen = new Set();
      for (const link of links) {
        const parent =
          link.closest("li") ||
          link.closest("article") ||
          link.parentElement;
        if (parent && !seen.has(parent)) {
          seen.add(parent);
          items.push(parent);
        }
      }
    }

    for (const item of items) {
      // ── 게시글 URL ──
      const linkEl = item.querySelector('a[href*="/board/view/"]');
      if (!linkEl) continue;
      const postUrl = linkEl.href;

      // ── 날짜 ──
      let kstDate = null;
      // time[datetime] 속성 우선
      const timeEl = item.querySelector("time[datetime]");
      if (timeEl) {
        const dt = timeEl.getAttribute("datetime");
        const m = dt.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (m) kstDate = `${m[1]}-${m[2]}-${m[3]}`;
      }
      // 없으면 텍스트 파싱
      if (!kstDate) {
        const dateEl = item.querySelector(
          ".date, .time, [class*='date'], [class*='time'], .num"
        );
        if (dateEl) kstDate = parseDateText(dateEl.innerText.trim());
      }
      if (!kstDate) continue;

      // ── 제목 ──
      const titleEl = item.querySelector(
        ".title, .subject, [class*='title'], [class*='subject'], strong"
      );
      const title = titleEl
        ? titleEl.innerText.trim()
        : linkEl.innerText.trim();

      // ── 작성자 ──
      const authorEl = item.querySelector(
        ".nick, .author, .writer, [class*='nick'], [class*='author'], [class*='writer']"
      );
      const authorName = authorEl ? authorEl.innerText.trim() : "";

      // ── 댓글 수 ──
      let commentCount = 0;
      const commentEl = item.querySelector(
        "[class*='comment'], [class*='reply']"
      );
      if (commentEl) {
        const m = commentEl.innerText.match(/\d+/);
        if (m) commentCount = parseInt(m[0], 10);
      }

      results.push({ postUrl, kstDate, title, authorName, commentCount });
    }

    return results;
  }, targetDate);

  // targetDate 해당 게시글만 필터링
  const seenUrls = new Set();
  const posts = [];
  for (const p of postLinks) {
    if (p.kstDate !== targetDate) continue;
    if (seenUrls.has(p.postUrl)) continue;
    seenUrls.add(p.postUrl);
    posts.push({
      postUrl: p.postUrl,
      title: p.title,
      authorName: p.authorName,
      text: "", // 본문은 collectPostContent에서 수집
      publishedAt: targetDate,
      commentCount: p.commentCount,
      comments: [],
    });
    if (posts.length >= POST_MAX) break;
  }

  if (posts.length === 0) {
    console.log(`[naverLoungeCollector] ${targetDate} 게시글 없음 — skip`);
    return { posts: [], skipped: true };
  }

  console.log(`[naverLoungeCollector] 게시글 ${posts.length}개 수집 완료`);
  return { posts, skipped: false };
}

// ── 게시글 상세 본문 수집 ─────────────────────────────────────────
/**
 * 게시글 상세 페이지에서 본문 텍스트 수집
 * NOTE: 본문 컨테이너 선택자는 실제 DOM에서 검증 필요
 *
 * @param {import('playwright-core').Page} page
 * @param {string} postUrl
 * @returns {{ text: string, error: string|null }}
 */
async function collectPostContent(page, postUrl) {
  try {
    await page.goto(postUrl, {
      waitUntil: "networkidle",
      timeout: NETWORKIDLE_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, PAGE_WAIT_MS));

    const text = await page.evaluate(() => {
      // 본문 컨테이너 선택자 (우선순위 순)
      // NOTE: game.naver.com 실제 DOM 구조에서 검증 필요
      const contentSelectors = [
        ".article_view",
        ".board_view_content",
        "[class*='ContentBody']",
        "[class*='content_body']",
        "[class*='article_body']",
        ".se-main-container", // 스마트에디터
        ".post-content",
      ];
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el) return el.innerText.trim().slice(0, 3000);
      }
      return "";
    });

    return { text, error: null };
  } catch (err) {
    console.error(
      `[naverLoungeCollector] collectPostContent 오류 (${postUrl}): ${err.message}`
    );
    return { text: "", error: err.message };
  }
}

// ── 게시글 댓글 수집 ─────────────────────────────────────────────
/**
 * @param {import('playwright-core').Page} page
 * @param {string} postUrl  게시글 URL (collectPostContent 이후 호출 시 재이동 없음)
 * @returns {{ comments: object[], error: string|null }}
 */
async function collectPostComments(page, postUrl) {
  try {
    // postUrl이 현재 페이지와 다르면 이동
    if (!page.url().includes(postUrl.split("?")[0])) {
      await page.goto(postUrl, {
        waitUntil: "networkidle",
        timeout: NETWORKIDLE_TIMEOUT,
      });
      await new Promise((r) => setTimeout(r, PAGE_WAIT_MS));
    }

    // "댓글 더 보기" 반복 클릭
    let clickCount = 0;
    while (clickCount < COMMENT_EXPAND_MAX) {
      const moreBtn = await page.$(
        '[class*="more_comment"], [class*="btn_more"], button:text-is("더보기"), button:text-is("댓글 더보기"), button:text-is("더 보기")'
      );
      if (!moreBtn) break;
      try {
        await moreBtn.click();
        await new Promise((r) => setTimeout(r, COMMENT_BTN_DELAY_MS));
      } catch {
        break;
      }
      clickCount++;
    }

    // 댓글 추출
    const comments = await page.evaluate(() => {
      const results = [];
      // 댓글 목록 선택자 (우선순위 순)
      // NOTE: game.naver.com 실제 DOM 구조에서 검증 필요
      const listSelectors = [
        ".comment_list li",
        ".reply_list li",
        "ul[class*='comment'] li",
        "ul[class*='reply'] li",
        "[class*='CommentList'] li",
      ];
      let items = [];
      for (const sel of listSelectors) {
        items = Array.from(document.querySelectorAll(sel));
        if (items.length > 0) break;
      }

      for (const item of items) {
        // 작성자
        const authorEl = item.querySelector(
          ".nick, .author, [class*='nick'], [class*='user_name'], [class*='UserName']"
        );
        const author = authorEl ? authorEl.innerText.trim() : "";

        // 댓글 텍스트
        const textEl = item.querySelector(
          ".comment_text, .text, [class*='comment_text'], [class*='CommentText'], [class*='content']"
        );
        const text = textEl ? textEl.innerText.trim() : "";
        if (!text) continue;

        results.push({ author, text });
      }
      return results;
    });

    return { comments, error: null };
  } catch (err) {
    console.error(
      `[naverLoungeCollector] collectPostComments 오류 (${postUrl}): ${err.message}`
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
  collectLoungePosts,
  collectPostContent,
  collectPostComments,
};
