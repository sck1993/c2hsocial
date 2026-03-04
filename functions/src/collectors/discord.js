const axios = require("axios");

const DISCORD_API       = "https://discord.com/api/v10";
// Discord GET /channels/{id}/messages 레이트 리밋: 5req/5sec (= 1req/sec)
// 1200ms = 1req/1.2sec 로 약 20% 여유를 두어 버킷 초과 방지
const MIN_PAGE_DELAY_MS = 1200;

// 배치당 최대 수집 페이지 수 (1페이지 = 100개 메시지)
// - Firestore 문서 1MB 한도 고려: 5,000개 × ~200B = ~1MB
// - 증분 수집(2시간)에서는 보통 1-2페이지면 충분
// - 한도 도달 시 alertPipeline이 자동으로 다음 배치를 이어서 수집
const MAX_PAGES = 50;

/**
 * Discord Epoch(2015-01-01)을 기준으로 타임스탬프를 Snowflake ID로 변환.
 */
function timestampToSnowflake(ms) {
  const DISCORD_EPOCH = 1420070400000n;
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

function authHeader() {
  return { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate-limit-aware Discord GET 요청.
 *
 * 두 가지 보호 레이어:
 * 1) [예방] 응답 헤더의 X-RateLimit-Remaining 확인 → 0이면 Reset까지 미리 대기
 * 2) [복구] 429 응답 시 retry_after 기준으로 대기 후 재시도 (최대 maxRetries 회)
 */
async function discordGet(url, options, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;

    try {
      response = await axios.get(url, { ...options, validateStatus: null });
    } catch (err) {
      // 네트워크 오류 (타임아웃 등) — 재시도
      if (attempt < maxRetries) {
        console.warn(`[discord] 네트워크 오류 — 2초 후 재시도 (${attempt + 1}/${maxRetries}):`, err.message);
        await sleep(2000);
        continue;
      }
      throw err;
    }

    // 429: 레이트 리밋 초과 → retry_after 만큼 대기 후 재시도
    if (response.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`[discord] ${url}: 429 Rate Limited — 최대 재시도 횟수 초과`);
      }
      const retryAfterSec = response.data?.retry_after ?? 1;
      const isGlobal      = response.data?.global ?? false;
      const waitMs        = Math.ceil(retryAfterSec * 1000) + 500;
      console.warn(
        `[discord] 429 ${isGlobal ? "(global) " : ""}Rate Limited — ${(waitMs / 1000).toFixed(1)}초 대기 후 재시도 (${attempt + 1}/${maxRetries})`
      );
      await sleep(waitMs);
      continue;
    }

    // 기타 HTTP 오류
    if (response.status >= 400) {
      throw Object.assign(
        new Error(`[discord] HTTP ${response.status}: ${JSON.stringify(response.data)}`),
        { response }
      );
    }

    // [예방] 레이트 리밋 버킷 소진 체크
    // remaining <= 1: 0(소진)은 물론 1(한 번 남음)에서도 미리 대기 — 429 예방 여유 확보
    // 버퍼 500ms: 네트워크 지연·타이밍 오차 흡수용
    const remaining     = parseInt(response.headers["x-ratelimit-remaining"] ?? "2", 10);
    const resetAfterSec = parseFloat(response.headers["x-ratelimit-reset-after"] ?? "0");
    if (remaining <= 1 && resetAfterSec > 0) {
      const waitMs = Math.ceil(resetAfterSec * 1000) + 500;
      console.log(`[discord] 레이트 리밋 임박 (remaining=${remaining}) → ${(waitMs / 1000).toFixed(1)}초 대기`);
      await sleep(waitMs);
    }

    return response;
  }

  throw new Error(`[discord] ${url}: 최대 재시도 횟수 초과`);
}

/**
 * Discord 채널에서 지난 hoursBack 시간 동안의 메시지를 수집 (최대 MAX_PAGES 페이지).
 * 페이지 간 최소 1초 대기 + 레이트 리밋 헤더 준수로 429 예방.
 *
 * MAX_PAGES 도달 시 hitMaxPages=true를 반환하며,
 * alertPipeline은 lastRawId를 afterSnowflake로 사용해 다음 배치를 이어서 수집.
 *
 * @param {string}      channelId       - Discord 채널 ID
 * @param {number}      hoursBack       - 수집 기간 (afterSnowflake 있으면 무시됨)
 * @param {string|null} afterSnowflake  - 이 Snowflake ID 이후 메시지만 수집 (증분/연속 수집용)
 * @returns {Promise<{ messages: Array, hitMaxPages: boolean, lastRawId: string|null }>}
 */
