"use strict";

/**
 * dcinsideCollector.js
 * HTTP 요청 기반 디시인사이드 갤러리 수집기
 *
 * 주요 함수:
 *   loadDcSession(db, wsId)           — Firestore에서 세션 로드
 *   saveDcSession(db, wsId, data)     — Firestore에 세션 저장
 *   markDcSessionInvalid(db, wsId)    — 세션 만료 마킹
 *   parseGalleryUrl(url)              — URL → { galleryId, galleryType }
 *   collectGalleryPosts(opts)         — 해당일 게시글 + 댓글 수집
 */

const axios = require("axios");
const cheerio = require("cheerio");
const admin = require("firebase-admin");

const POST_MAX = 300;
const COMMENT_MAX_PER_POST = 50;
const PAGE_REQUEST_DELAY_MS = 600;
const POST_REQUEST_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── URL 파싱 ─────────────────────────────────────────────────────

/**
 * 디시인사이드 갤러리 URL에서 galleryId와 galleryType을 추출
 * @param {string} url
 * @returns {{ galleryId: string, galleryType: 'minor'|'general' }}
 */
function parseGalleryUrl(url) {
  const str = String(url || "");
  const isMinor = /\/mgallery\//.test(str);
  const idMatch = str.match(/[?&]id=([^&\s]+)/);
  const galleryId = idMatch ? decodeURIComponent(idMatch[1]).trim() : "";
  return {
    galleryId,
    galleryType: isMinor ? "minor" : "general",
  };
}

/** galleryType → URL 경로 prefix */
function galleryBasePath(galleryType) {
  return galleryType === "minor" ? "mgallery/board" : "board";
}

// ── 세션 관리 ─────────────────────────────────────────────────────

async function loadDcSession(db, workspaceId) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("dcinside_session")
    .doc("main");
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data();
}

