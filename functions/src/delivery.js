"use strict";

const nodemailer = require("nodemailer");
const { google } = require("googleapis");

/** 일반 텍스트 필드의 HTML 특수문자 이스케이핑 */
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeCaptionText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFFFD+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** AI 생성 HTML: <br>, <strong> 태그만 허용, 나머지 모두 제거 */
function sanitizeReportHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html.replace(/<(?!\/?(?:br|strong)\b)[^>]*>/gi, "");
}

function formatReviewText(text) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return sanitizeReportHtml(withBold);
}

function formatReviewLine(line) {
  const trimmed = String(line || "").trim();
  const labelSpecs = [
    { prefix: "✅ 잘된 점", text: "잘된 점", badgeBg: "#dcfce7", badgeColor: "#166534", bodyColor: "#166534" },
    { prefix: "⚠️ 아쉬운 점", text: "아쉬운 점", badgeBg: "#fef3c7", badgeColor: "#92400e", bodyColor: "#7c2d12" },
    { prefix: "💡 개선 제안", text: "개선 제안", badgeBg: "#dbeafe", badgeColor: "#1d4ed8", bodyColor: "#1e3a8a" },
  ];

  const matched = labelSpecs.find((spec) => trimmed.startsWith(spec.prefix));
  if (!matched) {
    return `<div style="margin-bottom:10px;font-size:13px;color:#374151;line-height:1.7">${formatReviewText(trimmed)}</div>`;
  }

  const content = trimmed.slice(matched.prefix.length).trim().replace(/^[:：-]\s*/, "");
  return `
    <div style="margin-bottom:12px;padding:12px 13px;border:1px solid #e2e8f0;border-radius:10px;background:#ffffff">
      <span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${matched.badgeBg};color:${matched.badgeColor};font-size:11px;font-weight:700;margin-bottom:7px">${matched.text}</span>
      <div style="font-size:13px;color:${matched.bodyColor};line-height:1.7">${formatReviewText(content)}</div>
    </div>`;
}

/* ── HTML → 플레인 텍스트 변환 (구글 시트용) ── */
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/* ── 구버전 [섹션명] 텍스트 → HTML 변환 ── */
function formatSummaryHtml(text) {
  if (!text) return "—";
  if (text.includes("<br>") || text.includes("<strong>")) return text;
  return text
    .replace(/\[([^\]]+)\]/g, (_, label) => `<br><br><strong>[${label}]</strong>`)
    .replace(/^<br><br>/, "");
}

/* ════════════════════════════════════════════
   이메일 발송 (Gmail SMTP + 앱 비밀번호)
════════════════════════════════════════════ */

let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return _transporter;
}

/**
 * 길드(서버) 단위 일일 리포트 이메일 발송.
 * @param {object} opts
 * @param {string[]} opts.recipients  수신자 이메일 목록
 * @param {string}   opts.guildName   Discord 서버명
 * @param {string}   opts.guildId     Discord 서버 ID (이슈 메시지 링크 생성용)
 * @param {string}   opts.date        YYYY-MM-DD
 * @param {object}   opts.report      길드 리포트 객체
 */
async function sendEmailReport({ recipients, guildName, guildId = "", date, report, lang = "ko" }) {
  let html, subject;

  if (lang === "en") {
    // EN 섹션 생성 후, KO 섹션을 추가하여 영+한 합본 이메일 작성
    const enHtml = buildEmailHTML({ guildName, guildId, date, report, lang: "en" });
    const koHtml = buildEmailHTML({ guildName, guildId, date, report, lang: "ko" });
    const koBodyMatch = koHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const koBodyContent = koBodyMatch ? koBodyMatch[1] : "";
    const divider = `
      <div style="margin:48px 24px 0;padding-top:36px;border-top:3px solid #e2e8f0;text-align:center">
        <span style="display:inline-block;padding:6px 20px;background:#f1f5f9;border-radius:20px;font-size:12px;font-weight:700;color:#64748b;letter-spacing:.08em;">── 한국어 리포트 ──</span>
      </div>
      ${koBodyContent}`;
    html = enHtml.replace(/<\/body>/i, divider + "\n</body>");
    subject = `[AI Social Listening] ${guildName} - Discord Daily Report / 일일 리포트 (${date})`;
  } else {
    html    = buildEmailHTML({ guildName, guildId, date, report, lang: "ko" });
    subject = `[AI Social Listening] ${guildName} - Discord 일일 리포트 (${date})`;
  }

  await getTransporter().sendMail({
    from: `AI Social Listening <${process.env.GMAIL_USER}>`,
    to:   recipients.join(", "),
    subject,
    html,
  });
}

/* ════════════════════════════════════════════
   구글 시트 기록 (Sheets API, ADC)
════════════════════════════════════════════ */

/**
 * 길드 단위 구글 시트 기록.
 * @param {object} opts
 * @param {string} opts.spreadsheetUrl
 * @param {string} opts.guildName
 * @param {string} opts.date
 * @param {object} opts.report
 */
