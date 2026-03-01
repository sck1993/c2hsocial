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

module.exports = { analyzeMessages };
