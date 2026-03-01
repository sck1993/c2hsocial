const axios = require("axios");

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Discord Epoch(2015-01-01)을 기준으로 타임스탬프를 Snowflake ID로 변환.
 * after 파라미터로 특정 시점 이후 메시지만 조회할 때 사용.
 */
function timestampToSnowflake(ms) {
  const DISCORD_EPOCH = 1420070400000n;
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

function authHeader() {
  return { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
}

/**
 * Discord 채널에서 지난 hoursBack 시간 동안의 메시지를 수집.
 * 100개 단위로 자동 페이지네이션.
 *
 * @param {string} channelId  - Discord 채널 ID
 * @param {number} hoursBack  - 수집 기간 (기본 24시간)
 * @returns {Promise<Array<{author, content, timestamp}>>}
 */
async function fetchChannelMessages(channelId, hoursBack = 24) {
  const since = Date.now() - hoursBack * 60 * 60 * 1000;
  const afterSnowflake = timestampToSnowflake(since);

  let allMessages = [];
  let lastId = afterSnowflake;

  // after 파라미터 사용 시 오름차순(오래된 것 → 최신) 반환
  while (true) {
    const { data } = await axios.get(
      `${DISCORD_API}/channels/${channelId}/messages`,
      {
        headers: authHeader(),
        params: { limit: 100, after: lastId },
      }
    );

    if (!data || data.length === 0) break;

    allMessages = allMessages.concat(data);

    // 100개 미만이면 마지막 페이지
    if (data.length < 100) break;

    // 다음 페이지: 현재 배치에서 가장 최신 메시지 ID를 기준으로
    lastId = data[data.length - 1].id;
  }

  // 봇 메시지 제외 + 필요 필드만 추출
  return allMessages
    .filter((m) => !m.author?.bot)
    .map((m) => ({
      author: m.author.username,
      content: m.content,
      timestamp: m.timestamp,
    }));
}

/**
 * Discord 채널 기본 정보 조회 (채널명, 서버 ID).
 *
 * @param {string} channelId
 * @returns {Promise<{name, guildId}>}
 */
async function getChannelInfo(channelId) {
  const { data } = await axios.get(
    `${DISCORD_API}/channels/${channelId}`,
    { headers: authHeader() }
  );
  return { name: data.name, guildId: data.guild_id };
}

/**
 * Discord 서버(길드) 기본 정보 조회 (서버명).
 * 봇이 해당 서버에 가입되어 있어야 조회 가능.
 *
 * @param {string} guildId
 * @returns {Promise<{id, name}>}
 */
async function getGuildInfo(guildId) {
  const { data } = await axios.get(
    `${DISCORD_API}/guilds/${guildId}`,
    { headers: authHeader() }
  );
  return { id: data.id, name: data.name };
}

module.exports = { fetchChannelMessages, getChannelInfo, getGuildInfo };
