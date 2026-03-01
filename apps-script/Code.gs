/**
 * Social Listener — Google Apps Script 통합 웹훅
 *
 * 역할:
 *  1. Cloud Functions pipeline → doPost 호출
 *  2. 스프레드시트 "설정" 탭에서 수신자 이메일 조회
 *  3. MailApp으로 HTML 이메일 발송 (개인 Gmail, 무료 영구)
 *  4. 채널별 리포트 탭에 데이터 행 추가
 *
 * 배포 설정:
 *  - 실행 계정: 나 (본인 Gmail)
 *  - 액세스: 모든 사용자 (익명 포함)
 *
 * 고객 시트 구조:
 *  - "설정" 탭: A열=채널명, B열=이메일(쉼표 구분)
 *  - "동향 리포트_discord(서버_채널)" 탭: 자동 생성
 */

/* ════════════════════════════════════════════
   진입점
════════════════════════════════════════════ */
function doPost(e) {
  try {
    var payload        = JSON.parse(e.postData.contents);
    var channelName    = payload.channelName    || "";
    var guildName      = payload.guildName      || "";
    var date           = payload.date           || "";
    var report         = payload.report         || {};
    var spreadsheetUrl = payload.spreadsheetUrl || "";
    var emailEnabled   = payload.emailEnabled   !== false; // 기본 true

    if (!spreadsheetUrl) {
      return respond({ success: false, error: "spreadsheetUrl missing" });
    }

    var ss      = SpreadsheetApp.openByUrl(spreadsheetUrl);
    var results = { email: "skipped", sheet: null };

    // ── 1. 이메일 발송 (설정 탭 수신자 조회) ────────────
    if (emailEnabled) {
      var recipients = getRecipients(ss, channelName);
      if (recipients.length > 0) {
        var subject = "[Social Listener] " + guildName + " / #" + channelName + " 일일 리포트 (" + date + ")";
        var html    = buildEmailHTML(channelName, guildName, date, report);
        recipients.forEach(function (addr) {
          MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html });
        });
        results.email = "sent:" + recipients.length;
      } else {
        results.email = "no recipients in 설정 tab";
      }
    }

    // ── 2. 시트 기록 ────────────────────────────────────
    appendReportRow(ss, channelName, guildName, date, report);
    results.sheet = "appended";

    return respond({ success: true, results: results });

  } catch (err) {
    return respond({ success: false, error: err.message });
  }
}

/* ════════════════════════════════════════════
   "설정" 탭에서 채널명으로 수신자 조회
   A열: 채널명 | B열: 이메일(쉼표 구분)
════════════════════════════════════════════ */
function getRecipients(ss, channelName) {
  var sheet = ss.getSheetByName("설정");
  if (!sheet) return [];

  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {           // 0행은 헤더
    var cellName = rows[i][0] ? rows[i][0].toString().trim() : "";
    if (cellName === channelName) {
      var emailCell = rows[i][1] ? rows[i][1].toString() : "";
      return emailCell.split(",").map(function (e) { return e.trim(); }).filter(Boolean);
    }
  }
  return [];
}

/* ════════════════════════════════════════════
   채널 탭에 리포트 행 추가 (없으면 탭 생성)
════════════════════════════════════════════ */
function appendReportRow(ss, channelName, guildName, date, report) {
  var tabName = ("동향 리포트_discord(" + guildName + "_" + channelName + ")").substring(0, 100);
  var sheet   = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(["날짜", "메시지수", "긍정%", "중립%", "부정%", "키워드", "주요이슈", "동향요약", "맞춤답변", "위기알림"]);
    // 헤더 스타일
    var header = sheet.getRange(1, 1, 1, 10);
    header.setBackground("#6366f1");
    header.setFontColor("#ffffff");
    header.setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  var s = report.sentiment || {};
  sheet.appendRow([
    date,
    report.messageCount  || 0,
    s.positive           || 0,
    s.neutral            || 0,
    s.negative           || 0,
    (report.keywords || []).join(", "),
    (report.issues   || []).join(" / "),
    report.summary       || "",
    report.custom_answer || "",
    report.isAlertTriggered ? "⚠️ 위기 감지" : "",
  ]);
}

