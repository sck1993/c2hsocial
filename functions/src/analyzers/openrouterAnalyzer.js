const axios = require("axios");

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_NAVER_LOUNGE_ANALYSIS_PROMPT = `다음 형식으로 요약하라.

[전체 요약] 오늘 커뮤니티의 전반적인 분위기를 1-2문장으로 기술.
[플레이 반응] 최근 업데이트 또는 신규 콘텐츠에 대한 유저 반응.
[요구/건의] 유저들이 게임에 바라는 내용 또는 건의사항.

각 카테고리에 해당 내용이 없으면 "특이사항 없음"으로 기재한다.`;

const DEFAULT_DC_ANALYSIS_PROMPT = `다음 형식으로 요약하라.

[전체 요약] 오늘 갤러리의 전반적인 분위기와 주요 화제를 1-2문장으로 기술.
[주요 반응] 이슈·사건·콘텐츠에 대한 갤러 반응 및 의견.
[요구/건의] 운영·관련 대상에 대한 갤러들의 요구사항 또는 개선 의견.

각 카테고리에 해당 내용이 없으면 "특이사항 없음"으로 기재한다.`;

/**
 * LLM 응답 문자열에서 JSON 객체를 추출. 파싱 실패 시 null 반환.
 */
function extractJson(content) {
  try { return JSON.parse(content); } catch (_) {}
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                content.match(/(\{[\s\S]*\})/);
  if (match) { try { return JSON.parse(match[1]); } catch (_) {} }
  return null;
}

/**
 * LLM 응답 문자열에서 JSON 리포트를 파싱.
 * 파싱 실패 시 원문을 summary에 담은 fallback 반환.
 */
function parseReport(content) {
  const parsed = extractJson(content);
  if (parsed) return parsed;
  console.warn("[openrouter] JSON 파싱 실패. 원문:", content.slice(0, 300));
  return {
    summary: content,
    custom_answer: "",
    sentiment: { positive: 0, neutral: 100, negative: 0 },
    keywords: [],
    issues: [],
  };
}

/**
 * 서버(Guild) 내 여러 채널 메시지를 통합 분석하여 서버 단위 리포트 생성.
 *
 * @param {Array<{channelDocId, channelName, importance, messages}>} channelsData
 * @param {string} guildName - Discord 서버명
 * @returns {Promise<{report, usage}>}
 */
