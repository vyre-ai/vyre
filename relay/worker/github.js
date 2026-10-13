// @ts-check
// Sign in with GitHub (rc.4): GitHub proves WHO a person is and nothing else. It never opens a vault, and nothing here holds a key, a Secret Key or a recovery code.
//
//   GET  /v1/github/start?cc=&app=   the app opens this in the browser. cc = base64url(sha256(cv)), cv a secret the app keeps; app = one allowlisted origin, matched exactly.
//                                    Binds a `state` to this browser by a cookie, then redirects to GitHub (PKCE on the GitHub leg too, NO scope).
//   GET  /v1/github/callback         GitHub comes back here (the one redirect URI registered at GitHub). Checks state against the cookie, exchanges the code, reads /user
//                                    (numeric id, login, avatar), revokes the token at once and keeps nothing of it, then sends the browser to the app with a one-use
//                                    ticket in the URL FRAGMENT (never in a log).
//   POST /v1/github/me               {ticket, cv}: who GitHub says this is, and the Vyre name linked to that numeric id, if any. cv must match the cc the start gave.
//   POST /v1/github/link             {ticket, cv, name, eid, ts, sig}: link this GitHub id to the identity `name`. The request is signed by a device entry that is on the
//                                    identity's chain NOW (fetched from the directory and verified here), is not a newcomer, and names this ticket, this host and a time.
//   POST /v1/github/challenge        {name}: a one-use nonce (2 minutes) for the two calls below, so a signed request cannot be replayed.
//   POST /v1/github/account          {name, action: "status"|"unlink", nonce, eid, ts, sig}: the linked login and date, or remove the link. Signed like a link.
//
// A link is bound to the numeric GitHub id (a login can change) and to the identity id. One GitHub links one identity and one identity links one GitHub.
// Storage is one Durable Object (GithubLinks); a ticket is stored by its hash. The GitHub access token lives for the length of one callback, is revoked, and is never stored or logged.

import * as C from "../../kernel/identity/chain.js";
import { mac } from "../../escrow/worker/mac.js";

export const GH_TAG_LINK = "vyre-gh-link-v1";
export const GH_TAG_ACCOUNT = "vyre-gh-account-v1";
export const GH_LIMITS = Object.freeze({
  /** a start (state, cookie) lives this long */
  stateMs: 10 * 60_000,
  /** a ticket lives this long, single use for a link */
  ticketMs: 5 * 60_000,
  /** a challenge nonce */
  nonceMs: 2 * 60_000,
  /** how far a signed request's time may be from ours */
  skewMs: 2 * 60_000,
  /** per address, a minute */
  startPerMin: 10,
  callbackPerMin: 20,
  readPerMin: 30,
  writePerMin: 10,
  /** wrong verifiers or bad signatures per ticket before it is burnt */
  badPerTicket: 5,
  body: 4096,
});
export const DEFAULT_APP_ORIGINS = "https://app.vyre.run,https://web.vyre.run,vyreapp://box,https://vyreapp.localhost";
export const RETURN_PATH = "/github-return";
const COOKIE = "vyre_gh";
const enc = new TextEncoder();
const CC_RE = /^[A-Za-z0-9_-]{43}$/;
const CV_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const NAME_RE = /^[a-z][a-z0-9-]{2,19}$/;
const AVATAR_RE = /^https:\/\/avatars\.githubusercontent\.com\/[A-Za-z0-9/_.?=&%-]{1,200}$/;

