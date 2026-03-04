"use strict";

const nodemailer = require("nodemailer");
const { google } = require("googleapis");

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
async function sendEmailReport({ recipients, guildName, guildId = "", date, report }) {
  const html = buildEmailHTML({ guildName, guildId, date, report });

  await getTransporter().sendMail({
    from:    `Social Listener <${process.env.GMAIL_USER}>`,
    to:      recipients.join(", "),
    subject: `[Social Listener] ${guildName} - Discord 일일 리포트 (${date})`,
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
        report.summary        || "",
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
  const d = new Date(dateStr + "T00:00:00+09:00");
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

/* ════════════════════════════════════════════
   HTML 이메일 빌더 (길드 단위)
════════════════════════════════════════════ */
function buildEmailHTML({ guildName, guildId = "", date, report }) {
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
    <div style="display:flex;justify-content:space-between;font-size:13px">
      <span style="color:#059669;font-weight:500">긍정 ${pos}%</span>
      <span style="color:#94a3b8;font-weight:500">중립 ${neu}%</span>
      <span style="color:#dc2626;font-weight:500">부정 ${neg}%</span>
    </div>`;

  const keywords = (report.keywords || [])
    .map(k => `<span style="display:inline-block;background:#ede9fe;color:#6366f1;border-radius:4px;padding:2px 8px;margin:2px 3px;font-size:13px">${k}</span>`)
    .join("");

  const issues = (report.issues || [])
    .map(i => {
      if (typeof i === "object" && i !== null) {
        const channel  = i.channel ? `<span style="color:#6366f1;font-size:12px;margin-left:6px">#${i.channel}</span>` : "";
        const metaParts = [];
        if (i.count) metaParts.push(`<span style="color:#94a3b8;font-size:12px">${i.count}회 언급</span>`);
        const msgUrl = (guildId && i.channelId && i.messageId)
          ? `https://discord.com/channels/${guildId}/${i.channelId}/${i.messageId}`
          : null;
        if (msgUrl) metaParts.push(`<a href="${msgUrl}" style="display:inline-block;font-size:11px;color:#6366f1;text-decoration:none;border:1px solid #c7d2fe;border-radius:4px;padding:1px 6px">메시지 보기 ↗</a>`);
        const metaRow = metaParts.length ? `<div style="margin-top:3px">${metaParts.join("&nbsp;&nbsp;")}</div>` : "";
        const desc    = i.description ? `<div style="color:#64748b;font-size:13px;margin-top:4px">${i.description}</div>` : "";
        return `<li style="margin-bottom:12px;color:#374151;font-size:14px;line-height:1.6">
          <div><strong>${i.title || ""}</strong>${channel}</div>
          ${metaRow}${desc}
        </li>`;
      }
      return `<li style="margin-bottom:6px;color:#374151;font-size:14px;line-height:1.6">${i}</li>`;
    })
    .join("");

  const alertBadge = report.isAlertTriggered
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#dc2626;font-weight:600;font-size:14px">
         ⚠️ 위기 감지 — 트리거 키워드 감지
       </div>`
    : "";

  const keywordsSection = keywords
    ? `<div style="margin-bottom:20px">
         <div style="${HEADING};margin-bottom:8px">주요 키워드</div>
         <div>${keywords}</div>
       </div>`
    : "";

  const issuesSection = issues
    ? `<div style="margin-bottom:20px">
         <div style="${HEADING};margin-bottom:8px">주요 이슈</div>
         <ul style="margin:0;padding-left:20px">${issues}</ul>
       </div>`
    : "";

  // 채널별 요약 섹션
  const importanceLabelMap = { high: "높음", normal: "보통", low: "낮음" };
  const importanceColorMap = { high: "#d97706", normal: "#6366f1", low: "#94a3b8" };

  const channelRows = (report.channels || []).map(ch => {
    const imp      = ch.importance || "normal";
    const impLabel = importanceLabelMap[imp] || "보통";
    const impColor = importanceColorMap[imp] || "#6366f1";
    const chPos    = ch.sentiment?.positive || 0;
    const chNeg    = ch.sentiment?.negative || 0;
    const chNeu    = ch.sentiment?.neutral  || 0;
    return `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;font-weight:700;color:${impColor};background:${hexToRgba(impColor, 0.1)};border:1px solid ${impColor}40;border-radius:100px;padding:2px 8px">${impLabel}</span>
          <span style="font-size:14px;font-weight:600;color:#1e293b">#${ch.channelName}</span>
          <span style="font-size:12px;color:#94a3b8;margin-left:auto">${ch.messageCount || 0}건</span>
          <span style="font-size:12px;color:#059669">긍정 ${chPos}%</span>
        </div>
        <div style="font-size:13px;color:#374151;line-height:1.6;margin-bottom:8px">${ch.summary || "—"}</div>
        <div style="display:flex;height:6px;border-radius:3px;overflow:hidden">
          <div style="width:${chPos}%;background:#059669"></div>
          <div style="width:${chNeu}%;background:#94a3b8"></div>
          <div style="width:${chNeg}%;background:#dc2626"></div>
        </div>
      </div>`;
  }).join("");

  const channelsSection = channelRows
    ? `<div style="margin-bottom:20px">
         <div style="${HEADING};margin-bottom:10px">채널별 요약</div>
         ${channelRows}
       </div>`
    : "";

  const displayDate = formatKSTDate(date);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Daily Report - ${guildName} (${date})</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,'Malgun Gothic','맑은 고딕',sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${guildName} Discord 서버의 ${displayDate} 일일 리포트입니다.</div>
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- 헤더 -->
    <div style="background:linear-gradient(135deg,#6366f1 0%,#818cf8 100%);padding:28px 32px">
      <div style="color:#c7d2fe;font-size:11px;letter-spacing:.08em;margin-bottom:6px">SOCIAL LISTENER · DAILY REPORT</div>
      <div style="color:#fff;font-size:22px;font-weight:700">${guildName} - Discord</div>
      <div style="color:#c7d2fe;font-size:14px;margin-top:6px">${displayDate}</div>
    </div>

    <!-- 본문 -->
    <div style="padding:28px 32px">
      ${alertBadge}

      <!-- 감성 분석 -->
      <div style="margin-bottom:24px">
        <div style="${HEADING};margin-bottom:6px">감성 분석</div>
        ${sentimentBar}
        <div style="font-size:13px;color:#64748b;margin-top:8px">총 메시지 ${report.messageCount || 0}건 분석</div>
      </div>

      <!-- 서버 동향 요약 -->
      <div style="margin-bottom:20px">
        <div style="${HEADING};margin-bottom:8px">서버 동향 요약</div>
        <div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;padding:14px 16px">${report.summary || "—"}</div>
      </div>

      ${keywordsSection}
      ${issuesSection}
      ${channelsSection}
    </div>

    <!-- 푸터 -->
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
      Social Listener by 사업전략팀 &nbsp;·&nbsp; 이 메일은 자동 발송됩니다
    </div>
  </div>
</body>
</html>`;
}

module.exports = { sendEmailReport, appendToGoogleSheet };