async function appendToGoogleSheet({ spreadsheetUrl, guildName, date, report }) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const match = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error("유효하지 않은 스프레드시트 URL");
  const spreadsheetId = match[1];

  const tabName = `동향 리포트_discord(${guildName})`.substring(0, 100);

  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = data.sheets?.some(s => s.properties?.title === tabName);

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:            `'${tabName}'!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          "날짜", "총메시지수",
          "긍정%", "중립%", "부정%",
          "키워드", "주요이슈",
          "서버동향요약", "위기알림",
        ]],
      },
    });
  }

  const s = report.sentiment || {};
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:            `'${tabName}'!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        date,
        report.messageCount || 0,
        s.positive          || 0,
        s.neutral           || 0,
        s.negative          || 0,
        (report.keywords || []).join(", "),
        formatIssueCell(report.issues || []),
        stripHtml(report.summary || ""),
        report.isAlertTriggered ? "⚠️ 위기 감지" : "",
      ]],
    },
  });
}

/* ════════════════════════════════════════════
   이슈 포맷 헬퍼
════════════════════════════════════════════ */

/** 시트 단일 셀 — 이슈 목록을 번호 + 줄바꿈 형식으로 포맷 */
function formatIssueCell(issues) {
  if (!issues || issues.length === 0) return "";
  const NUM = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
  return issues.map((i, idx) => {
    if (typeof i !== "object" || i === null) return String(i);
    const num     = NUM[idx] || `(${idx + 1})`;
    const count   = i.count   ? ` (${i.count}회)` : "";
    const channel = i.channel ? ` · #${i.channel}` : "";
    const title   = `${num} ${i.title || ""}${count}${channel}`;
    const desc    = i.description ? `   ${i.description}` : "";
    return desc ? `${title}\n${desc}` : title;
  }).join("\n\n");
}

/* ════════════════════════════════════════════
   HTML 이메일 빌더 헬퍼
════════════════════════════════════════════ */

/** #rrggbb hex 컬러 → rgba(r,g,b,alpha) 문자열 (Gmail은 8자리 hex 미지원) */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** YYYY-MM-DD → 한국어 날짜 (예: 2026년 3월 3일 (월)) */
function formatKSTDate(dateStr) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const [year, month, day] = dateStr.split("-").map(Number);
  // 03:00 UTC = 12:00 KST → UTC 기준으로도 동일 날짜가 보장됨 (Cloud Run은 UTC 런타임)
  const d = new Date(Date.UTC(year, month - 1, day, 3, 0, 0));
  return `${year}년 ${month}월 ${day}일 (${days[d.getUTCDay()]})`;
}

/** YYYY-MM-DD → English date (e.g., Monday, March 9, 2026) */
function formatENDate(dateStr) {
  const days   = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 3, 0, 0));
  return `${days[d.getUTCDay()]}, ${months[month - 1]} ${day}, ${year}`;
}

