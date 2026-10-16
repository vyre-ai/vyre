// @ts-check
// The GitHub account id for Continue with GitHub. The login flow hands back a code. This exchanges it
// and reads the numeric id from GitHub. The caller does not supply that id, and the token is not kept.

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEVICE_URL = "https://github.com/login/device/code";
const CLIENT_ID = /^[A-Za-z0-9._-]{8,100}$/;
const CODE = /^[A-Za-z0-9._-]{8,200}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

/** @param {any} config */
export function githubConfig(config) {
  const gh = config && config.github;
  const clientId = gh && typeof gh.clientId === "string" ? gh.clientId.trim() : "";
  const clientSecret = gh && typeof gh.clientSecret === "string" ? gh.clientSecret.trim() : "";
  const redirect = gh && typeof gh.redirect === "string" ? gh.redirect.trim() : "";
  return {
    clientId: CLIENT_ID.test(clientId) ? clientId : "",
    clientSecret: clientSecret.length >= 8 && clientSecret.length <= 200 ? clientSecret : "",
    redirect: redirectUrl(redirect),
  };
}

/** @param {string} raw */
function redirectUrl(raw) {
  if (!raw || raw.length > 300) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch { return ""; }
}

/** @param {typeof fetch} fetch @param {string} url @param {Record<string, string>} body @param {Record<string, string>} [headers] */
async function post(fetch, url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "vyre", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  return { ok: Boolean(res.ok), json };
}

/**
 * Ask GitHub for a device code. The code stays here. The address is the one GitHub gives, https only.
 * @param {string} clientId
 * @param {typeof fetch} fetch
 */
export async function requestDeviceCode(clientId, fetch) {
  if (!CLIENT_ID.test(clientId)) throw fail("bad_input", "GitHub sign-in is not set up on this computer.");
  let res;
  try { res = await post(fetch, DEVICE_URL, { client_id: clientId }); }
  catch { throw fail("unavailable", "GitHub did not answer. Try again in a minute."); }
  const json = res.json || {};
  const deviceCode = typeof json.device_code === "string" ? json.device_code : "";
  const userCode = typeof json.user_code === "string" ? json.user_code : "";
  const uri = typeof json.verification_uri === "string" ? json.verification_uri : "";
  if (!res.ok || !CODE.test(deviceCode)) throw fail("unavailable", "GitHub did not start a sign-in. Try again in a minute.");
  const expiresIn = Number.isFinite(json.expires_in) ? Math.min(Math.max(Number(json.expires_in), 30), 900) : 900;
  let url = "";
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.username && !parsed.password) {
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) && !parsed.search) parsed.searchParams.set("user_code", userCode);
      url = parsed.toString();
    }
  } catch { url = ""; }
  return { deviceCode, url, expiresIn };
}

/**
 * Exchange the login code, or a device code from start, and read the numeric account id.
 * A sign-in the person has not approved yet is `{ pending: "github.approve" }`. The token is revoked before this returns.
 * @param {{ clientId: string, clientSecret: string, redirect: string, code: string, deviceCode: string, fetch: typeof fetch }} o
 * @returns {Promise<{ id: string, login: string } | { pending: string }>}
 */
export async function githubAccount(o) {
  const code = String(o.code || "");
  const deviceCode = String(o.deviceCode || "");
  if (!CLIENT_ID.test(o.clientId)) throw fail("bad_input", "GitHub sign-in is not set up on this computer.");
  if (code && !CODE.test(code)) throw fail("bad_input", "That GitHub sign-in code cannot be used. Start again.");
  if (!code && !CODE.test(deviceCode)) throw fail("bad_input", "Start GitHub sign-in again.");
  /** @type {Record<string, string>} */
  const body = code
    ? { client_id: o.clientId, client_secret: o.clientSecret, code, ...(o.redirect ? { redirect_uri: o.redirect } : {}) }
    : { client_id: o.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" };
  if (code && !o.clientSecret) throw fail("bad_input", "GitHub sign-in is not set up on this computer.");
  let token = "";
  try {
    let exchanged;
    try { exchanged = await post(o.fetch, TOKEN_URL, body); }
    catch { throw fail("unavailable", "GitHub did not answer. Try again in a minute."); }
    const json = exchanged.json || {};
    const err = typeof json.error === "string" ? json.error : "";
    if (err === "authorization_pending" || err === "slow_down") return { pending: "github.approve" };
    if (err === "expired_token" || err === "bad_verification_code" || err === "access_denied") throw fail("bad_input", "That GitHub sign-in has run out. Start again.");
    token = typeof json.access_token === "string" ? json.access_token : "";
    if (!exchanged.ok || !token || err) throw fail("unavailable", "GitHub did not confirm this sign-in. Try again in a minute.");
    let userRes;
    try {
      userRes = await o.fetch(USER_URL, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "vyre", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw fail("unavailable", "GitHub did not answer. Try again in a minute."); }
    const user = await userRes.json().catch(() => null);
    const id = user && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : "";
    const login = user && typeof user.login === "string" ? user.login.trim() : "";
    if (!userRes.ok || !/^[0-9]{1,18}$/.test(id) || !LOGIN.test(login)) throw fail("unavailable", "GitHub did not say which account signed in.");
    return { id, login };
  } finally {
    if (token && o.clientSecret) await revoke(o.fetch, o.clientId, o.clientSecret, token);
  }
}

/** @param {typeof fetch} fetch @param {string} clientId @param {string} clientSecret @param {string} token */
async function revoke(fetch, clientId, clientSecret, token) {
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: { accept: "application/vnd.github+json", authorization: `Basic ${basic}`, "content-type": "application/json", "user-agent": "vyre" },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { /* the id is already read; a missed revoke does not keep the token here */ }
}
