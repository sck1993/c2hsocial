"use strict";

const axios = require("axios");
const { createCollector, sleep } = require("./instagramCollectorCore");

// Facebook Login for Business 기반 Instagram API (graph.facebook.com)
// 토큰 형식: EAAxxxxxxx (Facebook User Access Token)
const IG_API = "https://graph.facebook.com/v22.0";

const core = createCollector(IG_API, "instagram");

/**
 * 액세스 토큰으로 연결 가능한 Instagram 비즈니스 계정 목록 조회
 * Facebook Login for Business 방식: /me/accounts 에서 연결된 IG 비즈니스 계정 탐색
 * @param {string} accessToken - EAAxxxx 형식의 Facebook User Access Token
 * @returns {Promise<Array<{igUserId: string, username: string, pageId: string, pageName: string}>>}
 */
async function listConnectedInstagramAccounts(accessToken) {
  const resp = await axios.get(`${IG_API}/me/accounts`, {
    params: {
      fields: "instagram_business_account{id,username}",
      access_token: accessToken,
    },
    timeout: 15000,
  });

  const pages = resp.data?.data || [];
  const accounts = [];
  for (const page of pages) {
    const igAcc = page.instagram_business_account;
    if (igAcc?.id) {
      accounts.push({
        igUserId: igAcc.id,
        username: igAcc.username || "",
        pageId: page.id || "",
        pageName: page.name || "",
      });
    }
  }
  return accounts;
}

/**
 * Long-lived 토큰 갱신 (60일 만료 전 주기적 갱신)
 * Facebook Login: fb_exchange_token 방식 (계정별 appId / appSecret 사용)
 * @param {string} accessToken
 * @param {string} appId - Meta 앱 ID (Firestore 계정 문서에서 조회)
 * @param {string} appSecret - Meta 앱 시크릿 (Firestore 계정 문서에서 조회)
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
async function refreshToken(accessToken, appId, appSecret) {
  if (!appId || !appSecret) {
    throw new Error("앱 ID / 앱 시크릿 미설정 — 계정 설정을 확인하세요");
  }

  const resp = await axios.get(`${IG_API}/oauth/access_token`, {
    params: {
      grant_type:      "fb_exchange_token",
      client_id:       appId,
      client_secret:   appSecret,
      fb_exchange_token: accessToken,
    },
    timeout: 15000,
  });
  const { access_token, expires_in } = resp.data;
  if (!access_token) throw new Error("토큰 갱신 실패: 응답에 access_token 없음");
  return { accessToken: access_token, expiresIn: expires_in };
}

/**
 * debug_token API로 실제 토큰 만료 시각 조회
 * @param {string} inputToken - 검사할 액세스 토큰
 * @param {string} appId
 * @param {string} appSecret
 * @returns {Promise<{isValid: boolean, expiresAt: Date|null, dataAccessExpiresAt: Date|null, scopes: string[]}>}
 */
async function debugToken(inputToken, appId, appSecret) {
  const resp = await axios.get(`${IG_API}/debug_token`, {
    params: {
      input_token: inputToken,
      access_token: `${appId}|${appSecret}`,
    },
    timeout: 15000,
  });
  const d = resp.data?.data;
  if (!d) throw new Error("debug_token 응답에 data 없음");
  return {
    isValid: d.is_valid ?? false,
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
    dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000) : null,
    scopes: d.scopes || [],
  };
}

module.exports = {
  listConnectedInstagramAccounts,
  refreshToken,
  debugToken,
  ...core,
  sleep,
};