/* ════════════════════════════════════════════
   HTML 이메일 빌더 (길드 단위)
════════════════════════════════════════════ */
function buildEmailHTML({ guildName, guildId = "", date, report, lang = "ko" }) {
  const isEN = lang === "en";
  const L = isEN ? {
    alertBadge:    "Crisis Alert — Trigger keyword detected",
    sentimentLabel:"Sentiment Analysis",
    posLabel:      "Positive", neuLabel: "Neutral", negLabel: "Negative",
    msgCountLabel: "messages analyzed",
    summaryLabel:  "Server Trend Summary",
    keywordsLabel: "Key Keywords",
    issuesLabel:   "Key Issues",
    issueCountUnit:"mentions",
    msgViewLink:   "View Message ↗",
    channelsLabel: "Channel Summaries",
    impHigh: "High", impNormal: "Normal", impLow: "Low",
    msgUnit: "msgs",
    footer:  "AI Social Listening by Strategy Team · This email is automatically sent",
  } : {
    alertBadge:    "위기 감지 — 트리거 키워드 감지",
    sentimentLabel:"감성 분석",
    posLabel:      "긍정", neuLabel: "중립", negLabel: "부정",
    msgCountLabel: "건 분석",
    summaryLabel:  "서버 동향 요약",
    keywordsLabel: "주요 키워드",
    issuesLabel:   "주요 이슈",
    issueCountUnit:"회 언급",
    msgViewLink:   "메시지 보기 ↗",
    channelsLabel: "채널별 요약",
    impHigh: "높음", impNormal: "보통", impLow: "낮음",
    msgUnit: "건",
    footer:  "AI Social Listening by 사업전략팀 · 이 메일은 자동 발송됩니다",
  };

  const s   = report.sentiment || {};
  const pos = s.positive || 0;
  const neu = s.neutral  || 0;
  const neg = s.negative || 0;

  // 섹션 헤딩 공통 스타일 (헤더 라벨과 동일한 uppercase + letter-spacing)
  const HEADING = "font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1";

  const sentimentBar = `
    <div style="display:flex;height:10px;border-radius:4px;overflow:hidden;margin:10px 0 6px">
      <div style="width:${pos}%;background:#059669"></div>
      <div style="width:${neu}%;background:#94a3b8"></div>
      <div style="width:${neg}%;background:#dc2626"></div>
    </div>
    <div style="display:flex;gap:16px;font-size:13px">
      <span style="color:#059669;font-weight:500">${L.posLabel} ${pos}%</span>
      <span style="color:#94a3b8;font-weight:500">${L.neuLabel} ${neu}%</span>
      <span style="color:#dc2626;font-weight:500">${L.negLabel} ${neg}%</span>
    </div>`;

  const rawKeywords = isEN ? (report.keywords_en || report.keywords) : report.keywords;
  const keywords = (rawKeywords || [])
    .map(k => `<span style="display:inline-block;background:#ede9fe;color:#6366f1;border-radius:4px;padding:2px 8px;margin:2px 3px;font-size:13px">${escapeHtml(k)}</span>`)
    .join("");

  const issues = (report.issues || [])
    .map(i => {
      if (typeof i === "object" && i !== null) {
        const title       = escapeHtml(isEN ? (i.title_en       || i.title       || "") : (i.title       || ""));
        const description = escapeHtml(isEN ? (i.description_en || i.description || "") : (i.description || ""));
        const channel  = i.channel ? `<span style="color:#6366f1;font-size:12px;margin-left:6px">#${escapeHtml(i.channel)}</span>` : "";
        const metaParts = [];
        if (i.count) metaParts.push(`<span style="color:#94a3b8;font-size:12px">${i.count} ${L.issueCountUnit}</span>`);
        const msgUrl = (guildId && i.channelId && i.messageId)
          ? `https://discord.com/channels/${guildId}/${i.channelId}/${i.messageId}`
          : null;
        if (msgUrl) metaParts.push(`<a href="${msgUrl}" style="display:inline-block;font-size:11px;color:#6366f1;text-decoration:none;border:1px solid #c7d2fe;border-radius:4px;padding:1px 6px">${L.msgViewLink}</a>`);
        const metaRow = metaParts.length ? `<div style="margin-top:3px">${metaParts.join("&nbsp;&nbsp;")}</div>` : "";
        const desc    = description ? `<div style="color:#64748b;font-size:13px;margin-top:4px">${description}</div>` : "";
        return `<li style="margin-bottom:12px;color:#374151;font-size:14px;line-height:1.6">
          <div><strong>${title}</strong>${channel}</div>
          ${metaRow}${desc}
        </li>`;
      }
      return `<li style="margin-bottom:6px;color:#374151;font-size:14px;line-height:1.6">${i}</li>`;
    })
    .join("");

  const alertBadge = report.isAlertTriggered
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#dc2626;font-weight:600;font-size:14px">
         ⚠️ ${L.alertBadge}
       </div>`
    : "";

  const keywordsSection = keywords
    ? `<div style="margin-bottom:20px">
         <div style="${HEADING};margin-bottom:8px">${L.keywordsLabel}</div>
         <div>${keywords}</div>
       </div>`
    : "";

  const issuesSection = issues
    ? `<div style="margin-bottom:20px">
         <div style="${HEADING};margin-bottom:8px">${L.issuesLabel}</div>
         <ul style="margin:0;padding-left:20px">${issues}</ul>
       </div>`
    : "";

  // 채널별 요약 섹션
  const importanceLabelMap = { high: L.impHigh, normal: L.impNormal, low: L.impLow };
  const importanceColorMap = { high: "#d97706", normal: "#6366f1", low: "#94a3b8" };

  const channelRows = (report.channels || []).map(ch => {
    const imp       = ch.importance || "normal";
    const impLabel  = importanceLabelMap[imp] || L.impNormal;
    const impColor  = importanceColorMap[imp] || "#6366f1";
    const chPos     = ch.sentiment?.positive || 0;
    const chNeg     = ch.sentiment?.negative || 0;
    const chNeu     = ch.sentiment?.neutral  || 0;
    const chSummary = isEN ? (ch.summary_en || ch.summary) : ch.summary;
    return `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;font-weight:700;color:${impColor};background:${hexToRgba(impColor, 0.1)};border:1px solid ${impColor}40;border-radius:100px;padding:2px 8px">${impLabel}</span>
          <span style="font-size:14px;font-weight:600;color:#1e293b">#${escapeHtml(ch.channelName)}</span>
          <span style="font-size:12px;color:#94a3b8;margin-left:auto">${ch.messageCount || 0}${L.msgUnit}</span>
          <span style="font-size:12px;color:#059669">${L.posLabel} ${chPos}%</span>
        </div>
        <div style="font-size:13px;color:#374151;line-height:1.6;margin-bottom:8px">${sanitizeReportHtml(chSummary) || "—"}</div>
        <div style="display:flex;height:6px;border-radius:3px;overflow:hidden">
          <div style="width:${chPos}%;background:#059669"></div>
          <div style="width:${chNeu}%;background:#94a3b8"></div>
          <div style="width:${chNeg}%;background:#dc2626"></div>
        </div>
      </div>`;
  }).join("");

  const channelsSection = channelRows
    ? `<div style="margin-bottom:20px">
         <div style="${HEADING};margin-bottom:10px">${L.channelsLabel}</div>
         ${channelRows}
       </div>`
    : "";

  const displayDate  = isEN ? formatENDate(date) : formatKSTDate(date);
  const summaryText  = isEN ? (report.summary_en || report.summary) : report.summary;
  const msgCountText = isEN
    ? `${report.messageCount || 0} ${L.msgCountLabel}`
    : `총 메시지 ${report.messageCount || 0}${L.msgCountLabel}`;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Daily Report - ${guildName} (${date})</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,'Malgun Gothic','맑은 고딕',sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${guildName} Discord ${displayDate}</div>
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- 헤더 -->
    <div style="background:linear-gradient(135deg,#6366f1 0%,#818cf8 100%);padding:28px 32px">
      <div style="color:#c7d2fe;font-size:11px;letter-spacing:.08em;margin-bottom:6px">AI SOCIAL LISTENING · DAILY REPORT</div>
      <div style="color:#fff;font-size:22px;font-weight:700">${guildName} - Discord</div>
      <div style="color:#c7d2fe;font-size:14px;margin-top:6px">${displayDate}</div>
    </div>

    <!-- 주의사항 -->
    <div style="background:#fffbeb;border-bottom:1px solid #fde68a;padding:10px 32px;font-size:12px;color:#92400e">
      ⚠️ ${isEN ? "Due to the nature of AI, analysis may contain errors such as misinterpreting spoken text or misidentifying references to other games." : "AI 특성 상 발화 텍스트를 잘못 이해하거나, 타 게임 언급을 이해하지 못하는 등 오류가 있을 수 있습니다."}
    </div>

    <!-- 본문 -->
    <div style="padding:28px 32px">
      ${alertBadge}

      <!-- 감성 분석 -->
      <div style="margin-bottom:24px">
        <div style="${HEADING};margin-bottom:6px">${L.sentimentLabel}</div>
        ${sentimentBar}
        <div style="font-size:13px;color:#64748b;margin-top:8px">${msgCountText}</div>
      </div>

      <!-- 서버 동향 요약 -->
      <div style="margin-bottom:20px">
        <div style="${HEADING};margin-bottom:8px">${L.summaryLabel}</div>
        <div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;padding:14px 16px">${sanitizeReportHtml(formatSummaryHtml(summaryText))}</div>
      </div>

      ${keywordsSection}
      ${issuesSection}
      ${channelsSection}
    </div>

    <!-- 푸터 -->
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
      ${L.footer}
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:11px;color:#b0b8c8;line-height:1.6">
        ${isEN ? "To manage your report subscription, visit the link below." : "리포트 신청 및 수신인 설정은 아래 링크에서 진행해주세요."}<br>
        <a href="https://docs.google.com/spreadsheets/d/1YmJrxHiUKbaFy3xLJTT_-k7-x1DLhsT6Ugo3N-kAYA8/edit?usp=sharing" style="color:#6366f1;text-decoration:none;font-weight:500">📋 ${isEN ? "Report Subscription Google Sheets ↗" : "리포트 신청 Google Sheets ↗"}</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 주간 리포트 이메일 발송
 * @param {Object} params
 * @param {string[]} params.recipients
 * @param {string}   params.guildName
 * @param {string}   params.weekStart  YYYY-MM-DD
 * @param {string}   params.weekEnd    YYYY-MM-DD
 * @param {Object}   params.report     { aiSummary, insightsChart, sentimentChart, weeklyIssues }
 */
function buildWeeklyEmailHTML({ guildName, weekStart, weekEnd, report, lang }) {
  const displayRange = `${weekStart} ~ ${weekEnd}`;
  const isEN = lang === "en";
  const L = isEN ? {
    serverInsights: "Server Insights",
    colDate: "Date", colMembers: "Members", colComm: "Comm.", colActive: "Active", colMsgs: "Messages",
    sentimentTrend: "Sentiment Trend",
    posShort: "P", neuShort: "N", negShort: "Ng",
    weeklySummary:  "Weekly Trend Summary",
    weeklyIssues:   "Key Issues",
    countUnit:      "times",
    footer: "AI Social Listening by Strategy Team · This email is automatically sent",
  } : {
    serverInsights: "서버 인사이트",
    colDate: "날짜", colMembers: "총 멤버", colComm: "소통", colActive: "활성", colMsgs: "메시지",
    sentimentTrend: "감정 분석 추이",
    posShort: "긍", neuShort: "중", negShort: "부",
    weeklySummary:  "주간 동향 요약",
    weeklyIssues:   "주요 이슈",
    countUnit:      "회",
    footer: "AI Social Listening by 사업전략팀 · 이 메일은 자동 발송됩니다",
  };

  // 인사이트 테이블
  const insightRows = (report.insightsChart || []).map((d, i, arr) => {
    const prev = arr[i - 1];
    let deltaHtml = "";
    if (i > 0 && d.totalMembers != null && prev?.totalMembers != null) {
      const delta = d.totalMembers - prev.totalMembers;
      const sign  = delta >= 0 ? "+" : "";
      const color = delta > 0 ? "#dc2626" : delta < 0 ? "#2563eb" : "#94a3b8";
      deltaHtml = ` <span style="color:${color};font-size:11px">(∆ ${sign}${delta})</span>`;
    }
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;color:#64748b">${d.date}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${d.totalMembers ?? "—"}${deltaHtml}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${d.communicatingMembers ?? "—"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${d.activeMembers ?? "—"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${d.messageCount ?? "—"}</td>
    </tr>`;
  }).join("");

  const insightTable = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:8px 10px;text-align:left;color:#475569">${L.colDate}</th>
          <th style="padding:8px 10px;text-align:right;color:#475569">${L.colMembers}</th>
          <th style="padding:8px 10px;text-align:right;color:#475569">${L.colComm}</th>
          <th style="padding:8px 10px;text-align:right;color:#475569">${L.colActive}</th>
          <th style="padding:8px 10px;text-align:right;color:#475569">${L.colMsgs}</th>
        </tr>
      </thead>
      <tbody>${insightRows}</tbody>
    </table>`;

  // 감정 추이 바 (7일)
  const sentimentRows = (report.sentimentChart || []).map(d => {
    const pos = d.positive || 0, neu = d.neutral || 0, neg = d.negative || 0;
    return `<tr>
      <td style="padding:4px 10px;font-size:12px;color:#64748b;white-space:nowrap">${d.date}</td>
      <td style="padding:4px 10px;width:100%">
        <div style="display:flex;height:14px;border-radius:4px;overflow:hidden">
          <div style="width:${pos}%;background:#22c55e"></div>
          <div style="width:${neu}%;background:#94a3b8"></div>
          <div style="width:${neg}%;background:#ef4444"></div>
        </div>
      </td>
      <td style="padding:4px 10px;font-size:11px;color:#64748b;white-space:nowrap">${L.posShort}${pos}% ${L.neuShort}${neu}% ${L.negShort}${neg}%</td>
    </tr>`;
  }).join("");

  const sentimentTable = `<table style="width:100%;border-collapse:collapse">${sentimentRows}</table>`;

  // 주요 이슈
  const issuesSection = (report.weeklyIssues || []).length === 0 ? "" : `
    <div style="margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:8px">${L.weeklyIssues}</div>
      ${(report.weeklyIssues || []).map(i => {
        const title       = escapeHtml(isEN ? (i.title_en       || i.title       || "") : (i.title       || ""));
        const description = escapeHtml(isEN ? (i.description_en || i.description || "") : (i.description || ""));
        const datePart = Array.isArray(i.dates) && i.dates.length
          ? i.dates.map(d => d.slice(5)).join(" · ")
          : (i.date ? i.date.slice(5) : "");
        const countPart = i.count ? `${i.count}${L.countUnit}` : "";
        const metaParts = [datePart, countPart].filter(Boolean).join(" / ");
        return `
        <div style="padding:10px 14px;background:#fef2f2;border-left:3px solid #ef4444;border-radius:0 8px 8px 0;margin-bottom:8px">
          <div style="font-weight:600;color:#991b1b;font-size:13px">${title}${metaParts ? ` <span style="font-weight:400;color:#b91c1c;font-size:11px">(${metaParts})</span>` : ""}</div>
          <div style="color:#7f1d1d;font-size:12px;margin-top:4px">${description}</div>
        </div>`;
      }).join("")}
    </div>`;

  const aiSummaryText = isEN ? (report.aiSummary_en || report.aiSummary) : report.aiSummary;

  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px">
      <div style="color:#c7d2fe;font-size:11px;letter-spacing:.08em;margin-bottom:6px">AI SOCIAL LISTENING · WEEKLY REPORT</div>
      <div style="color:#fff;font-size:22px;font-weight:700">${guildName} - Discord</div>
      <div style="color:#c7d2fe;font-size:14px;margin-top:6px">${displayRange}</div>
    </div>
    <!-- 주의사항 -->
    <div style="background:#fffbeb;border-bottom:1px solid #fde68a;padding:10px 32px;font-size:12px;color:#92400e">
      ⚠️ ${isEN ? "Due to the nature of AI, analysis may contain errors such as misinterpreting spoken text or misidentifying references to other games." : "AI 특성 상 발화 텍스트를 잘못 이해하거나, 타 게임 언급을 이해하지 못하는 등 오류가 있을 수 있습니다."}
    </div>
    <div style="padding:28px 32px">
      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:10px">${L.serverInsights}</div>
        ${insightTable}
      </div>
      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:10px">${L.sentimentTrend}</div>
        ${sentimentTable}
      </div>
      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:8px">${L.weeklySummary}</div>
        <div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;padding:14px 16px">${sanitizeReportHtml(aiSummaryText) || "—"}</div>
      </div>
      ${issuesSection}
    </div>
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
      ${L.footer}
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:11px;color:#b0b8c8;line-height:1.6">
        ${isEN ? "To manage your report subscription, visit the link below." : "리포트 신청 및 수신인 설정은 아래 링크에서 진행해주세요."}<br>
        <a href="https://docs.google.com/spreadsheets/d/1YmJrxHiUKbaFy3xLJTT_-k7-x1DLhsT6Ugo3N-kAYA8/edit?usp=sharing" style="color:#6366f1;text-decoration:none;font-weight:500">📋 ${isEN ? "Report Subscription Google Sheets ↗" : "리포트 신청 Google Sheets ↗"}</a>
      </div>
    </div>
  </div>
</body></html>`;
}