async function saveDcSession(db, workspaceId, { cookieHeader = "", userAgent = "" }) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("dcinside_session")
    .doc("main");
  await ref.set(
    {
      cookieHeader: String(cookieHeader || "").trim(),
      userAgent: String(userAgent || "").trim(),
      isValid: true,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastValidatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function markDcSessionInvalid(db, workspaceId) {
  const ref = db
    .collection("workspaces")
    .doc(workspaceId)
    .collection("dcinside_session")
    .doc("main");
  await ref.set({ isValid: false }, { merge: true });
}

// ── HTTP 헤더 ─────────────────────────────────────────────────────

function buildDcHeaders(session, referer = "https://gall.dcinside.com/") {
  const ua =
    (session && session.userAgent) ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const headers = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: referer,
    "User-Agent": ua,
  };
  if (session && session.cookieHeader) {
    headers["Cookie"] = session.cookieHeader;
  }
  return headers;
}

function buildDcAjaxHeaders(session, referer) {
  return {
    ...buildDcHeaders(session, referer),
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
  };
}

// ── 날짜 파싱 ─────────────────────────────────────────────────────

/**
 * 디시인사이드 날짜 문자열 → YYYY-MM-DD
 * 목록에서는 title 속성에 "YYYY.MM.DD HH:MM:SS" 또는 "YYYY-MM-DD HH:MM:SS" 형식으로 저장됨
 */
function parseDateKey(dateStr) {
  if (!dateStr) return "";
  const match = String(dateStr).match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// ── 게시글 목록 페이지 수집 ──────────────────────────────────────

async function fetchGalleryListPage({ session, galleryId, galleryType, page = 1 }) {
  const base = galleryBasePath(galleryType);
  const url = `https://gall.dcinside.com/${base}/lists/`;
  const referer = `https://gall.dcinside.com/${base}/lists/?id=${galleryId}`;

  const response = await axios.get(url, {
    params: {
      id: galleryId,
      page,
      list_num: 100,
      sort_type: "N",
      search_pos: "",
      s_type: "",
      s_keyword: "",
    },
    headers: buildDcHeaders(session, referer),
    responseType: "text",
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    const err = new Error(`[dcinsideCollector] 인증 실패 (${response.status})`);
    err.code = "DC_AUTH";
    throw err;
  }
  if (response.status >= 400) {
    throw new Error(`[dcinsideCollector] 목록 페이지 요청 실패 (${response.status})`);
  }

  return response.data;
}

function parseGalleryListHTML(html, galleryId, galleryType) {
  const $ = cheerio.load(html);
  const posts = [];

  $("tr.ub-content").each((_, tr) => {
    const $tr = $(tr);

    // 글 번호 (숫자만)
    const postNo = String($tr.attr("data-no") || $tr.find(".gall_num").text().trim()).trim();
    if (!postNo || !/^\d+$/.test(postNo)) return;

    // 공지·이벤트 제외
    const type = $tr.attr("data-type") || "";
    if (type.includes("icon_notice") || type.includes("icon_event") || type.includes("notice")) return;

    const $titleCell = $tr.find(".gall_tit");
    const $titleLink = $titleCell.find("a.ub-word").first();

    // 제목: 댓글 수 span 제거 후 텍스트
    const $titleClone = $titleLink.clone();
    $titleClone.find("em, span, b").remove();
    const title = $titleClone.text().trim() || $titleCell.text().trim();

    // 댓글 수: span.reply_num [N] 형태
    const commentCountText = $titleCell
      .find(".reply_num, .icon_comment, em.icon_comment")
      .text()
      .replace(/[\[\]]/g, "")
      .trim();
    const commentCount = parseInt(commentCountText, 10) || 0;

    // 작성자: data-nick 속성 또는 .nickname em
    const $writerCell = $tr.find(".gall_writer");
    const authorName =
      $writerCell.attr("data-nick") ||
      $writerCell.find(".nickname em").first().text().trim() ||
      $writerCell.find(".nickname").first().text().trim() ||
      $writerCell.text().trim();

    // 날짜: title 속성 = "YYYY-MM-DD HH:MM:SS"
    const dateTitle =
      $tr.find(".gall_date").attr("title") || $tr.find(".gall_date").text().trim();

    // 조회수, 추천수
    const viewCount =
      parseInt($tr.find(".gall_count").text().trim().replace(/,/g, ""), 10) || 0;
    const recommendCount =
      parseInt($tr.find(".gall_recommend").text().trim().replace(/,/g, ""), 10) || 0;

    posts.push({
      postNo,
      title,
      authorName,
      dateStr: dateTitle,
      viewCount,
      recommendCount,
      commentCount,
      galleryId,
      galleryType,
    });
  });

  return posts;
}

// ── 게시글 상세 수집 ─────────────────────────────────────────────

async function fetchPostDetail({ session, galleryId, galleryType, postNo }) {
  const base = galleryBasePath(galleryType);
  const url = `https://gall.dcinside.com/${base}/view/`;
  const referer = `https://gall.dcinside.com/${base}/lists/?id=${galleryId}`;

  const response = await axios.get(url, {
    params: { id: galleryId, no: postNo },
    headers: buildDcHeaders(session, referer),
    responseType: "text",
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`[dcinsideCollector] 게시글 상세 요청 실패 (${response.status}, no=${postNo})`);
  }

  const $ = cheerio.load(response.data);
  const $content = $(".write_div").first();
  $content.find("img, video, script, style, .og-div, .imgwrap").remove();
  const text = $content
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  // 댓글 API 보안 토큰 추출
  const esno =
    $("input#e_s_n_o").val() ||
    $("input[name='e_s_n_o']").val() ||
    (String(response.data).match(/['"]e_s_n_o['"]\s*[=:]\s*['"]([a-zA-Z0-9]+)['"]/) || [])[1] ||
    "";

  return { text, esno };
}

// ── 댓글 수집 ────────────────────────────────────────────────────

async function fetchPostComments({ session, galleryId, galleryType, postNo, postUrl = "", esno = "" }) {
  const base = galleryBasePath(galleryType);
  const referer =
    postUrl || `https://gall.dcinside.com/${base}/view/?id=${galleryId}&no=${postNo}`;
  const comments = [];

  for (let page = 1; page <= 5; page++) {
    try {
      const params = new URLSearchParams({
        id: galleryId,
        no: postNo,
        cmt_id: galleryId,
        cmt_no: postNo,
        e_s_n_o: esno,
        comment_page: String(page),
        sort: "D",
        _GALLTYPE_: galleryType === "minor" ? "M" : "G",
        focus_cno: "",
        focus_pno: "",
        prevCnt: "0",
        board_type: "",
        secret_article_key: "",
      });

      const commentUrl = "https://gall.dcinside.com/board/comment/";

      const response = await axios.post(
        commentUrl,
        params.toString(),
        {
          headers: buildDcAjaxHeaders(session, referer),
          timeout: 15000,
          validateStatus: () => true,
        }
      );

      if (response.status >= 400) break;

      const data = response.data;

      if (!data || typeof data !== "object") break;

      const clist = Array.isArray(data.comments) ? data.comments
        : Array.isArray(data.comment_list) ? data.comment_list : [];
      if (clist.length === 0) break;

      for (const c of clist) {
        // 삭제된 댓글, 보이스 댓글 제외
        if (c.del_yn === "Y" || c.voice_content) continue;
        const rawText = String(c.memo || "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!rawText) continue;
        comments.push({
          author: String(c.name || "").trim(),
          text: rawText,
        });
        if (comments.length >= COMMENT_MAX_PER_POST) break;
      }

      if (comments.length >= COMMENT_MAX_PER_POST) break;

      // 더 가져올 댓글이 없으면 중단
      const totalCnt = Number(data.total_cnt || data.total_comment_cnt || 0);
      if (!totalCnt || page * 100 >= totalCnt) break;
    } catch (e) {
      console.warn(
        `[dcinsideCollector] 댓글 수집 실패 (no=${postNo}, page=${page}): ${e.message}`
      );
      break;
    }

    await sleep(PAGE_REQUEST_DELAY_MS);
  }

  return comments;
}

// ── 메인 수집 함수 ───────────────────────────────────────────────

/**
 * 특정 갤러리의 targetDate 날짜 게시글(+ 댓글)을 수집
 * @param {{ session, galleryId, galleryType, targetDate }} opts
 * @returns {{ posts: Array, skipped: boolean }}
 */
async function collectGalleryPosts({ session, galleryId, galleryType, targetDate }) {
  console.log(
    `[dcinsideCollector] 수집 시작: id=${galleryId}, type=${galleryType}, date=${targetDate}`
  );

  const seenNos = new Set();
  const rawList = [];

  for (let page = 1; page <= 20; page++) {
    let html;
    try {
      html = await fetchGalleryListPage({ session, galleryId, galleryType, page });
    } catch (err) {
      if (err.code === "DC_AUTH") throw err;
      console.warn(`[dcinsideCollector] 목록 p${page} 실패: ${err.message}`);
      break;
    }

    const pageRows = parseGalleryListHTML(html, galleryId, galleryType);
    if (pageRows.length === 0) {
      break;
    }

    let sawOlder = false;
    for (const raw of pageRows) {
      const dateKey = parseDateKey(raw.dateStr);
      if (dateKey && dateKey < targetDate) {
        sawOlder = true;
        continue;
      }
      if (dateKey && dateKey > targetDate) continue;
      if (!dateKey) continue;
      if (seenNos.has(raw.postNo)) continue;

      seenNos.add(raw.postNo);
      rawList.push(raw);
      if (rawList.length >= POST_MAX) break;
    }

    if (rawList.length >= POST_MAX || sawOlder) break;
    await sleep(PAGE_REQUEST_DELAY_MS);
  }

  if (rawList.length === 0) {
    console.log(`[dcinsideCollector] ${targetDate} 게시글 없음 — skip`);
    return { posts: [], skipped: true };
  }

  // 게시글 상세 + 댓글 보강
  const base = galleryBasePath(galleryType);
  const posts = [];

  for (const raw of rawList) {
    const postUrl = `https://gall.dcinside.com/${base}/view/?id=${galleryId}&no=${raw.postNo}`;

    let text = raw.title;
    let esno = "";
    try {
      const detail = await fetchPostDetail({
        session, galleryId, galleryType, postNo: raw.postNo,
      });
      if (detail.text) text = detail.text;
      esno = detail.esno || "";
    } catch (e) {
      console.warn(`[dcinsideCollector] 상세 실패 (no=${raw.postNo}): ${e.message}`);
    }

    let comments = [];
    if (raw.commentCount > 0) {
      try {
        comments = await fetchPostComments({
          session, galleryId, galleryType, postNo: raw.postNo, postUrl, esno,
        });
      } catch (e) {
        console.warn(`[dcinsideCollector] 댓글 실패 (no=${raw.postNo}): ${e.message}`);
      }
    }

    posts.push({
      postNo: raw.postNo,
      postUrl,
      title: raw.title,
      authorName: raw.authorName,
      text,
      viewCount: raw.viewCount,
      recommendCount: raw.recommendCount,
      commentCount: raw.commentCount,
      publishedAt: targetDate,
      comments,
    });

    await sleep(POST_REQUEST_DELAY_MS);
  }

  console.log(`[dcinsideCollector] 수집 완료: ${posts.length}개 게시글`);
  return { posts, skipped: false };
}

module.exports = {
  loadDcSession,
  saveDcSession,
  markDcSessionInvalid,
  parseGalleryUrl,
  collectGalleryPosts,
};