async function analyzeGuildMessages(channelsData, guildName, guildId = "", summaryPrompt = "") {
  // 채널별 메시지 텍스트 구성 (메시지 ID 포함)
  const channelsSections = channelsData.map(({ channelName, importance, messages, discordChannelId }) => {
    const importanceLabel = importance === "high" ? "높음" : importance === "low" ? "낮음" : "보통";
    const messagesText = messages
      .map((m) => {
        const time = new Date(m.timestamp).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
        return `  [id:${m.id} | ${time}] ${m.author}: ${m.content}`;
      })
      .join("\n");
    return `=== #${channelName} (channelId: ${discordChannelId}, 중요도: ${importanceLabel}, ${messages.length}개 메시지) ===\n${messagesText}`;
  }).join("\n\n");

  const channelListForPrompt = channelsData.map(({ channelDocId, channelName, importance, customPrompt, discordChannelId }) => {
    const rule = importance === "low"
      ? "1문장 요약만 (잡담 채널)"
      : importance === "high"
      ? "3-4문장 상세 분석 (중요 채널)"
      : "2문장 요약 (일반 채널)";
    const customNote = customPrompt ? ` [맞춤 지시사항: ${customPrompt}]` : "";
    return `- channelDocId: "${channelDocId}", channelId: "${discordChannelId}", channelName: "${channelName}", 중요도: ${importance === "high" ? "높음" : importance === "low" ? "낮음" : "보통"} → ${rule}${customNote}`;
  }).join("\n");

  const summaryInstruction = summaryPrompt
    ? `서버 전체 동향 요약. 반드시 아래 지시사항을 따르세요: ${summaryPrompt}\n아래 HTML 형식 규칙도 함께 적용하세요.`
    : `서버 전체 동향을 섹션별로 나누어 HTML 형식으로 작성하세요.`;

  const summaryInstructionEn = summaryPrompt
    ? `English server trend summary. Follow the same HTML format rules. Adapt this custom instruction in English: ${summaryPrompt}`
    : `English server trend summary using the same HTML section format (same emoji headings, same structure, naturally translated).`;

  const summaryFormatGuide = `
[summary 필드 HTML 형식 규칙]
- summary 값은 HTML 태그가 포함된 문자열입니다 (웹/이메일 모두 HTML 렌더링).
- 각 섹션은 이모지 + <strong>섹션명</strong> 형태의 제목으로 시작하세요.
- 섹션 사이는 반드시 <br><br>로 구분하세요.
- 중요한 표현·수치·키워드는 <strong>굵게</strong> 처리하세요.
- 사용할 섹션 (내용이 없으면 해당 섹션 생략):
  📊 <strong>전체 동향</strong> — 핵심 흐름 1-2문장
  🎮 <strong>플레이/콘텐츠 반응</strong> — 게임플레이·콘텐츠 관련 반응
  💬 <strong>전반 감정</strong> — 커뮤니티 전반의 감정 흐름
  📢 <strong>요구/건의</strong> — 유저들이 요구하는 개선사항
  🚨 <strong>리스크 신호</strong> — 이탈·환불·부정 여론 급증 등 위험 징후`;

  const systemPrompt = `당신은 소셜 미디어 동향 분석 전문가입니다.
주어진 Discord 서버의 여러 채널 메시지를 통합 분석하여 아래 JSON 형식으로만 응답하세요.
마크다운 코드블록 없이 순수 JSON만 출력하세요.
모든 _en 필드는 영어로 자연스럽게 작성하세요.
${summaryFormatGuide}

분석 대상 채널 및 중요도별 요약 규칙:
${channelListForPrompt}

[issues 필드 규칙]
- 포함해야 하는 이슈: 버그 제보, 결제·환불 문제, 해킹·보안 이슈, 확률·밸런스 불만, 서버 장애·점검 관련
- 제외해야 하는 것: 일상적인 잡담, 단순 의견·감상, 일반적인 칭찬이나 불만
- 중요한 이슈가 없으면 반드시 빈 배열 []로 작성하세요.
- channelId: 해당 이슈가 발생한 채널의 channelId (위 목록에서 확인), 특정 불가하면 null
- messageId: 이슈와 가장 관련 있는 대표 메시지의 id값 (메시지 목록의 [id:XXXXX | ...] 에서 XXXXX 부분), 특정 불가하면 null
- messageQuote: 해당 messageId 메시지의 실제 내용 앞 40자를 원문 그대로 복사 (messageId가 null이면 null)

{
  "summary": "${summaryInstruction} (위 HTML 형식 규칙 적용)",
  "summary_en": "${summaryInstructionEn} (apply same HTML format rules)",
  "sentiment": {
    "positive": 0에서100사이정수,
    "neutral": 0에서100사이정수,
    "negative": 0에서100사이정수
  },
  "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3", "핵심키워드4", "핵심키워드5"],
  "keywords_en": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "issues": [
    { "title": "이슈 제목", "title_en": "Issue title in English", "description": "이슈 설명 1-2문장", "description_en": "Issue description 1-2 sentences in English", "count": 언급횟수정수, "channel": "채널명", "channelId": "Discord채널ID또는null", "messageId": "대표메시지ID또는null", "messageQuote": "해당메시지원문앞40자또는null" }
  ],
  "channels": [
    {
      "channelDocId": "채널docId (위 목록의 channelDocId 그대로)",
      "summary": "채널별 요약 (중요도 규칙에 따른 길이)",
      "summary_en": "Channel summary in English (same length rule by importance)",
      "sentiment": { "positive": 0에서100사이정수, "neutral": 0에서100사이정수, "negative": 0에서100사이정수 },
      "keywords": ["키워드1", "키워드2", "키워드3"]
    }
  ]
}`;

  const totalMessages = channelsData.reduce((sum, c) => sum + c.messages.length, 0);
  const userContent = `서버: ${guildName}\n총 메시지 수: ${totalMessages}개\n\n${channelsSections}`;

  const payload = {
    model: process.env.OPENROUTER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    reasoning: { enabled: true },
  };

  const { data } = await axios.post(OPENROUTER_API, payload, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sociallistener-8efde.web.app",
      "X-Title": "AI Social Listening",
    },
    timeout: 120000,
  });

  if (!data.choices || !data.choices.length) throw new Error("OpenRouter 응답에 choices가 없습니다");
  const choice = data.choices[0];
  const content = choice.message.content || "";
  const report = parseGuildReport(content, channelsData);

  return { report, usage: data.usage };
}