async function sendWeeklyEmailReport({ recipients, guildName, weekStart, weekEnd, report, lang = "ko" }) {
  const transporter  = getTransporter();
  const displayRange = `${weekStart} ~ ${weekEnd}`;

  let html, subject;
  if (lang === "en") {
    // EN 섹션 + KO 섹션 합본
    const enHtml = buildWeeklyEmailHTML({ guildName, weekStart, weekEnd, report, lang: "en" });
    const koHtml = buildWeeklyEmailHTML({ guildName, weekStart, weekEnd, report, lang: "ko" });
    const koBodyMatch = koHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const koBodyContent = koBodyMatch ? koBodyMatch[1] : "";
    const divider = `
      <div style="margin:48px 24px 0;padding-top:36px;border-top:3px solid #e2e8f0;text-align:center">
        <span style="display:inline-block;padding:6px 20px;background:#f1f5f9;border-radius:20px;font-size:12px;font-weight:700;color:#64748b;letter-spacing:.08em;">── 한국어 리포트 ──</span>
      </div>
      ${koBodyContent}`;
    html = enHtml.replace(/<\/body>/i, divider + "\n</body>");
    subject = `[AI Social Listening] ${guildName} - Discord Weekly Report / 주간 리포트 (${displayRange})`;
  } else {
    html    = buildWeeklyEmailHTML({ guildName, weekStart, weekEnd, report, lang: "ko" });
    subject = `[AI Social Listening] ${guildName} - Discord 주간 리포트 (${displayRange})`;
  }

  await transporter.sendMail({
    from:    `"AI Social Listening" <${process.env.GMAIL_USER}>`,
    to:      recipients.join(", "),
    subject,
    html,
  });

  console.log(`[sendWeeklyEmailReport] 발송 완료 → ${recipients.join(", ")}`);
}

