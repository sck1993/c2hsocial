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
 * @param {object} opts
 * @param {string[]} opts.recipients   수신자 이메일 목록
 * @param {string}   opts.channelName  Discord 채널명
 * @param {string}   opts.guildName    Discord 서버명
 * @param {string}   opts.date         YYYY-MM-DD
 * @param {object}   opts.report       파이프라인 리포트 객체
 */
async function sendEmailReport({ recipients, channelName, guildName, date, report }) {
  const html = buildEmailHTML({ channelName, guildName, date, report });

  await getTransporter().sendMail({
    from:    `Social Listener <${process.env.GMAIL_USER}>`,
    to:      recipients.join(", "),
    subject: `[Social Listener] ${guildName} / #${channelName} 일일 리포트 (${date})`,
    html,
  });
}

/* ════════════════════════════════════════════
   구글 시트 기록 (Sheets API, ADC)
════════════════════════════════════════════ */

/**
 * @param {object} opts
 * @param {string} opts.spreadsheetUrl  고객이 공유한 스프레드시트 URL
 * @param {string} opts.channelName
 * @param {string} opts.guildName
 * @param {string} opts.date
 * @param {object} opts.report
 */
async function appendToGoogleSheet({ spreadsheetUrl, channelName, guildName, date, report }) {
  // 1. ADC 인증 (Cloud Functions 서비스 계정 자동 사용)
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // 2. 스프레드시트 ID 추출
  const match = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error("유효하지 않은 스프레드시트 URL");
  const spreadsheetId = match[1];

  // 3. 탭 이름 (최대 100자)
  const tabName = `동향 리포트_discord(${guildName}_${channelName})`.substring(0, 100);

  // 4. 탭 존재 여부 확인
  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = data.sheets?.some(s => s.properties?.title === tabName);

  if (!tabExists) {
    // 5a. 새 탭 생성
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });

    // 5b. 헤더 행 삽입
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:            `'${tabName}'!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          "날짜", "메시지수",
          "긍정%", "중립%", "부정%",
          "키워드", "주요이슈",
          "동향요약", "맞춤답변", "위기알림",
        ]],
      },
    });
  }

  // 6. 데이터 행 추가
  const s = report.sentiment || {};
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:            `'${tabName}'!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        date,
        report.messageCount   || 0,
        s.positive            || 0,
        s.neutral             || 0,
        s.negative            || 0,
        (report.keywords || []).join(", "),
        (report.issues   || []).map(formatIssueText).join(" | "),
        report.summary        || "",
        report.custom_answer  || "",
        report.isAlertTriggered ? "⚠️ 위기 감지" : "",
      ]],
    },
  });
}

/* ════════════════════════════════════════════
   이슈 포맷 헬퍼 (객체 or 문자열 둘 다 처리)
════════════════════════════════════════════ */
function formatIssueText(i) {
  if (typeof i === "object" && i !== null) {
    const count = i.count ? ` (${i.count}회)` : "";
    const desc  = i.description ? `: ${i.description}` : "";
    return `${i.title || ""}${count}${desc}`;
  }
  return String(i);
}

/* ════════════════════════════════════════════
   HTML 이메일 빌더
════════════════════════════════════════════ */
function buildEmailHTML({ channelName, guildName, date, report }) {
  const s   = report.sentiment || {};
  const pos = s.positive || 0;
  const neu = s.neutral  || 0;
  const neg = s.negative || 0;

  const sentimentBar = `
    <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:10px 0 6px">
      <div style="width:${pos}%;background:#059669"></div>
      <div style="width:${neu}%;background:#94a3b8"></div>
      <div style="width:${neg}%;background:#dc2626"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:13px">
      <span style="color:#059669">긍정 ${pos}%</span>
      <span style="color:#94a3b8">중립 ${neu}%</span>
      <span style="color:#dc2626">부정 ${neg}%</span>
    </div>`;

  const keywords = (report.keywords || [])
    .map(k => `<span style="display:inline-block;background:#ede9fe;color:#6366f1;border-radius:4px;padding:2px 8px;margin:2px 3px;font-size:13px">${k}</span>`)
    .join("");

  const issues = (report.issues || [])
    .map(i => {
      if (typeof i === "object" && i !== null) {
        const count = i.count ? ` <span style="color:#94a3b8;font-size:12px">(${i.count}회 언급)</span>` : "";
        const desc  = i.description ? `<div style="color:#64748b;font-size:13px;margin-top:2px">${i.description}</div>` : "";
        return `<li style="margin-bottom:10px;color:#374151;font-size:14px;line-height:1.6"><strong>${i.title || ""}</strong>${count}${desc}</li>`;
      }
      return `<li style="margin-bottom:6px;color:#374151;font-size:14px;line-height:1.6">${i}</li>`;
    })
    .join("");

  const alertBadge = report.isAlertTriggered
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#dc2626;font-weight:600;font-size:14px">
         ⚠️ 위기 감지 — 부정 감정 임계치 초과 또는 트리거 키워드 감지
       </div>`
    : "";

  const customSection = report.custom_answer
    ? `<div style="margin-bottom:20px">
         <div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">맞춤 분석</div>
         <div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-radius:8px;padding:14px 16px">${report.custom_answer}</div>
       </div>`
    : "";

  const keywordsSection = keywords
    ? `<div style="margin-bottom:20px">
         <div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">주요 키워드</div>
         <div>${keywords}</div>
       </div>`
    : "";

  const issuesSection = issues
    ? `<div style="margin-bottom:20px">
         <div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">주요 이슈</div>
         <ul style="margin:0;padding-left:20px">${issues}</ul>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Apple SD Gothic Neo',Pretendard,system-ui,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- 헤더 -->
    <div style="background:linear-gradient(135deg,#6366f1 0%,#818cf8 100%);padding:28px 32px">
      <div style="color:#c7d2fe;font-size:11px;letter-spacing:.08em;margin-bottom:6px">SOCIAL LISTENER · DAILY REPORT</div>
      <div style="color:#fff;font-size:22px;font-weight:700">${guildName} / #${channelName}</div>
      <div style="color:#c7d2fe;font-size:14px;margin-top:6px">${date}</div>
    </div>

    <!-- 본문 -->
    <div style="padding:28px 32px">
      ${alertBadge}

      <!-- 감성 분석 -->
      <div style="margin-bottom:24px">
        <div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:6px">감성 분석</div>
        ${sentimentBar}
        <div style="font-size:13px;color:#64748b;margin-top:8px">총 메시지 ${report.messageCount || 0}건 분석</div>
      </div>

      <!-- 동향 요약 -->
      <div style="margin-bottom:20px">
        <div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">동향 요약</div>
        <div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-radius:8px;padding:14px 16px">${report.summary || "—"}</div>
      </div>

      ${customSection}
      ${keywordsSection}
      ${issuesSection}
    </div>

    <!-- 푸터 -->
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
      Social Listener by ANTIGRAVITY &nbsp;·&nbsp; 이 메일은 자동 발송됩니다
    </div>
  </div>
</body>
</html>`;
}

module.exports = { sendEmailReport, appendToGoogleSheet };