/**
 * 길드 리포트 JSON 파싱. 실패 시 fallback 구조 반환.
 */
function parseGuildReport(content, channelsData) {
  const parsed = extractJson(content);

  if (!parsed) {
    console.warn("[openrouter] 길드 리포트 JSON 파싱 실패. 원문:", content.slice(0, 300));
    return {
      summary: content,
      summary_en: "",
      sentiment: { positive: 0, neutral: 100, negative: 0 },
      keywords: [],
      keywords_en: [],
      issues: [],
      channels: channelsData.map(({ channelDocId }) => ({
        channelDocId,
        summary: "",
        summary_en: "",
        sentiment: { positive: 0, neutral: 100, negative: 0 },
        keywords: [],
      })),
    };
  }

  // sentiment 필드 타입 보정: AI가 문자열로 반환하더라도 숫자로 강제 변환
  function normalizeSentiment(s) {
    if (!s || typeof s !== "object") return { positive: 0, neutral: 100, negative: 0 };
    return {
      positive: Math.min(100, Math.max(0, Number(s.positive) || 0)),
      neutral:  Math.min(100, Math.max(0, Number(s.neutral)  || 0)),
      negative: Math.min(100, Math.max(0, Number(s.negative) || 0)),
    };
  }

  if (parsed.sentiment) parsed.sentiment = normalizeSentiment(parsed.sentiment);
  if (Array.isArray(parsed.channels)) {
    for (const ch of parsed.channels) {
      if (ch.sentiment) ch.sentiment = normalizeSentiment(ch.sentiment);
    }
  }

  return parsed;
}

/**
 * 7일치 일일 리포트 summary + issues → 주간 AI 요약 생성
 * @param {Array<{date, summary, issues}>} dailyReports
 * @param {string} guildName
 * @returns {Promise<{aiSummary, weeklyIssues, usage}>}
 */
async function analyzeWeeklySummary(dailyReports, guildName) {
  const dailyText = dailyReports.map(({ date, summary, issues }) => {
    const issueText = (issues || []).map(i => `  - ${i.title} (${i.count || 1}회): ${i.description}`).join("\n");
    return `[${date}]\n동향: ${summary || "(없음)"}\n이슈:\n${issueText || "  없음"}`;
  }).join("\n\n");

  const systemPrompt = `당신은 소셜 미디어 동향 분석 전문가입니다.
아래는 Discord 서버 "${guildName}"의 최근 7일간 일일 동향 요약 및 이슈 목록입니다.
이를 바탕으로 한 주 전체의 동향을 HTML 형식으로 요약하고, 이슈를 병합 정리하세요.
마크다운 코드블록 없이 순수 JSON만 출력하세요.
모든 _en 필드는 영어로 자연스럽게 작성하세요.

[HTML 형식 규칙]
- 각 섹션은 이모지 + <strong>섹션명</strong>으로 시작
- 섹션 사이는 <br><br>로 구분
- 중요 표현은 <strong>굵게</strong>
- 섹션 구성 (내용 없으면 생략):
  📊 <strong>주간 전체 동향</strong>
  💬 <strong>감정 흐름</strong>
  📢 <strong>주요 요구/건의</strong>
  🚨 <strong>리스크 신호</strong>

[weeklyIssues 필드 규칙]
- 7일치 이슈 중 동일하거나 유사한 이슈는 하나로 병합
- count는 원본 이슈 count의 합산 (원본에 없으면 등장 횟수 1로 산정)
- dates는 해당 이슈가 등장한 날짜 목록 (YYYY-MM-DD 배열)
- description은 병합된 내용을 반영해 1-2문장으로 재작성
- 중요한 이슈가 없으면 빈 배열 []

JSON 형식:
{
  "aiSummary": "한국어 HTML 형식 주간 요약",
  "aiSummary_en": "English HTML-formatted weekly summary (same section structure, naturally translated)",
  "weeklyIssues": [
    { "title": "이슈 제목", "title_en": "Issue title in English", "description": "병합 설명 1-2문장", "description_en": "Merged description 1-2 sentences in English", "count": 합산횟수정수, "dates": ["YYYY-MM-DD"] }
  ]
}`;

  const payload = {
    model: process.env.OPENROUTER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: `서버: ${guildName}\n\n${dailyText}` },
    ],
  };

  const { data } = await axios.post(OPENROUTER_API, payload, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sociallistener-8efde.web.app",
      "X-Title": "AI Social Listening",
    },
    timeout: 120000,
  });

  if (!data.choices || !data.choices.length) throw new Error("OpenRouter 응답에 choices가 없습니다");
  const content = data.choices[0].message.content || "";
  const parsed = extractJson(content) || {};

  return { aiSummary: parsed.aiSummary || content, aiSummary_en: parsed.aiSummary_en || "", weeklyIssues: parsed.weeklyIssues || [], usage: data.usage };
}