/* ════════════════════════════════════════════
   Instagram 일일 리포트 이메일 발송
════════════════════════════════════════════ */

/**
 * Instagram 계정 일일 리포트 이메일 발송
 * @param {object} opts
 * @param {string[]} opts.recipients
 * @param {string}   opts.username   Instagram @계정명
 * @param {string}   opts.date       YYYY-MM-DD
 * @param {object}   opts.report     instagramPipeline 저장 데이터
 */
async function sendInstagramEmailReport({ recipients, username, date, report }) {
  const { html, attachments } = buildInstagramEmailHTML({ username, date, report });

  const mailOptions = {
    from:    `AI Social Listening <${process.env.GMAIL_USER}>`,
    to:      recipients.join(", "),
    subject: `[AI Social Listening] @${username} - Instagram 일일 리포트 (${date})`,
    html,
  };

  if (attachments?.length) mailOptions.attachments = attachments;

  await getTransporter().sendMail(mailOptions);
}

function buildInstagramTrendChartHtml(report = {}) {
  const td = Array.isArray(report.trendData) ? report.trendData.filter((d) => d && d.date) : [];
  if (!td.length) return "";

  const chartHeight = 88;
  const formatDateLabel = (dateStr) => {
    const parts = String(dateStr || "").split("-");
    return parts.length === 3 ? `${+parts[1]}/${+parts[2]}` : escapeHtml(dateStr || "—");
  };

  const buildMiniChart = ({ title, series, tone }) => {
    const values = series.map((item) => item.value).filter((value) => value != null);
    if (!values.length) return "";

    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = Math.max(maxValue - minValue, 1);
    const baseHeight = values.length === 1 ? Math.round(chartHeight * 0.72) : 18;

    const rows = series.map((item, index) => {
      const isCurrent = index === series.length - 1;
      const valueText = item.value != null ? item.value.toLocaleString() : "—";
      const normalized = item.value == null ? 0 : ((item.value - minValue) / range);
      const barHeight = item.value == null
        ? 12
        : Math.max(baseHeight, Math.round(baseHeight + normalized * (chartHeight - baseHeight)));
      const barColor = isCurrent ? tone.barStrong : tone.bar;
      const valueColor = isCurrent ? tone.valueStrong : tone.value;
      const dateColor = isCurrent ? tone.valueStrong : "#94a3b8";
      const dateWeight = isCurrent ? "700" : "500";

      return `
        <td style="padding:0 3px;vertical-align:bottom;text-align:center">
          <div style="font-size:10px;line-height:1.2;color:${valueColor};font-weight:${isCurrent ? 800 : 700};margin-bottom:8px;user-select:text">${valueText}</div>
          <div style="height:${chartHeight}px;display:flex;align-items:flex-end;justify-content:center;background:linear-gradient(180deg,#ffffff 0%,#f8fafc 100%);border-radius:10px 10px 6px 6px;padding-bottom:0">
            <div style="width:26px;height:${barHeight}px;background:${barColor};border-radius:8px 8px 0 0;border:${isCurrent ? `1px solid ${tone.barStrongBorder}` : "none"};box-sizing:border-box"></div>
          </div>
          <div style="font-size:10px;line-height:1.2;color:${dateColor};font-weight:${dateWeight};margin-top:7px;user-select:text">${formatDateLabel(item.date)}</div>
        </td>`;
    }).join("");

    return `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${tone.heading};margin-bottom:8px">${title}</div>
        <div style="border:1px solid ${tone.border};border-radius:12px;background:${tone.panel};padding:12px 10px 10px">
          <table role="presentation" style="width:100%;border-collapse:collapse;table-layout:fixed">
            <tbody>
              <tr>${rows}</tr>
            </tbody>
          </table>
        </div>
      </div>`;
  };

  const followerChart = buildMiniChart({
    title: "팔로워 추이",
    series: td.map((item) => ({
      date: item.date,
      value: Number.isFinite(Number(item.followerCount)) ? Math.max(0, Number(item.followerCount)) : null,
    })),
    tone: {
      heading: "#4f46e5",
      panel: "#f8faff",
      border: "#c7d2fe",
      bar: "#a5b4fc",
      barStrong: "#4f46e5",
      barStrongBorder: "#3730a3",
      value: "#6366f1",
      valueStrong: "#4338ca",
    },
  });

  const viewsChart = buildMiniChart({
    title: "오가닉 조회 추이",
    series: td.map((item) => ({
      date: item.date,
      value: Number.isFinite(Number(item.dailyViews)) ? Math.max(0, Number(item.dailyViews)) : null,
    })),
    tone: {
      heading: "#047857",
      panel: "#f6fefb",
      border: "#a7f3d0",
      bar: "#6ee7b7",
      barStrong: "#059669",
      barStrongBorder: "#047857",
      value: "#059669",
      valueStrong: "#065f46",
    },
  });

  return `
    <div style="border:1px solid #e2e8f0;border-radius:14px;background:#fcfdff;padding:14px 14px 4px">
      <div style="font-size:12px;line-height:1.5;color:#64748b;margin-bottom:12px">이미지 차트 대신 메일 안에서 바로 읽고 복사할 수 있는 HTML 차트 형식으로 표시했습니다.</div>
      ${followerChart}
      ${viewsChart}
    </div>`;
}