/* ════════════════════════════════════════════
   HTML 이메일 빌더
════════════════════════════════════════════ */
function buildEmailHTML(channelName, guildName, date, report) {
  var s   = report.sentiment || {};
  var pos = s.positive || 0;
  var neu = s.neutral  || 0;
  var neg = s.negative || 0;

  var sentimentBar =
    '<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:10px 0 6px">' +
      '<div style="width:' + pos + '%;background:#059669"></div>' +
      '<div style="width:' + neu + '%;background:#94a3b8"></div>' +
      '<div style="width:' + neg + '%;background:#dc2626"></div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;font-size:13px">' +
      '<span style="color:#059669">긍정 ' + pos + '%</span>' +
      '<span style="color:#94a3b8">중립 ' + neu + '%</span>' +
      '<span style="color:#dc2626">부정 ' + neg + '%</span>' +
    '</div>';

  var keywords = (report.keywords || []).map(function (k) {
    return '<span style="display:inline-block;background:#ede9fe;color:#6366f1;border-radius:4px;padding:2px 8px;margin:2px 3px;font-size:13px">' + k + '</span>';
  }).join("");

  var issues = (report.issues || []).map(function (item) {
    return '<li style="margin-bottom:6px;color:#374151;font-size:14px;line-height:1.6">' + item + '</li>';
  }).join("");

  var alertBadge = report.isAlertTriggered
    ? '<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#dc2626;font-weight:600;font-size:14px">⚠️ 위기 감지 — 부정 감정 임계치 초과 또는 트리거 키워드 감지</div>'
    : "";

  var customSection = report.custom_answer
    ? '<div style="margin-bottom:20px"><div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">맞춤 분석</div><div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-radius:8px;padding:14px 16px">' + report.custom_answer + '</div></div>'
    : "";

  var keywordsSection = keywords
    ? '<div style="margin-bottom:20px"><div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">주요 키워드</div><div>' + keywords + '</div></div>'
    : "";

  var issuesSection = issues
    ? '<div style="margin-bottom:20px"><div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">주요 이슈</div><ul style="margin:0;padding-left:20px">' + issues + '</ul></div>'
    : "";

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f8fafc;font-family:\'Apple SD Gothic Neo\',system-ui,sans-serif">' +
    '<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">' +
      '<div style="background:linear-gradient(135deg,#6366f1 0%,#818cf8 100%);padding:28px 32px">' +
        '<div style="color:#c7d2fe;font-size:11px;letter-spacing:.08em;margin-bottom:6px">SOCIAL LISTENER · DAILY REPORT</div>' +
        '<div style="color:#fff;font-size:22px;font-weight:700">' + guildName + ' / #' + channelName + '</div>' +
        '<div style="color:#c7d2fe;font-size:14px;margin-top:6px">' + date + '</div>' +
      '</div>' +
      '<div style="padding:28px 32px">' +
        alertBadge +
        '<div style="margin-bottom:24px">' +
          '<div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:6px">감성 분석</div>' +
          sentimentBar +
          '<div style="font-size:13px;color:#64748b;margin-top:8px">총 메시지 ' + (report.messageCount || 0) + '건 분석</div>' +
        '</div>' +
        '<div style="margin-bottom:20px">' +
          '<div style="font-size:13px;font-weight:700;color:#6366f1;margin-bottom:8px">동향 요약</div>' +
          '<div style="font-size:14px;color:#374151;line-height:1.7;background:#f8fafc;border-radius:8px;padding:14px 16px">' + (report.summary || "—") + '</div>' +
        '</div>' +
        customSection + keywordsSection + issuesSection +
      '</div>' +
      '<div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">' +
        'Social Listener by ANTIGRAVITY &nbsp;·&nbsp; 이 메일은 자동 발송됩니다' +
      '</div>' +
    '</div></body></html>';
}

/* ════════════════════════════════════════════
   유틸
════════════════════════════════════════════ */
function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ════════════════════════════════════════════
   수동 테스트 (GAS 에디터에서 직접 실행)
════════════════════════════════════════════ */
function testDelivery() {
  var fakeEvent = {
    postData: {
      contents: JSON.stringify({
        channelName:    "general",
        guildName:      "테스트 서버",
        date:           "2026-03-01",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit",
        emailEnabled:   true,
        report: {
          messageCount:    42,
          summary:         "오늘은 전반적으로 긍정적인 분위기였습니다.",
          custom_answer:   "",
          sentiment:       { positive: 60, neutral: 25, negative: 15 },
          keywords:        ["패치", "업데이트", "밸런스"],
          issues:          ["일부 유저가 렉 문제 제보"],
          isAlertTriggered: false,
        },
      }),
    },
  };
  var result = doPost(fakeEvent);
  Logger.log(result.getContent());
}