async function fetchChannelMessages(channelId, hoursBack = 24, afterSnowflake = null) {
  const startSnowflake = afterSnowflake
    ? afterSnowflake
    : timestampToSnowflake(Date.now() - hoursBack * 60 * 60 * 1000);

  let allMessages  = [];
  let lastId       = startSnowflake;
  let lastRawId    = null; // 봇 필터링 전 마지막 메시지 ID — 다음 배치 커서용
  let pageCount    = 0;
  let hitMaxPages  = false;

  while (true) {
    // 두 번째 페이지부터 최소 대기 — 같은 채널 연속 요청 시 레이트 리밋 예방
    if (pageCount > 0) {
      await sleep(MIN_PAGE_DELAY_MS);
    }
    pageCount++;

    // 최대 페이지 수 초과 시 중단 — alertPipeline이 다음 배치를 이어서 처리
    if (pageCount > MAX_PAGES) {
      hitMaxPages = true;
      console.log(
        `[discord] ${channelId} ${MAX_PAGES}페이지 완료 — 다음 배치로 이어짐 (누적 ${allMessages.length}개)`
      );
      break;
    }

    const { data } = await discordGet(
      `${DISCORD_API}/channels/${channelId}/messages`,
      {
        headers: authHeader(),
        params: { limit: 100, after: lastId },
      }
    );

    if (!data || data.length === 0) break;

    // Discord API는 after 파라미터 사용 시 메시지를 내림차순(최신→오래된순)으로 반환.
    // 올바른 전진 페이지네이션을 위해 ID 오름차순으로 정렬 (가장 작은 ID = 가장 오래된 메시지가 앞).
    data.sort((a, b) => {
      const idA = BigInt(a.id), idB = BigInt(b.id);
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });

    allMessages = allMessages.concat(data);
    lastRawId   = data[data.length - 1].id; // 정렬 후 마지막 = 가장 최신 메시지 ID

    // 100개 미만이면 마지막 페이지
    if (data.length < 100) break;

    lastId = lastRawId;
    console.log(`[discord] ${channelId} 페이지 ${pageCount}/${MAX_PAGES} — 누적 ${allMessages.length}개`);
  }

  // 봇 메시지 제외 + 노이즈 필터링 + 필요 필드만 추출
  //
  // 노이즈 3종 제거:
  //   1) 빈 content — 이미지·파일 첨부만 있는 메시지
  //   2) 커스텀 이모지 전용 — <:name:id> / <a:name:id> 제거 후 텍스트 없는 경우
  //   3) URL 전용 — Tenor GIF, Giphy 등 링크만 붙여넣은 경우
  const messages = allMessages
    .filter((m) => !m.author?.bot)
    .filter((m) => {
      const text = (m.content || "").trim();
      if (!text) return false;                                          // 1) 빈 메시지
      const stripped = text.replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, "").trim();
      if (!stripped) return false;                                      // 2) 이모지 전용
      if (/^https?:\/\/\S+$/.test(stripped)) return false;             // 3) URL 전용
      return true;
    })
    .map((m) => ({
      id:        m.id,
      author:    m.author.username,
      content:   m.content,
      timestamp: m.timestamp,
    }));

  return { messages, hitMaxPages, lastRawId };
}

/**
 * Discord 채널 기본 정보 조회 (채널명, 서버 ID).
 */
async function getChannelInfo(channelId) {
  const { data } = await discordGet(
    `${DISCORD_API}/channels/${channelId}`,
    { headers: authHeader() }
  );
  return { name: data.name, guildId: data.guild_id };
}

/**
 * Discord 서버(길드) 기본 정보 조회 (서버명).
 * 봇이 해당 서버에 가입되어 있어야 조회 가능.
 */
async function getGuildInfo(guildId) {
  const { data } = await discordGet(
    `${DISCORD_API}/guilds/${guildId}`,
    { headers: authHeader() }
  );
  return { id: data.id, name: data.name };
}

module.exports = { fetchChannelMessages, getChannelInfo, getGuildInfo };
