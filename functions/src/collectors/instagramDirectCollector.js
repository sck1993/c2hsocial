"use strict";

const axios = require("axios");
const { createCollector, sleep } = require("./instagramCollectorCore");

// Business Login for Instagram 기반 Instagram API (graph.instagram.com)
// 토큰 형식: Instagram User Access Token (Facebook 계정/페이지 연결 불필요)
const IG_DIRECT_API = "https://graph.instagram.com";

const core = createCollector(IG_DIRECT_API, "instagram_direct");

/**
 * Instagram User Access Token 유효성 검증 + igUserId / username 조회
 * /me 엔드포인트로 직접 검증 (Facebook API의 debug_token과 달리 appId/appSecret 불필요)
 * @param {string} accessToken - Instagram User Access Token
 * @returns {Promise<{igUserId: string, username: string, isValid: boolean}>}
 */
async function debugIgDirectToken(accessToken) {
  const resp = await axios.get(`${IG_DIRECT_API}/me`, {
    params: {
      fields: "id,username",
      access_token: accessToken,
    },
    timeout: 15000,
  });
  const { id, username } = resp.data;
  if (!id) throw new Error("/me 응답에 id 없음 — 토큰이 유효하지 않습니다");
  return { igUserId: id, username: username || "", isValid: true };
}

/**
 * Long-lived Instagram User Access Token 갱신 (60일 만료 전 주기적 갱신)
 * Instagram Business Login 방식: grant_type=ig_refresh_token (appId/appSecret 불필요)
 * @param {string} accessToken
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
async function refreshDirectToken(accessToken) {
  const resp = await axios.get(`${IG_DIRECT_API}/refresh_access_token`, {
    params: {
      grant_type: "ig_refresh_token",
      access_token: accessToken,
    },
    timeout: 15000,
  });
  const { access_token, expires_in } = resp.data;
  if (!access_token) throw new Error("토큰 갱신 실패: 응답에 access_token 없음");
  return { accessToken: access_token, expiresIn: expires_in };
}

module.exports = {
  debugIgDirectToken,
  refreshDirectToken,
  ...core,
  sleep,
};
