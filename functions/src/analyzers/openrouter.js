const axios = require("axios");

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

/**
 * 수집된 메시지를 OpenRouter로 전송해 AI 분석 리포트를 생성.
 * reasoning 활성화 — 응답에 reasoning_details 포함.
 *
 * @param {Array<{author, content, timestamp}>} messages
 * @param {string} channelName
 * @param {string} customPrompt - 채널별 맞춤 분석 지시문 (선택)
 * @returns {Promise<{report, reasoningDetails, usage}>}
 */
async function analyzeMessages(messages, channelName, customPrompt = "") {
  const messagesText = messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
      });
      return `[${time}] ${m.author}: ${m.content}`;
    })
    .join("\n");

  const customSection = customPrompt
    ? `\n\n"custom_answer" 필드: 다음 지시사항에 대한 답변을 작성하세요.\n지시사항: "${customPrompt}"`
    : `\n\n"custom_answer" 필드: 빈 문자열("")로 작성하세요.`;

  const systemPrompt = `당신은 소셜 미디어 동향 분석 전문가입니다.
주어진 Discord 채널 메시지를 분석하여 아래 JSON 형식으로만 응답하세요.
마크다운 코드블록 없이 순수 JSON만 출력하세요.
${customSection}

{
  "summary": "전체 동향 2-3문장 요약 (한국어)",
  "custom_answer": "맞춤 지시사항 답변 또는 빈 문자열",
  "sentiment": {
    "positive": 0에서100사이정수,
    "neutral": 0에서100사이정수,
    "negative": 0에서100사이정수
  },
  "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3", "핵심키워드4", "핵심키워드5"],
  "issues": [
    { "title": "이슈 제목", "description": "이슈 설명 1-2문장", "count": 언급횟수정수 }
  ]
}`;

  const userContent = `채널: #${channelName}\n수집 메시지 수: ${messages.length}개\n\n--- 메시지 목록 ---\n${messagesText}`;

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
      "X-Title": "Social Listener",
    },
    timeout: 120000, // 2분 (reasoning 모델은 느릴 수 있음)
  });

  const choice = data.choices[0];
  const reasoningDetails = choice.message.reasoning_details || [];
  const content = choice.message.content || "";

  const report = parseReport(content);

  return { report, reasoningDetails, usage: data.usage };
}

/**
 * LLM 응답 문자열에서 JSON 리포트를 파싱.
 * 파싱 실패 시 원문을 summary에 담은 fallback 반환.
 */
function parseReport(content) {
  // 1차: 직접 파싱
  try {
    return JSON.parse(content);
  } catch (_) {
    // 2차: 코드블록 or 중괄호 추출 후 파싱
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                  content.match(/(\{[\s\S]*\})/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (_) {}
    }
  }

  // 최종 fallback
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
    ? `서버 전체 동향 요약. 반드시 아래 지시사항을 따르세요: ${summaryPrompt}`
    : "서버 전체 동향 2-3문장 요약 (한국어)";

  const systemPrompt = `당신은 소셜 미디어 동향 분석 전문가입니다.
주어진 Discord 서버의 여러 채널 메시지를 통합 분석하여 아래 JSON 형식으로만 응답하세요.
마크다운 코드블록 없이 순수 JSON만 출력하세요.

분석 대상 채널 및 중요도별 요약 규칙:
${channelListForPrompt}

[issues 필드 규칙]
- 포함해야 하는 이슈: 버그 제보, 결제·환불 문제, 해킹·보안 이슈, 확률·밸런스 불만, 서버 장애·점검 관련
- 제외해야 하는 것: 일상적인 잡담, 단순 의견·감상, 일반적인 칭찬이나 불만
- 중요한 이슈가 없으면 반드시 빈 배열 []로 작성하세요.
- channelId: 해당 이슈가 발생한 채널의 channelId (위 목록에서 확인), 특정 불가하면 null
- messageId: 이슈와 가장 관련 있는 대표 메시지의 id값 (메시지 목록의 [id:XXXXX | ...] 에서 XXXXX 부분), 특정 불가하면 null

{
  "summary": "${summaryInstruction}",
  "sentiment": {
    "positive": 0에서100사이정수,
    "neutral": 0에서100사이정수,
    "negative": 0에서100사이정수
  },
  "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3", "핵심키워드4", "핵심키워드5"],
  "issues": [
    { "title": "이슈 제목", "description": "이슈 설명 1-2문장", "count": 언급횟수정수, "channel": "채널명", "channelId": "Discord채널ID또는null", "messageId": "대표메시지ID또는null" }
  ],
  "channels": [
    {
      "channelDocId": "채널docId (위 목록의 channelDocId 그대로)",
      "summary": "채널별 요약 (중요도 규칙에 따른 길이)",
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
      "X-Title": "Social Listener",
    },
    timeout: 120000,
  });

  const choice = data.choices[0];
  const content = choice.message.content || "";
  const report = parseGuildReport(content, channelsData);

  return { report, usage: data.usage };
}

/**
 * 길드 리포트 JSON 파싱. 실패 시 fallback 구조 반환.
 */
function parseGuildReport(content, channelsData) {
  let parsed = null;

  try {
    parsed = JSON.parse(content);
  } catch (_) {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                  content.match(/(\{[\s\S]*\})/);
    if (match) {
      try { parsed = JSON.parse(match[1]); } catch (_) {}
    }
  }

  if (!parsed) {
    console.warn("[openrouter] 길드 리포트 JSON 파싱 실패. 원문:", content.slice(0, 300));
    return {
      summary: content,
      sentiment: { positive: 0, neutral: 100, negative: 0 },
      keywords: [],
      issues: [],
      channels: channelsData.map(({ channelDocId }) => ({
        channelDocId,
        summary: "",
        sentiment: { positive: 0, neutral: 100, negative: 0 },
        keywords: [],
      })),
    };
  }

  return parsed;
}

module.exports = { analyzeMessages, analyzeGuildMessages };