/**
 * Instagram 최근 1주 게시물 전체 성과 리뷰 AI 분석
 * 잘된 점 / 아쉬운 점 / 개선 제안 3항목으로 출력
 *
 * @param {object} opts
 * @param {string}      opts.username                 - 계정명
 * @param {Array}       opts.posts                    - postsWithInsights 배열 (최근 1주 포스트)
 * @param {number|null} opts.accountAvgEngagementRate - 최근 1주 평균 참여율
 * @param {number|null} opts.followerCount            - 팔로워 수
 * @returns {Promise<{review: string, usage: object}>}
 */
async function analyzeInstagramPostPerformance({ username, posts, accountAvgEngagementRate, followerCount, customPrompt, model }) {
  const resolvedModel = model || process.env.OPENROUTER_MODEL;
  const MEDIA_LABELS = { IMAGE: "사진", VIDEO: "영상", CAROUSEL_ALBUM: "슬라이드" };
  const DOW = ["일", "월", "화", "수", "목", "금", "토"];
  const postLines = (posts || []).map((p, i) => {
    let dateLabel = "—";
    if (p.timestamp) {
      // KST(UTC+9) 기준 날짜·요일
      const dt = new Date(new Date(p.timestamp).getTime() + 9 * 60 * 60 * 1000);
      dateLabel = `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${DOW[dt.getUTCDay()]})`;
    }
    const type = MEDIA_LABELS[p.mediaType] || p.mediaType || "—";
    const rawCaption = p.caption ? p.caption.replace(/\s+/g, " ").trim() : null;
    const captionSnippet = rawCaption
      ? (rawCaption.length > 18 ? `'${rawCaption.slice(0, 18)}…'` : `'${rawCaption}'`)
      : null;
    const views = p.views != null ? p.views : p.reach;
    const parts = [
      `조회 ${views != null ? views.toLocaleString() : "—"}`,
      `좋아요 ${p.likes != null ? p.likes.toLocaleString() : "—"}`,
      `댓글 ${p.comments != null ? p.comments.toLocaleString() : "—"}`,
      `공유 ${p.shares != null ? p.shares.toLocaleString() : "—"}`,
      `저장 ${p.saves != null ? p.saves.toLocaleString() : "—"}`,
      `프로필방문 ${p.profileVisits != null ? p.profileVisits.toLocaleString() : "—"}`,
      `참여율 ${p.engagementRate != null ? p.engagementRate + "%" : "—"}`,
    ];
    const captionPart = captionSnippet ? ` ${captionSnippet}` : "";
    return `[${i + 1}] ${dateLabel}(${type})${captionPart}: ${parts.join(", ")}`;
  }).join("\n");

  const hardConstraintPrompt = `당신은 Instagram 마케팅 전문가입니다.
이번 성과 리뷰에서는 반드시 입력에 제공된 최근 게시물 테이블 정보만 근거로 해석하세요.
허용 근거는 각 게시물의 날짜, 유형, 본문 텍스트, 조회, 좋아요, 댓글, 공유, 저장, 프로필방문, 참여율뿐입니다.
입력에 없는 지표나 화면에 표시되지 않는 지표를 추정하거나 언급하면 안 됩니다.
예를 들어 도달, 평균 시청시간, 팔로워 증감, 저장 외 내부 지표, 별도 계정 지표를 근거처럼 해석하면 안 됩니다.
숫자가 없는 항목은 모른다고 간주하고, 보이는 값만 비교해서 해석하세요.`;

  const defaultInstructionPrompt = `계정의 최근 1주 게시물 전체 성과 데이터를 종합 분석하고, 아래 세 항목으로 나누어 각 2~3문장씩 구체적인 수치 근거를 포함해 작성하세요.
트렌드, 패턴, 포스트 유형별 성과 차이 등을 구체적으로 언급하세요.
마크다운이나 HTML 없이 순수 텍스트로만 응답하세요.
특정 게시물을 언급할 때는 반드시 날짜와 본문 앞부분을 함께 표기하세요. 예: 2/26(목) '댄스챌린지…'에서 참여율이 높았습니다.
반드시 아래 형식 그대로 출력하세요 (이모지 포함):

✅ 잘된 점: (내용)
⚠️ 아쉬운 점: (내용)
💡 개선 제안: (내용)`;
  const instructionPrompt = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : defaultInstructionPrompt;

  const userContent = `@${username} 최근 1주 게시물 테이블 (${(posts || []).length}건):
${postLines || "  (포스트 없음)"}`;

  const payload = {
    model: resolvedModel,
    messages: [
      { role: "system", content: hardConstraintPrompt },
      { role: "system", content: instructionPrompt },
      { role: "user", content: userContent },
    ],
  };

  const { data } = await axios.post(OPENROUTER_API, payload, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sociallistener-8efde.web.app",
      "X-Title": "AI Social Listening",
    },
    timeout: 60000,
  });

  if (!data.choices || !data.choices.length) throw new Error("OpenRouter 응답에 choices가 없습니다");
  const review = data.choices[0].message.content || "";
  return { review: review.trim(), usage: data.usage };
}