const rand = (/** @type {number} */ n) => C.b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256b64 = async (/** @type {string} */ s) => C.b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const json = (/** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string,string>} */ headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const same = (/** @type {string} */ a, /** @type {string} */ b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const now = (/** @type {any} */ env) => (typeof env.NOW === "function" ? env.NOW() : Date.now());
const appOrigins = (/** @type {any} */ env) => String(env.APP_ORIGINS || DEFAULT_APP_ORIGINS).split(",").map(s => s.trim()).filter(Boolean);
const store = (/** @type {any} */ env) => env.GITHUB.get(env.GITHUB.idFromName("links"));
/** @param {any} env @param {object} body */
async function ask(env, body) { const r = await store(env).fetch("https://github/op", { method: "POST", body: JSON.stringify({ ...body, now: now(env) }) }); return /** @type {any} */ (await r.json()); }
/** One count in a window, in the object: false once `limit` is passed. @param {any} env @param {string} key @param {number} limit */
async function allowed(env, key, limit) { return (await ask(env, { op: "hit", key, limit, windowMs: 60_000 })).ok === true; }
/** A call to the escrow Worker: the relay's MAC over the body and the time, nothing else. The relay never holds what comes back except a public key and a one-use token. @param {any} env @param {string} op @param {object} body */
async function escrow(env, op, body) {
  if (!env.ESCROW_RELAY_SECRET) return { status: 503, body: null };
  const rest = { ...body, ts: now(env) };
  const f = typeof env.ESCROW_FETCH === "function" ? env.ESCROW_FETCH : globalThis.fetch.bind(globalThis);
  try {
    const r = await f(`${String(env.ESCROW_ORIGIN || "https://escrow.vyre.run").replace(/\/+$/, "")}/v1/escrow/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...rest, m: await mac(env.ESCROW_RELAY_SECRET, op, rest) }) });
    return { status: r.status, body: /** @type {any} */ (await r.json().catch(() => null)) };
  } catch { return { status: 502, body: null }; }
}
const who = (/** @type {Request} */ r) => r.headers.get("cf-connecting-ip") || "unknown";

/** CORS for the app's own origin only, matched exactly; a call with no Origin (a native client) needs none. @param {Request} request @param {any} env @param {Response} res */
function withCors(request, env, res) {
  const origin = request.headers.get("origin");
  const out = new Response(res.body, res);
  if (origin && appOrigins(env).includes(origin)) { out.headers.set("access-control-allow-origin", origin); out.headers.append("vary", "origin"); }
  return out;
}
const PREFLIGHT = { "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };

/** Read a small JSON object body, or null. @param {Request} request */
async function readBody(request) {
  const text = await request.text();
  if (text.length > GH_LIMITS.body) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** @param {string} app @param {string} frag */
const back = (app, frag) => new Response(null, { status: 302, headers: { location: `${app}${RETURN_PATH}#${frag}`, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": `${COOKIE}=; Max-Age=0; Path=/v1/github/callback; HttpOnly; Secure; SameSite=Lax` } });

/** The Worker's door for /v1/github/*. @param {Request} request @param {URL} url @param {any} env */
export async function onGithub(request, url, env) {
  if (!env.GITHUB) return json(404, { error: "this relay does not support sign-in with GitHub" });
  const path = url.pathname.slice("/v1/github".length);
  if (request.method === "OPTIONS") return withCors(request, env, new Response(null, { status: 204, headers: PREFLIGHT }));
  if (path === "/start" && request.method === "GET") return start(request, url, env);
  if (path === "/callback" && request.method === "GET") return callback(request, url, env);
  if (request.method !== "POST") return json(405, { error: "not a way in" });
  const origin = request.headers.get("origin");
  if (origin && !appOrigins(env).includes(origin)) return json(403, { error: "not from here" });
  const run = path === "/me" ? me : path === "/link" ? link : path === "/challenge" ? challenge : path === "/account" ? account : path === "/enter" ? enter : null;
  if (!run) return json(404, { error: "no such call" });
  return withCors(request, env, await run(request, url, env));
}

/** @param {Request} request @param {URL} url @param {any} env */
async function start(request, url, env) {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return json(503, { error: "sign-in with GitHub is not set up on this relay yet" });
  if (!(await allowed(env, `start:${who(request)}`, GH_LIMITS.startPerMin))) return json(429, { error: "too many tries; wait a minute" });
  const cc = url.searchParams.get("cc") || "", app = url.searchParams.get("app") || "";
  if (!CC_RE.test(cc)) return json(400, { error: "bad request" });
  if (!appOrigins(env).includes(app)) return json(400, { error: "that app is not one this relay sends people back to" });
  const sid = rand(24), gv = rand(32);
  await ask(env, { op: "state.put", sid, rec: { cc, app, gv }, exp: now(env) + GH_LIMITS.stateMs });
  const redirect = String(env.GITHUB_REDIRECT_URI || `${url.origin}/v1/github/callback`);
  const q = new URLSearchParams({ client_id: String(env.GITHUB_OAUTH_CLIENT_ID), redirect_uri: redirect, state: sid, code_challenge: await sha256b64(gv), code_challenge_method: "S256", allow_signup: "true" });
  // No `scope`: GET /user answers the numeric id, login and avatar for any token.
  return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?${q}`, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": `${COOKIE}=${sid}; Max-Age=${GH_LIMITS.stateMs / 1000}; Path=/v1/github/callback; HttpOnly; Secure; SameSite=Lax` } });
}

/** @param {Request} request @param {URL} url @param {any} env */
async function callback(request, url, env) {
  const bad = () => new Response("This sign-in link is not valid. Go back to Vyre and try again.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (!(await allowed(env, `cb:${who(request)}`, GH_LIMITS.callbackPerMin))) return json(429, { error: "too many tries; wait a minute" });
  const sid = url.searchParams.get("state") || "";
  const cookie = (request.headers.get("cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
  // The state must be the one THIS browser was given at /start: a callback opened from a link someone else started has no such cookie.
  if (!/^[A-Za-z0-9_-]{32}$/.test(sid) || !cookie || !same(cookie.slice(COOKIE.length + 1), sid)) return bad();
  const st = (await ask(env, { op: "state.take", sid })).rec;
  if (!st) return bad();
  const code = url.searchParams.get("code") || "";
  if (url.searchParams.get("error") || !code || code.length > 200) return back(st.app, "error=denied");
  const f = typeof env.GITHUB_FETCH === "function" ? env.GITHUB_FETCH : globalThis.fetch.bind(globalThis);
  const redirect = String(env.GITHUB_REDIRECT_URI || `${url.origin}/v1/github/callback`);
  /** @type {any} */ let user = null;
  try {
    let token = "";
    const tr = await f("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "vyre-relay" },
      body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: redirect, code_verifier: st.gv }) });
    const tj = /** @type {any} */ (await tr.json().catch(() => null));
    token = tj && typeof tj.access_token === "string" ? tj.access_token : "";
    if (!tr.ok || !token) return back(st.app, "error=failed");
    try {
      const ur = await f("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "vyre-relay", "x-github-api-version": "2022-11-28" } });
      user = ur.ok ? await ur.json().catch(() => null) : null;
    } finally {
      // The token has done its one job. Revoke it at GitHub and let it go out of scope: it is never stored, logged or returned.
      const basic = btoa(`${env.GITHUB_OAUTH_CLIENT_ID}:${env.GITHUB_OAUTH_CLIENT_SECRET}`);
      await f(`https://api.github.com/applications/${encodeURIComponent(String(env.GITHUB_OAUTH_CLIENT_ID))}/token`, { method: "DELETE", headers: { authorization: `Basic ${basic}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "vyre-relay" }, body: JSON.stringify({ access_token: token }) }).catch(() => {});
      token = "";
    }
  } catch { return back(st.app, "error=failed"); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== "string" || !user.login) return back(st.app, "error=failed");
  const ticket = rand(32);
  await ask(env, { op: "ticket.put", tid: await sha256b64(ticket), rec: { ghid: user.id, login: String(user.login).slice(0, 39), name: typeof user.name === "string" ? user.name.slice(0, 80) : null,
    avatarUrl: typeof user.avatar_url === "string" && AVATAR_RE.test(user.avatar_url) ? user.avatar_url : null,
    // GitHub tells the account's own two-factor setting only when it chooses to; unknown stays null, never a guess.
    twofa: typeof user.two_factor_authentication === "boolean" ? user.two_factor_authentication : null, cc: st.cc, bad: 0 }, exp: now(env) + GH_LIMITS.ticketMs });
  return back(st.app, `ticket=${ticket}`);
}

/** A ticket the caller holds the verifier for, or a refusal. Wrong verifiers burn the ticket after a few. @param {any} env @param {any} b @param {string} ip */
async function holding(env, b, ip) {
  if (!(await allowed(env, `read:${ip}`, GH_LIMITS.readPerMin))) return { res: json(429, { error: "too many tries; wait a minute" }) };
  const ticket = String(b.ticket || ""), cv = String(b.cv || "");
  if (!TICKET_RE.test(ticket) || !CV_RE.test(cv)) return { res: json(400, { error: "bad request" }) };
  const tid = await sha256b64(ticket);
  const rec = (await ask(env, { op: "ticket.get", tid })).rec;
  if (!rec) return { res: json(401, { error: "that sign-in has run out; start again" }) };
  if (!same(await sha256b64(cv), rec.cc)) { await ask(env, { op: "ticket.bad", tid, max: GH_LIMITS.badPerTicket }); return { res: json(401, { error: "that sign-in has run out; start again" }) }; }
  return { tid, rec };
}

/** @param {Request} request @param {URL} _url @param {any} env */
async function me(request, _url, env) {
  const b = await readBody(request);
  if (!b) return json(400, { error: "bad request" });
  const h = await holding(env, b, who(request));
  if (h.res) return h.res;
  const rec = h.rec;
  const l = (await ask(env, { op: "link.get", ghid: rec.ghid })).link;
  return json(200, { github: { id: rec.ghid, login: rec.login, name: rec.name, avatarUrl: rec.avatarUrl, twofa: rec.twofa }, linked: l ? { name: l.name, since: l.since } : null });
}

/** The identity chain at the directory, verified here, and the device entry that signed. Refuses a directory that does not answer or an answer that does not verify. @param {any} env @param {string} name @param {string} eid */
async function chainOf(env, name, eid) {
  if (!NAME_RE.test(name) || !C.EID_RE.test(eid)) return { code: 400, say: "bad request" };
  const f = typeof env.NAMES_FETCH === "function" ? env.NAMES_FETCH : globalThis.fetch.bind(globalThis);
  let data;
  try {
    const r = await f(`${String(env.NAMES_ORIGIN || "https://names.vyre.run").replace(/\/+$/, "")}/v1/ids/resolve?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" } });
    if (r.status === 404) return { code: 404, say: "no such name" };
    const j = /** @type {any} */ (await r.json());
    data = r.ok && j && j.data;
  } catch { return { code: 503, say: "the names directory did not answer; try again in a minute" }; }
  if (!data || data.kind !== "person" || !Array.isArray(data.ops)) return { code: 503, say: "the names directory did not answer; try again in a minute" };
  let state;
  try { state = await C.verifyChain(data.ops, { now: now(env) }); } catch { return { code: 503, say: "the names directory gave an answer that does not check out" }; }
  if (state.id !== data.id) return { code: 503, say: "the names directory gave an answer that does not check out" };
  const entry = state.entries.find(e => e.eid === eid);
  // A web-held key may not speak for the list, and a newcomer may not tie an outside account to it: only a device that has been on the list a day.
  if (!entry || entry.kind !== "device" || entry.held === "web" || !entry.pub || C.youngAt(entry, now(env))) return { code: 403, say: "this device cannot do that yet" };
  return { state, entry };
}

/** Is this signature the entry's over exactly this message, in time? @param {any} env @param {any} entry @param {number} ts @param {string} message @param {unknown} sig */
async function signedBy(env, entry, ts, message, sig) {
  if (!Number.isFinite(ts) || Math.abs(ts - now(env)) > GH_LIMITS.skewMs || typeof sig !== "string" || sig.length > 400) return false;
  try { return await C.verifyWith(/** @type {string} */ (entry.pub), enc.encode(message), sig, entry); } catch { return false; }
}

/** @param {Request} request @param {URL} url @param {any} env */
async function link(request, url, env) {
  const b = await readBody(request);
  if (!b) return json(400, { error: "bad request" });
  if (!(await allowed(env, `write:${who(request)}`, GH_LIMITS.writePerMin))) return json(429, { error: "too many tries; wait a minute" });
  const h = await holding(env, b, who(request));
  if (h.res) return h.res;
  const name = String(b.name || ""), eid = String(b.eid || "");
  const c = await chainOf(env, name, eid);
  if (!c.state) return json(c.code, { error: c.say });
  const msg = `${GH_TAG_LINK}\n${h.rec.ghid}\n${c.state.id}\n${h.tid}\n${Number(b.ts)}\n${url.host}`;
  if (!(await signedBy(env, c.entry, Number(b.ts), msg, b.sig))) { await ask(env, { op: "ticket.bad", tid: h.tid, max: GH_LIMITS.badPerTicket }); return json(401, { error: "that request was not signed by a device of this identity" }); }
  const taken = await ask(env, { op: "ticket.take", tid: h.tid });
  if (!taken.rec) return json(401, { error: "that sign-in has run out; start again" });
  const put = await ask(env, { op: "link.put", link: { ghid: h.rec.ghid, login: h.rec.login, identity: c.state.id, name, since: now(env) } });
  if (!put.ok) return json(409, { error: put.code === "identity_linked" ? "this identity already has a GitHub linked; unlink it first" : "this GitHub account is already linked to another identity" });
  // The escrow makes a new key pair for this link. The device adds its public half to the list as the relay's entry, then sends the escrow its bundle with the token.
  const made = await escrow(env, "create", { ghid: h.rec.ghid, identity: c.state.id, name });
  if (made.status !== 200 || !made.body) { await ask(env, { op: "link.del", identity: c.state.id }); return json(502, { error: "the escrow did not answer; nothing was linked" }); }
  return json(200, { ok: true, github: { login: h.rec.login }, since: now(env), relay: { pub: made.body.pub, eid: made.body.eid }, escrow: { token: made.body.token, origin: String(env.ESCROW_ORIGIN || "https://escrow.vyre.run") } });
}

/** @param {Request} request @param {URL} _url @param {any} env */
async function challenge(request, _url, env) {
  const b = await readBody(request);
  if (!b || !NAME_RE.test(String(b.name || ""))) return json(400, { error: "bad request" });
  if (!(await allowed(env, `read:${who(request)}`, GH_LIMITS.readPerMin))) return json(429, { error: "too many tries; wait a minute" });
  const nonce = rand(16);
  await ask(env, { op: "nonce.put", nonce, name: String(b.name), exp: now(env) + GH_LIMITS.nonceMs });
  return json(200, { nonce, exp: now(env) + GH_LIMITS.nonceMs });
}

/** @param {Request} request @param {URL} url @param {any} env */
async function account(request, url, env) {
  const b = await readBody(request);
  if (!b) return json(400, { error: "bad request" });
  if (!(await allowed(env, `write:${who(request)}`, GH_LIMITS.writePerMin))) return json(429, { error: "too many tries; wait a minute" });
  const name = String(b.name || ""), eid = String(b.eid || ""), action = String(b.action || ""), nonce = String(b.nonce || "");
  if (!["status", "unlink", "refresh"].includes(action) || !NONCE_RE.test(nonce)) return json(400, { error: "bad request" });
  const c = await chainOf(env, name, eid);
  if (!c.state) return json(c.code, { error: c.say });
  const msg = `${GH_TAG_ACCOUNT}\n${action}\n${c.state.id}\n${nonce}\n${Number(b.ts)}\n${url.host}`;
  if (!(await signedBy(env, c.entry, Number(b.ts), msg, b.sig))) return json(401, { error: "that request was not signed by a device of this identity" });
  // The nonce is spent only by a request that was signed, so a stranger cannot burn a person's challenge.
  if (!(await ask(env, { op: "nonce.take", nonce, name })).ok) return json(401, { error: "that request has run out; ask again" });
  if (action === "status") {
    const l = (await ask(env, { op: "link.byIdentity", identity: c.state.id })).link;
    return json(200, { linked: l ? { login: l.login, since: l.since } : null });
  }
  const l = (await ask(env, { op: "link.byIdentity", identity: c.state.id })).link;
  if (action === "refresh") {
    const g = (await ask(env, { op: "link.byIdentity", identity: c.state.id })).link;
    if (!g) return json(404, { error: "no GitHub is linked" });
    const t = await escrow(env, "token", { ghid: g.ghid, identity: c.state.id });
    return t.status === 200 && t.body ? json(200, { escrow: { token: t.body.token, origin: String(env.ESCROW_ORIGIN || "https://escrow.vyre.run") } }) : json(502, { error: "the escrow did not answer" });
  }
  await ask(env, { op: "link.del", identity: c.state.id });
  // The escrow purges the sealed key and the relay's key. The person's device removes the relay's entry from the list in its own signed op.
  if (l) await escrow(env, "delete", { ghid: l.ghid, identity: c.state.id });
  return json(200, { ok: true });
}

/** A new device after GitHub sign-in: the escrow adds it to the identity's list as a limited device and answers the Secret Key and home hint sealed to that device's agreement key. @param {Request} request @param {URL} _url @param {any} env */
async function enter(request, _url, env) {
  const b = await readBody(request);
  if (!b) return json(400, { error: "bad request" });
  const h = await holding(env, b, who(request));
  if (h.res) return h.res;
  const l = (await ask(env, { op: "link.get", ghid: h.rec.ghid })).link;
  if (!l) return json(404, { linked: false });
  const d = b.device;
  if (!d || typeof d !== "object") return json(400, { error: "bad request" });
  const r = await escrow(env, "release", { ghid: h.rec.ghid, device: { eid: String(d.eid || ""), pub: String(d.pub || ""), agree: String(d.agree || "") } });
  if (r.status !== 200 || !r.body) return json(r.status === 429 ? 429 : r.status === 503 || r.status === 502 ? 503 : 409, { error: r.body && r.body.error ? r.body.error : "could not sign in with GitHub" });
  await ask(env, { op: "ticket.take", tid: h.tid });
  return json(200, { name: l.name, sealed: r.body.sealed, lastRelease: r.body.lastRelease });
}

/**
 * The one object behind sign-in with GitHub: starts, tickets, nonces, links and request counts, each with its own expiry, checked lazily and swept by an alarm.
 * One object (not one per key) so a link is claimed from both sides at once and a ticket is spent once. Links are rare writes; nothing here is a hot path.
 */
export class GithubLinks {
  /** @param {any} ctx */
  constructor(ctx) { this.ctx = ctx; }

  async alarm() {
    const t = Date.now();
    for (const prefix of ["s/", "t/", "n/", "h/"]) {
      const all = await this.ctx.storage.list({ prefix });
      const dead = [...all].filter(([, v]) => v && typeof v.exp === "number" && v.exp <= t).map(([k]) => k);
      if (dead.length) await this.ctx.storage.delete(dead.slice(0, 128));
    }
  }

  /** @param {Request} request */
  async fetch(request) {
    const b = /** @type {any} */ (await request.json());
    const s = this.ctx.storage, now = Number(b.now);
    const live = async (/** @type {string} */ k) => { const v = await s.get(k); return v && v.exp > now ? v : null; };
    const sweep = async (/** @type {number} */ exp) => { const cur = await s.getAlarm(); if (!cur) await s.setAlarm(Math.max(Date.now(), exp) + 60_000); };
    switch (b.op) {
      case "state.put": await s.put(`s/${b.sid}`, { ...b.rec, exp: b.exp }); await sweep(b.exp); return out({});
      case "state.take": { const v = await live(`s/${b.sid}`); await s.delete(`s/${b.sid}`); return out({ rec: v || null }); }
      case "ticket.put": await s.put(`t/${b.tid}`, { ...b.rec, exp: b.exp }); await sweep(b.exp); return out({});
      case "ticket.get": return out({ rec: await live(`t/${b.tid}`) });
      case "ticket.take": { const v = await live(`t/${b.tid}`); await s.delete(`t/${b.tid}`); return out({ rec: v || null }); }
      case "ticket.bad": { const v = await live(`t/${b.tid}`); if (!v) return out({}); if (v.bad + 1 >= b.max) await s.delete(`t/${b.tid}`); else await s.put(`t/${b.tid}`, { ...v, bad: v.bad + 1 }); return out({}); }
      case "nonce.put": await s.put(`n/${b.nonce}`, { name: b.name, exp: b.exp }); await sweep(b.exp); return out({});
      case "nonce.take": { const v = await live(`n/${b.nonce}`); if (!v || v.name !== b.name) return out({ ok: false }); await s.delete(`n/${b.nonce}`); return out({ ok: true }); }
      case "hit": {
        const k = `h/${b.key}`, v = await live(k), n = (v ? v.n : 0) + 1;
        await s.put(k, { n, exp: v ? v.exp : now + b.windowMs }); await sweep(now + b.windowMs);
        return out({ ok: n <= b.limit });
      }
      case "link.get": return out({ link: (await s.get(`l/g/${b.ghid}`)) || null });
      case "link.byIdentity": { const g = await s.get(`l/i/${b.identity}`); return out({ link: g ? (await s.get(`l/g/${g}`)) || null : null }); }
      case "link.put": {
        const l = b.link;
        if (await s.get(`l/i/${l.identity}`)) return out({ ok: false, code: "identity_linked" });
        if (await s.get(`l/g/${l.ghid}`)) return out({ ok: false, code: "github_linked" });
        await s.put({ [`l/g/${l.ghid}`]: l, [`l/i/${l.identity}`]: l.ghid });
        return out({ ok: true });
      }
      case "link.del": { const g = await s.get(`l/i/${b.identity}`); if (g) await s.delete([`l/g/${g}`, `l/i/${b.identity}`]); return out({ ok: Boolean(g) }); }
      default: return new Response(null, { status: 400 });
    }
  }
}
const out = (/** @type {object} */ v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