function buildInstagramPostCommentRow(post) {
  if (!post) return "";

  if (post.aiCommentStatus === "waiting_1d") {
    return `
      <tr>
        <td colspan="12" style="padding:0 6px 12px 6px;border-bottom:1px solid #e2e8f0">
          <div style="margin:8px 0 0 28px;padding:10px 12px;border-radius:12px;background:#fff7ed;border:1px solid #fdba74">
            <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:6px">분석 대기</div>
            <div style="font-size:12px;line-height:1.65;color:#9a3412">1일 대기 중. 게시 후 하루가 지난 다음 리포트에서 댓글 반응과 성과를 함께 분석합니다.</div>
          </div>
        </td>
      </tr>`;
  }

  if (post.aiCommentStatus === "commented" && post.aiComment) {
    return `
      <tr>
        <td colspan="12" style="padding:0 6px 12px 6px;border-bottom:1px solid #e2e8f0">
          <div style="margin:8px 0 0 28px;padding:10px 12px;border-radius:12px;background:#f5f7ff;border:1px solid #c7d2fe">
            <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;margin-bottom:6px">AI 코멘트</div>
            <div style="font-size:12px;line-height:1.65;color:#334155">${escapeHtml(post.aiComment)}</div>
          </div>
        </td>
      </tr>`;
  }

  return "";
}