const DEFAULT_IG_POST_COMMENT_PROMPT = `당신은 Instagram 콘텐츠 분석가입니다.
이메일 리포트의 게시물 표 아래에 붙일 아주 짧은 코멘트 1~2문장만 작성하세요.
반드시 아래 원칙을 지키세요.
- 게시물 내용, 실제 댓글 반응, 성과 지표를 함께 반영
- 최근 1주 전체 게시물 맥락과 비교해 상대적인 위치를 짚어도 좋습니다
- 과장하거나 단정하지 말고 관찰 기반으로 작성
- 댓글이 거의 없으면 댓글 반응이 아직 제한적이라는 점을 자연스럽게 언급
- 표에 이미 숫자가 나오므로 조회수, 댓글수, 참여율 같은 구체적인 숫자를 반복해서 쓰지 마세요
- 대신 이번 기간 중 상위권 반응, 평균 대비 강함/약함, 저장/공유 중심, 댓글 대화 중심 같은 비교형 표현을 우선 사용하세요
- 마크다운, HTML, 이모지, 따옴표 없이 순수 텍스트만 출력
- 120자 안팎의 짧은 한국어 코멘트로 작성`;

async function analyzeInstagramPostComment({ username, post, comments, periodContext, model, customPrompt }) {
  const resolvedModel = model || process.env.OPENROUTER_MODEL;
  const MEDIA_LABELS = { IMAGE: "사진", VIDEO: "영상", CAROUSEL_ALBUM: "슬라이드" };
  const DOW = ["일", "월", "화", "수", "목", "금", "토"];

  let dateLabel = "—";
  if (post?.timestamp) {
    const dt = new Date(new Date(post.timestamp).getTime() + 9 * 60 * 60 * 1000);
    dateLabel = `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${DOW[dt.getUTCDay()]})`;
  }

  const caption = post?.caption
    ? String(post.caption).replace(/\s+/g, " ").trim()
    : "";
  const captionSnippet = caption
    ? (caption.length > 60 ? `${caption.slice(0, 60)}…` : caption)
    : "캡션 없음";

  const commentLines = (comments || []).slice(0, 100).map((comment, idx) => {
    const text = String(comment?.text || "").replace(/\s+/g, " ").trim();
    const trimmed = text.length > 160 ? `${text.slice(0, 160)}…` : text;
    const usernameLabel = comment?.username ? `@${comment.username}` : "익명";
    const likeLabel = comment?.likeCount ? `, 좋아요 ${comment.likeCount}` : "";
    return `[${idx + 1}] ${usernameLabel}${likeLabel}: ${trimmed || "(내용 없음)"}`;
  }).join("\n");

  const metrics = [
    `유형 ${MEDIA_LABELS[post?.mediaType] || post?.mediaType || "—"}`,
    `조회 ${post?.views != null ? Number(post.views).toLocaleString() : "—"}`,
    `도달 ${post?.reach != null ? Number(post.reach).toLocaleString() : "—"}`,
    `좋아요 ${post?.likes != null ? Number(post.likes).toLocaleString() : "—"}`,
    `댓글 ${post?.comments != null ? Number(post.comments).toLocaleString() : "—"}`,
    `공유 ${post?.shares != null ? Number(post.shares).toLocaleString() : "—"}`,
    `저장 ${post?.saves != null ? Number(post.saves).toLocaleString() : "—"}`,
    `참여율 ${post?.engagementRate != null ? `${post.engagementRate}%` : "—"}`,
  ];
  if (post?.profileVisits != null) metrics.push(`프로필방문 ${Number(post.profileVisits).toLocaleString()}`);
  if (post?.follows != null) metrics.push(`팔로우 ${Number(post.follows).toLocaleString()}`);
  if (post?.reelAvgWatchTime != null) metrics.push(`평균시청 ${(post.reelAvgWatchTime / 1000).toFixed(1)}초`);

  const systemPrompt = (customPrompt && customPrompt.trim())
    ? customPrompt.trim()
    : DEFAULT_IG_POST_COMMENT_PROMPT;

  const userContent = `계정: @${username}
게시물: ${dateLabel}
캡션: ${captionSnippet}
지표: ${metrics.join(", ")}
최근 1주 전체 포스트 비교 맥락:
${periodContext || "(비교 맥락 없음)"}
수집한 최신 댓글 ${Math.min((comments || []).length, 100)}개:
${commentLines || "(댓글 없음)"}`;

  const payload = {
    model: resolvedModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const { data } = await axios.post(OPENROUTER_API, payload, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sociallistener-8efde.web.app",
      "X-Title": "AI Social Listening",
    },
    timeout: 60000,
  });

  if (!data.choices || !data.choices.length) throw new Error("OpenRouter 응답에 choices가 없습니다");
  const comment = (data.choices[0].message.content || "").trim();
  return { comment, usage: data.usage };
}

