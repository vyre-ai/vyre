// @ts-check
// connect: "Sign in with GitHub", the device flow (RFC 8628, ADR 0041 decision 2).
//
// A person opens a page and types a short code Vyre shows them; there is no redirect back to
// Vyre to catch (unlike Google's loopback, connect.js in ../google/), so Vyre polls GitHub on its
// own timer until the person finishes or the code expires. The device flow needs only the OAuth
// App's client id: no secret, no PKCE, no state to forge, since nothing calls back here.
//
// Rules, and why:
// - One poll timer per open sign-in, cleared the moment it ends (used, expired or cancelled).
//   Nothing polls once the sign-in is over, and at most one sign-in per account name at a time.
// - The token goes straight into a new vault item the module makes for itself, github-<name>, and
//   is never held anywhere else in this process once that write returns.
// - Every error is scrubbed of every value a sign-in touched: the token and anything GitHub sent
//   back with it. Log lines and events carry ids and names only.
// Everything this file needs from vyred comes in as a function, so it can be tested alone.

import crypto from "node:crypto";
import { scrub } from "../connectors/auth.js";

export const DEVICE_CODE_URI = "https://github.com/login/device/code";
export const TOKEN_URI = "https://github.com/login/oauth/access_token";
export const API = "https://api.github.com";
export const REVOKE_URI = client_id => `${API}/applications/${client_id}/token`;
/** Requested once, at sign-in: full read/write on every repo the account can reach (ADR 0041
 * decision 3 has no narrower device-flow option; 0.1.2's GitHub App is the real fix). */
export const SCOPE = "repo";
const TIMEOUT_MS = 15_000;
const MAX_ENDED = 200;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * @typedef {{ id: string, name: string, device_code: string, interval: number, expires: number,
 *   values: string[], timer: any, cancelled?: boolean }} Flow
 * @typedef {{
 *   taken: (name: string) => boolean | Promise<boolean>,
 *   blocked?: (item: string) => Promise<string | null>,
 *   save: (item: string, fields: Record<string, string>) => Promise<void>,
 *   add: (account: { name: string, login: string, avatar_url: string | null, item: string }) => Promise<void>,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, clientId?: string, minIntervalMs?: number,
 * }} ConnectDeps
 */

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
/** Like `Number(v) || dflt`, but a real 0 (a valid poll interval) is not treated as missing. */
const numOr = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };

/** @param {ConnectDeps} deps */
export function connector(deps) {
  const log = deps.log || (() => {});
  const f = deps.fetch || globalThis.fetch;
  const clientId = deps.clientId || "";
  const minInterval = deps.minIntervalMs || 4_000;
  if (!clientId) throw fail("connector needs a client id", "config");
  /** @type {Map<string, Flow>} */ const flows = new Map();
  /** How each recent sign-in ended, by id, so a stale id gets a plain answer instead of "no such sign-in". */
  /** @type {Map<string, string>} */ const ended = new Map();

  const endedText = why => ({
    used: "That sign-in was already used. Start a new one in Vyre.",
    expired: "That code expired. Start a new one in Vyre.",
    cancelled: "That sign-in was cancelled. Start a new one in Vyre.",
    declined: "That sign-in was declined, so nothing was connected. Start a new one in Vyre.",
  })[why] || "That sign-in has ended. Start a new one in Vyre.";

  function end(flow, why) {
    clearTimeout(flow.timer);
    flows.delete(flow.id);
    ended.set(flow.id, why);
    while (ended.size > MAX_ENDED) ended.delete(ended.keys().next().value);
  }

  function failed(flow, error) {
    const clean = scrub(error, flow.values);
    deps.emit("github.connect-failed", { id: flow.id, error: clean });
    log("github sign-in failed", { id: flow.id, name: flow.name });
    return { ok: false, error: clean };
  }

  /** Run and scrub: every error leaves with no value any open sign-in holds. */
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (e) {
      const err = /** @type {any} */ (e);
      const values = [...flows.values()].flatMap(x => x.values);
      throw Object.assign(new Error(scrub(String(err?.message || err), values)), { code: typeof err?.code === "string" ? err.code : "failed" });
    }
  };

  async function postForm(uri, body) {
    let res;
    try {
      res = await f(uri, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(body).toString() });
    } catch (e) {
      throw fail(`GitHub ${/** @type {any} */ (e)?.name === "TimeoutError" ? "did not answer in time" : "could not be reached"}.`, "network");
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { res, json };
  }

  /** One poll: pending keeps going, an answer ends the flow either way. Never throws. */
  async function poll(flow) {
    if (flows.get(flow.id) !== flow || flow.cancelled) return;
    if (Date.now() >= flow.expires) { end(flow, "expired"); failed(flow, "The code expired after its time was up."); return; }
    let json;
    try {
      ({ json } = await postForm(TOKEN_URI, { client_id: clientId, device_code: flow.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
    } catch (e) {
      // A network hiccup retries at the normal interval rather than ending the sign-in.
      schedule(flow, flow.interval);
      return;
    }
    const err = json && json.error;
    if (err === "authorization_pending") { schedule(flow, flow.interval); return; }
    if (err === "slow_down") { flow.interval = numOr(json.interval, flow.interval + 5); schedule(flow, flow.interval); return; }
    if (err === "expired_token") { end(flow, "expired"); failed(flow, "The code expired. Start a new one in Vyre."); return; }
    if (err === "access_denied") { end(flow, "declined"); failed(flow, "The sign-in was declined, so nothing was connected."); return; }
    if (err) { end(flow, "failed"); failed(flow, `GitHub refused the sign-in: ${String(err).slice(0, 80)}.`); return; }
    const token = json && json.access_token;
    if (typeof token !== "string" || !token) { end(flow, "failed"); failed(flow, "GitHub sent no token. Start a new one in Vyre."); return; }
    flow.values.push(token);
    try { await complete(flow, token); }
    catch (e) { end(flow, "failed"); failed(flow, String(/** @type {any} */ (e)?.message || e)); }
  }

  function schedule(flow, ms) {
    flow.timer = setTimeout(() => { poll(flow).catch(() => {}); }, Math.max(minInterval, ms * 1000));
    flow.timer.unref?.();
  }

  /** A token came back: who is it, save it, add the account. */
  async function complete(flow, token) {
    let res, json;
    try {
      res = await f(`${API}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      json = await res.json().catch(() => null);
    } catch (e) {
      throw fail(`Could not read the GitHub account that signed in: ${/** @type {any} */ (e)?.message || e}`, "network");
    }
    if (!res.ok || !json || !LOGIN.test(String(json.login || ""))) throw fail("GitHub did not say which account signed in.", "refused");
    const login = String(json.login);
    const avatar_url = typeof json.avatar_url === "string" ? json.avatar_url : null;
    if (await deps.taken(flow.name)) throw fail(`An account named ${flow.name} was added while you signed in; start again with another name.`, "exists");
    const item = `github-${flow.name}`;
    const why = deps.blocked ? await deps.blocked(item) : null;
    if (why) throw fail(why, "exists");
    await deps.save(item, { token });
    await deps.add({ name: flow.name, login, avatar_url, item });
    end(flow, "used");
    deps.emit("github.connected", { id: flow.id, name: flow.name, login });
    log("github sign-in connected", { id: flow.id, name: flow.name, login });
  }

  return {
    /**
     * Start a sign-in: returns the code and address for the person to open.
     * @param {{ name: string }} input
     */
    start: guarded(async ({ name }) => {
      if (!NAME.test(String(name || ""))) throw fail("name must be lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (await deps.taken(name)) throw fail(`an account named ${name} is already connected; remove it first or choose another name`, "exists");
      if ([...flows.values()].some(x => x.name === name)) throw fail(`a sign-in for ${name} is already open; finish or cancel it first`, "exists");
      const { res, json } = await postForm(DEVICE_CODE_URI, { client_id: clientId, scope: SCOPE });
      if (!res.ok || !json || !json.device_code) throw fail(`GitHub refused to start a sign-in (status ${res.status}).`, "refused");
      const id = `gh_${crypto.randomBytes(9).toString("base64url")}`;
      const flow = /** @type {Flow} */ ({ id, name, device_code: json.device_code, interval: numOr(json.interval, 5),
        expires: Date.now() + numOr(json.expires_in, 900) * 1000, values: [json.device_code], timer: null });
      flows.set(flow.id, flow);
      schedule(flow, flow.interval);
      log("github sign-in started", { id: flow.id, name });
      return { id: flow.id, user_code: String(json.user_code), verification_uri: String(json.verification_uri),
        verification_uri_complete: typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined,
        expires_in: numOr(json.expires_in, 900), interval: flow.interval };
    }),

    /** @param {{ id: string }} input */
    cancel: guarded(async ({ id }) => {
      const flow = flows.get(String(id || ""));
      if (!flow) throw fail(ended.has(String(id)) ? endedText(ended.get(String(id))) : `no sign-in ${String(id).slice(0, 40)} is open`, "not_found");
      flow.cancelled = true;
      end(flow, "cancelled");
      failed(flow, "The sign-in was cancelled.");
      return { cancelled: true };
    }),

    /** Whether a sign-in is open, for tests and for a status poll from the Deck. @param {string} id */
    status: id => (flows.has(id) ? "pending" : ended.has(id) ? ended.get(id) : "unknown"),

    /** Module stop: drop every open sign-in and its timer. */
    stop() {
      for (const flow of [...flows.values()]) { clearTimeout(flow.timer); flows.delete(flow.id); }
    },
  };
}

/**
 * Revoke a token at GitHub: the one call that reads the OAuth App's client secret. A failure
 * (unreachable, already revoked, wrong secret) is reported, never thrown past the caller's
 * control: `github.remove` removes the local account and item either way, so a person is never
 * stuck with a connected-looking account whose token doesn't work.
 * @param {{ clientId: string, clientSecret: string, token: string, fetch?: typeof fetch }} p
 */
export async function revoke({ clientId, clientSecret, token, fetch: f = globalThis.fetch }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  try {
    const res = await f(REVOKE_URI(clientId), { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Basic ${basic}`, "content-type": "application/json", accept: "application/vnd.github+json" },
      body: JSON.stringify({ access_token: token }) });
    // 204 No Content is success; GitHub answers 404 for an already-invalid token, which is also "gone".
    if (res.status === 204 || res.status === 404) return { revoked: true };
    return { revoked: false, error: `GitHub answered ${res.status} revoking the token.` };
  } catch (e) {
    return { revoked: false, error: scrub(String(/** @type {any} */ (e)?.message || e), [token, clientSecret]) };
  }
}