function buildInstagramEmailHTML({ username, date, report }) {
  const HEADING = "font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1";
  const displayDate = formatKSTDate(date);
  const chartHtml = buildInstagramTrendChartHtml(report);
  const attachments = [];

  const trendSection = chartHtml ? `
    <div style="margin-bottom:24px">
      <div style="${HEADING};margin-bottom:10px">팔로워 · 조회 트렌드 (최근 14일)</div>
      ${chartHtml}
    </div>` : "";

  // ── 포스트 테이블 ──
  const MEDIA_LABELS = { IMAGE: "사진", VIDEO: "영상", CAROUSEL_ALBUM: "슬라이드" };
  const DOW_KO = ["일","월","화","수","목","금","토"];

  const postRows = (report.posts || []).map((p) => {
    // KST 기준 날짜 + 요일
    let dateStr = "—";
    if (p.timestamp) {
      const dtKST = new Date(new Date(p.timestamp).getTime() + 9 * 60 * 60 * 1000);
      dateStr = `${dtKST.getUTCMonth()+1}/${dtKST.getUTCDate()}(${DOW_KO[dtKST.getUTCDay()]})`;
    }

    // 본문 (최대 20자 + permalink 링크)
    const rawCap = p.caption ? normalizeCaptionText(p.caption) : null;
    const capText = rawCap
      ? escapeHtml(rawCap.length > 20 ? rawCap.slice(0, 20) + "…" : rawCap)
      : "—";
    const captionCell = (p.permalink && p.permalink.startsWith("https://"))
      ? `<a href="${p.permalink}" target="_blank" rel="noopener noreferrer" style="color:#6366f1;text-decoration:none">${capText}</a>`
      : capText;

    const mediaLabel = MEDIA_LABELS[p.mediaType] || p.mediaType || "—";
    const er = p.engagementRate || 0;
    const erColor = er >= 5 ? "#059669" : er >= 2 ? "#d97706" : "#94a3b8";
    const erText  = er > 0 ? `${er.toFixed(1)}%` : "—";
    const views    = p.views            != null ? p.views.toLocaleString()            : "—";
    const likes    = p.likes            != null ? p.likes.toLocaleString()            : "—";
    const comments = p.comments         != null ? p.comments.toLocaleString()         : "—";
    const shares   = p.shares           != null ? p.shares.toLocaleString()           : "—";
    const saves    = p.saves            != null ? p.saves.toLocaleString()            : "—";
    const pv       = p.profileVisits    != null ? p.profileVisits.toLocaleString()    : "—";
    const follows  = (p.mediaType === "IMAGE" || p.mediaType === "CAROUSEL_ALBUM")
      ? (p.follows != null ? p.follows.toLocaleString() : "—")
      : "—";
    const wt       = p.reelAvgWatchTime != null ? `${(p.reelAvgWatchTime / 1000).toFixed(1)}초` : "—";
    const TD = "padding:6px 6px;border-bottom:1px solid #f1f5f9;font-size:11px";
    const baseRow = `<tr>
      <td style="${TD};color:#64748b;white-space:nowrap">${dateStr}</td>
      <td style="${TD};color:#334155;width:96px;max-width:96px;line-height:1.35;word-break:break-word">${captionCell}</td>
      <td style="${TD};color:#64748b">${mediaLabel}</td>
      <td style="${TD};text-align:right">${views}</td>
      <td style="${TD};text-align:right">${likes}</td>
      <td style="${TD};text-align:right">${comments}</td>
      <td style="${TD};text-align:right">${shares}</td>
      <td style="${TD};text-align:right">${saves}</td>
      <td style="${TD};text-align:right">${pv}</td>
      <td style="${TD};text-align:right">${follows}</td>
      <td style="${TD};text-align:right;color:#6366f1">${wt}</td>
      <td style="${TD};text-align:right;font-weight:600;color:${erColor}">${erText}</td>
    </tr>`;
    return baseRow + buildInstagramPostCommentRow(p);
  }).join("");

  const postTable = (report.posts || []).length > 0 ? `
    <div style="margin-bottom:24px">
      <div style="${HEADING};margin-bottom:10px">최근 2주 포스트</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:680px">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:6px 6px;text-align:left;color:#475569;font-weight:600">날짜</th>
              <th style="padding:6px 6px;text-align:left;color:#475569;font-weight:600;width:96px">본문</th>
              <th style="padding:6px 6px;text-align:left;color:#475569;font-weight:600">유형</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">조회</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">좋아요</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">댓글</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">공유</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">저장</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">프로필</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">팔로우</th>
              <th style="padding:6px 6px;text-align:right;color:#6366f1;font-weight:600">평균시청</th>
              <th style="padding:6px 6px;text-align:right;color:#475569;font-weight:600">참여율</th>
            </tr>
          </thead>
          <tbody>${postRows}</tbody>
        </table>
      </div>
    </div>` : "";

  // ── AI 성과 리뷰 (최근 2주 포스트 전체 분석) ──
  const perfBlock = report.aiPerformanceReview
    ? (() => {
        const lines = report.aiPerformanceReview.split("\n").filter(l => l.trim());
        const linesHtml = lines.map((line) => formatReviewLine(line)).join("");
        return `<div style="margin-bottom:24px">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
            <span style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:8px">AI 성과 리뷰 — 최근 2주 포스트 종합</span>
            <div style="font-size:13px;color:#374151;line-height:1.6">${linesHtml}</div>
          </div>
        </div>`;
      })()
    : "";

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Instagram 리포트 - @${username} (${date})</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,'Malgun Gothic','맑은 고딕',sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">@${username} Instagram ${displayDate} 일일 리포트입니다.</div>
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- 헤더 -->
    <div style="background:linear-gradient(135deg,#6366f1 0%,#818cf8 100%);padding:28px 32px">
      <div style="color:#c7d2fe;font-size:11px;letter-spacing:.08em;margin-bottom:6px">AI SOCIAL LISTENING · DAILY REPORT</div>
      <div style="color:#fff;font-size:22px;font-weight:700">@${username} - Instagram</div>
      <div style="color:#c7d2fe;font-size:14px;margin-top:6px">${displayDate}</div>
    </div>

    <!-- 본문 -->
    <div style="padding:28px 32px">

      <!-- 트렌드 차트 -->
      ${trendSection}

      ${postTable}
      ${perfBlock}

      ${(report.model || report.totalTokens) ? `
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #e2e8f0;font-size:11px;color:#94a3b8;text-align:right">
        ${report.model ? `<span style="margin-right:10px;font-weight:500">${escapeHtml(report.model)}</span>` : ""}
        ${report.totalTokens ? `<span style="margin-right:10px">입력 ${(report.promptTokens || 0).toLocaleString()} / 출력 ${(report.completionTokens || 0).toLocaleString()} / 합계 ${(report.totalTokens || 0).toLocaleString()} 토큰</span>` : ""}
        ${report.cost != null ? `<span>비용 $${Number(report.cost).toFixed(4)}</span>` : ""}
      </div>` : ""}

    </div>

    <!-- 푸터 -->
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
      AI Social Listening by 사업전략팀 &nbsp;·&nbsp; 이 메일은 자동 발송됩니다
    </div>
  </div>
</body>
</html>`;
  return { html, attachments };
}

module.exports = { sendEmailReport, appendToGoogleSheet, sendWeeklyEmailReport, sendInstagramEmailReport };