/**
 * Facebook 그룹 게시글 + 댓글 통합 분석
 *
 * @param {object} opts
 * @param {string}   opts.groupName    - Facebook 그룹 이름
 * @param {string}   opts.date         - 'YYYY-MM-DD' (분석 날짜)
 * @param {Array}    opts.posts        - 수집된 게시글 배열
 *   각 post: { postUrl, authorName, text, publishedAt, reactions, commentCount, comments[] }
 * @param {string}   [opts.customPrompt] - 사용자 커스텀 분석 지시사항
 * @param {string}   [opts.model]        - 사용할 모델 (기본: OPENROUTER_MODEL)
 * @param {string}   [opts.pageName]      - Facebook 페이지 이름
 * @param {string}   [opts.platform]     - facebook | facebook_page | naver_lounge
 * @returns {Promise<{ summary, sentiment, keywords, issues, usage }>}
 */
async function analyzeFacebookGroupPosts({ groupName, pageName, date, posts, customPrompt, model, platform = "facebook" }) {
  const resolvedModel = model || process.env.OPENROUTER_MODEL;
  const isNaverLounge = platform === "naver_lounge";
  const isFacebookPage = platform === "facebook_page";
  const isDcinside = platform === "dcinside";
  const targetName = pageName || groupName || "";
  const platformLabel = isNaverLounge ? "네이버 라운지" : isFacebookPage ? "Facebook 페이지" : isDcinside ? "디시인사이드" : "Facebook 그룹";
  const effectiveCustomPrompt = String(customPrompt || "").trim();
  const naverSummaryPrompt = effectiveCustomPrompt || (isDcinside ? DEFAULT_DC_ANALYSIS_PROMPT : DEFAULT_NAVER_LOUNGE_ANALYSIS_PROMPT);

  function flattenCommentLines(comments = []) {
    const lines = [];

    for (const comment of comments) {
      lines.push(`    - ${comment.author || "익명"}: ${(comment.text || "").slice(0, 100)}`);
      for (const reply of comment.replies || []) {
        lines.push(`      ㄴ ${reply.author || "익명"}: ${(reply.text || "").slice(0, 100)}`);
      }
    }

    return lines.slice(0, 20).join("\n");
  }

  // 게시글 텍스트 구성 (본문 200자 + 댓글 최대 20개)
  const postsText = (posts || [])
    .slice(0, 50) // 최대 50개
    .map((p, i) => {
      const text = (p.text || p.message || "").slice(0, 200);
      const commentLines = flattenCommentLines(p.comments || []);
      return [
        `[${i + 1}] ${p.authorName || targetName || "익명"} (추천 ${p.reactions || p.recommendCount || 0}, 댓글 ${p.commentCount || 0}개${isDcinside ? `, 조회 ${p.viewCount || 0}` : ""})`,
        `    본문: ${text || "(없음)"}`,
        commentLines ? `    댓글:\n${commentLines}` : "    댓글: 없음",
      ].join("\n");
    })
    .join("\n\n");

  const summaryFormatGuide = (isNaverLounge || isDcinside) ? `
[summary 필드 작성 규칙]
- summary 값은 아래 3개 카테고리를 이 순서대로 반드시 모두 포함한 문자열입니다.
- 각 카테고리 제목은 정확히 [전체 요약], [플레이 반응], [요구/건의] 로 시작하세요.
- 각 카테고리 내용은 1~2문장 이내로 간결하게 작성하세요.
- 해당 카테고리에 분석할 내용이 없으면 정확히 "특이사항 없음"이라고 작성하세요.
- 불필요한 추가 섹션, 이모지, 마크다운 코드블록은 넣지 마세요.`
    : `
[summary 필드 HTML 형식 규칙]
- summary 값은 HTML 태그가 포함된 문자열입니다.
- 각 섹션은 이모지 + <strong>섹션명</strong>으로 시작하세요.
- 섹션 사이는 <br><br>로 구분하세요.
- 중요한 표현·수치·키워드는 <strong>굵게</strong> 처리하세요.
- 사용할 섹션 (내용이 없으면 해당 섹션 생략):
  📊 <strong>전체 동향</strong> — 오늘 ${isFacebookPage ? "페이지 게시물" : "그룹"}의 핵심 흐름 2-3문장
  📢 <strong>${isFacebookPage ? "주요 반응/문의" : "주요 의견/건의"}</strong> — ${isFacebookPage ? "유저 댓글에서 반복된 질문, 요청, 불만, 호응" : "멤버들의 요구나 건의사항"}`;

  const defaultInstruction = isDcinside
    ? `디시인사이드 갤러리의 게시글과 댓글 반응을 분석하여 오늘 해당 갤러리의 동향을 파악하세요.
반드시 아래 기본 요약 형식을 그대로 따르세요.
${naverSummaryPrompt}`
    : isNaverLounge
    ? `네이버 라운지 유저들의 게시글과 댓글 반응을 분석하여 오늘 해당 라운지의 동향을 파악하세요.
반드시 아래 기본 요약 형식을 그대로 따르세요.
${naverSummaryPrompt}`
    : `${isFacebookPage
      ? "공식 운영 중인 Facebook 페이지의 유저 댓글 반응을 분석하여 오늘 유저들의 여론 동향을 파악하세요. 분석의 초점은 회사·운영사의 활동이 아닌 유저들의 반응에 있습니다."
      : "그룹 멤버들의 게시글과 댓글 반응을 분석하여 오늘 해당 그룹의 동향을 파악하세요."}
${effectiveCustomPrompt ? `\n추가 지시사항: ${effectiveCustomPrompt}` : ""}`;

  const issueGuide = isDcinside
    ? `- 포함해야 하는 이슈: 논란·이슈 급증, 불만 집중, 특정 사건·사고 화제, 분쟁 확산, 반복 민원, 부정적 여론 형성
- 제외해야 하는 것: 가벼운 잡담, 밈, 단순 유머, 일반적인 후기·소감`
    : isNaverLounge
    ? `- 포함해야 하는 이슈: 업데이트/이벤트 불만, 버그 제보, 보상/운영 논란, 과금·결제 불만, 고객지원 민원, 분쟁 확산
- 제외해야 하는 것: 가벼운 잡담, 일반적인 후기, 단순 칭찬`
    : isFacebookPage
      ? `- 포함해야 하는 이슈: 유저들의 불만/클레임, 반복 문의 급증, 혼란스러운 유저 반응, 논란 확산, 부정적 여론 형성
- 제외해야 하는 것: 회사·운영사의 활동 자체(공지, 제재, 이벤트, 업데이트 등) — 이슈는 반드시 해당 활동에 대한 유저 반응을 기준으로 판단할 것. 단순 인사, 짧은 공감, 일반적인 호응 반응`
      : `- 포함해야 하는 이슈: 분쟁, 논란, 불만 급증, 스팸, 부적절한 콘텐츠, 주요 민원`;

  const systemPrompt = `당신은 소셜 미디어 동향 분석 전문가입니다.
${platformLabel}의 게시글과 댓글 데이터를 분석하여 아래 JSON 형식으로만 응답하세요.
마크다운 코드블록 없이 순수 JSON만 출력하세요.
${summaryFormatGuide}

[issues 필드 규칙]
${issueGuide}
- 중요한 이슈가 없으면 반드시 빈 배열 []로 작성
- postIndex: 해당 이슈가 포함된 게시글 번호 (1-based), 특정 불가하면 null

{
  "summary": "${defaultInstruction} (위 HTML 형식 규칙 적용)",
  "sentiment": {
    "positive": 0에서100사이정수,
    "neutral": 0에서100사이정수,
    "negative": 0에서100사이정수
  },
  "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3", "핵심키워드4", "핵심키워드5"],
  "issues": [
    { "title": "이슈 제목", "description": "이슈 설명 1-2문장", "count": 언급횟수정수, "postIndex": 게시글번호또는null }
  ]
}`;

  // ── vision: 이미지 블록 수집 (포스트당 최대 3장, 전체 최대 10장) ──
  const MAX_TOTAL_IMAGES = 10;
  const imageBlocks = [];
  for (const p of (posts || []).slice(0, 50)) {
    if (imageBlocks.length >= MAX_TOTAL_IMAGES) break;
    for (const img of p.images || []) {
      if (!img || imageBlocks.length >= MAX_TOTAL_IMAGES) break;
      imageBlocks.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType || "image/jpeg"};base64,${img.base64}` },
      });
    }
  }

  const userTextContent = `${isFacebookPage ? "페이지명" : isDcinside ? "갤러리명" : "그룹명"}: ${targetName}
날짜: ${date}
게시글 수: ${(posts || []).length}개${imageBlocks.length > 0 ? `\n첨부 이미지: ${imageBlocks.length}장 (아래 게시글에서 수집된 순서)` : ""}

${postsText || "(게시글 없음)"}`;

  // 이미지가 있으면 vision 포맷(배열 content), 없으면 텍스트만
  const userMessage = imageBlocks.length > 0
    ? { role: "user", content: [{ type: "text", text: userTextContent }, ...imageBlocks] }
    : { role: "user", content: userTextContent };

  if (imageBlocks.length > 0) {
    console.log(`[openrouter] ${platformLabel} vision 분석: 이미지 ${imageBlocks.length}장 포함`);
  }

  const payload = {
    model: resolvedModel,
    messages: [
      { role: "system", content: systemPrompt },
      userMessage,
    ],
  };

  const { data } = await axios.post(OPENROUTER_API, payload, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sociallistener-8efde.web.app",
      "X-Title": "AI Social Listening",
    },
    timeout: 120000,
  });

  if (!data.choices || !data.choices.length)
    throw new Error("OpenRouter 응답에 choices가 없습니다");

  const content = data.choices[0].message.content || "";
  const parsed = extractJson(content);

  if (!parsed) {
    console.warn(`[openrouter] ${platformLabel} 리포트 JSON 파싱 실패. 원문:`, content.slice(0, 300));
    return {
      summary: content,
      sentiment: { positive: 0, neutral: 100, negative: 0 },
      keywords: [],
      issues: [],
      usage: data.usage,
    };
  }

  // sentiment 타입 보정
  if (parsed.sentiment) {
    parsed.sentiment = {
      positive: Math.min(100, Math.max(0, Number(parsed.sentiment.positive) || 0)),
      neutral:  Math.min(100, Math.max(0, Number(parsed.sentiment.neutral)  || 0)),
      negative: Math.min(100, Math.max(0, Number(parsed.sentiment.negative) || 0)),
    };
  }

  return {
    summary:   parsed.summary   || "",
    sentiment: parsed.sentiment || { positive: 0, neutral: 100, negative: 0 },
    keywords:  parsed.keywords  || [],
    issues:    parsed.issues    || [],
    usage: data.usage,
  };
}

module.exports = {
  analyzeGuildMessages,
  analyzeWeeklySummary,
  analyzeInstagramPostPerformance,
  analyzeInstagramPostComment,
  analyzeFacebookGroupPosts,
  DEFAULT_IG_POST_COMMENT_PROMPT,
  DEFAULT_NAVER_LOUNGE_ANALYSIS_PROMPT,
  DEFAULT_DC_ANALYSIS_PROMPT,
};
