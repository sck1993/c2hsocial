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
  return { name: data.name, guildId: data.guild_id, type: data.type };
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

/**
 * Discord 포럼 채널(type=15)에서 메시지 수집.
 * - 활성 스레드: GET /guilds/{guildId}/threads/active → parent_id + last_message_id 타임스탬프 필터
 * - 아카이브 스레드: GET /channels/{forumId}/threads/archived/public → archive_timestamp 필터
 * - 각 스레드 메시지에 "[스레드: {이름}]" prefix 삽입
 *
 * @param {string} forumChannelId   - 포럼 채널 ID
 * @param {string} guildId          - Discord 서버(길드) ID
 * @param {number} afterTimestampMs - 이 시각 이후 메시지만 수집 (ms)
 * @param {number} [deadlineMs]     - 이 시각 이후 스레드 처리 중단 (wall-clock 예산용, 기본값 Infinity)
 * @returns {Promise<{ messages: Array, hitMaxPages: boolean, lastRawId: null, hitTimeLimit: boolean }>}
 */
async function fetchForumMessages(forumChannelId, guildId, afterTimestampMs, deadlineMs = Infinity) {
  const afterSnowflake = timestampToSnowflake(afterTimestampMs);

  // ── 1. 활성 스레드 조회 ──────────────────────────────────────────────────
  let activeThreads = [];
  try {
    const { data } = await discordGet(
      `${DISCORD_API}/guilds/${guildId}/threads/active`,
      { headers: authHeader() }
    );
    activeThreads = (data.threads || []).filter((t) => {
      if (t.parent_id !== forumChannelId) return false;
      // 마지막 메시지 타임스탬프가 afterTimestampMs 이후인 스레드만 포함
      // last_message_id가 없으면 신규 메시지 여부 불명 → 포함하여 안전하게 처리
      if (!t.last_message_id) return true;
      const lastMsgMs = Number((BigInt(t.last_message_id) >> 22n) + 1420070400000n);
      return lastMsgMs > afterTimestampMs;
    });
  } catch (err) {
    console.warn(`[discord] 활성 스레드 조회 실패 (무시): ${err.message}`);
  }

  // ── 2. 아카이브 스레드 조회 ──────────────────────────────────────────────
  let archivedThreads = [];
  try {
    const { data } = await discordGet(
      `${DISCORD_API}/channels/${forumChannelId}/threads/archived/public`,
      { headers: authHeader(), params: { limit: 100 } }
    );
    archivedThreads = (data.threads || []).filter((t) => {
      const archiveTs = new Date(t.thread_metadata?.archive_timestamp || 0).getTime();
      return archiveTs > afterTimestampMs;
    });
  } catch (err) {
    console.warn(`[discord] 아카이브 스레드 조회 실패 (무시): ${err.message}`);
  }

  // ── 3. 중복 제거 ──────────────────────────────────────────────────────────
  const seen = new Set();
  const threads = [];
  for (const t of [...activeThreads, ...archivedThreads]) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      threads.push(t);
    }
  }

  console.log(
    `[discord] 포럼 ${forumChannelId} — 스레드 ${threads.length}개 (활성 ${activeThreads.length}, 아카이브 ${archivedThreads.length})`
  );

  if (threads.length === 0) {
    return { messages: [], hitMaxPages: false, lastRawId: null, hitTimeLimit: false };
  }

  // ── 4. 스레드별 메시지 수집 ───────────────────────────────────────────────
  const allMessages = [];

  for (let ti = 0; ti < threads.length; ti++) {
    // wall-clock 예산 초과 시 남은 스레드 중단 — 다음 실행에서 lastForumSyncAt 기준 재처리
    if (Date.now() >= deadlineMs) {
      const remaining = threads.length - ti;
      console.warn(
        `[discord] 포럼 ${forumChannelId} — wall-clock 초과로 ${remaining}개 스레드 미처리 (처리 완료: ${ti}개)`
      );
      console.log(`[discord] 포럼 ${forumChannelId} — 총 ${allMessages.length}개 메시지 수집 (일부 스레드 미처리)`);
      return { messages: allMessages, hitMaxPages: false, lastRawId: null, hitTimeLimit: true };
    }

    const thread = threads[ti];
    await sleep(MIN_PAGE_DELAY_MS);

    let threadMessages = [];
    let lastId = afterSnowflake;
    let pageCount = 0;

    while (true) {
      if (pageCount > 0) await sleep(MIN_PAGE_DELAY_MS);
      pageCount++;

      if (pageCount > MAX_PAGES) {
        console.warn(`[discord] 스레드 ${thread.id} (${thread.name}) MAX_PAGES 도달 — 이후 메시지 생략`);
        break;
      }

      let data;
      try {
        const response = await discordGet(
          `${DISCORD_API}/channels/${thread.id}/messages`,
          { headers: authHeader(), params: { limit: 100, after: lastId } }
        );
        data = response.data;
      } catch (err) {
        console.warn(`[discord] 스레드 ${thread.id} 메시지 수집 실패 (무시): ${err.message}`);
        break;
      }

      if (!data || data.length === 0) break;

      data.sort((a, b) => {
        const idA = BigInt(a.id), idB = BigInt(b.id);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      });

      threadMessages = threadMessages.concat(data);
      if (data.length < 100) break;
      lastId = data[data.length - 1].id;
    }

    // 봇 메시지 제외 + 노이즈 필터 + 스레드 이름 prefix
    const filtered = threadMessages
      .filter((m) => !m.author?.bot)
      .filter((m) => {
        const text = (m.content || "").trim();
        if (!text) return false;
        const stripped = text.replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, "").trim();
        if (!stripped) return false;
        if (/^https?:\/\/\S+$/.test(stripped)) return false;
        return true;
      })
      .map((m) => ({
        id:        m.id,
        author:    m.author.username,
        content:   `[스레드: ${thread.name}] ${m.content}`,
        timestamp: m.timestamp,
      }));

    allMessages.push(...filtered);
  }

  console.log(`[discord] 포럼 ${forumChannelId} — 총 ${allMessages.length}개 메시지 수집`);
  return { messages: allMessages, hitMaxPages: false, lastRawId: null, hitTimeLimit: false };
}

module.exports = { fetchChannelMessages, fetchForumMessages, getChannelInfo, getGuildInfo };
