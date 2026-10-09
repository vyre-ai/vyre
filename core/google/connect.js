// @ts-check
// connect: "Sign in with Google", the installed-app OAuth flow (ADR 0016 decision 6).
//
// A person names an OAuth client they keep in the vault (an env-set with client_id and
// client_secret), and Vyre opens Google's consent page for it. Google sends the browser back to a
// loopback address on this machine with a one-time code, which is exchanged for a refresh token.
// The refresh token goes straight into a new vault item the google module makes for itself, and
// the account is added. Nobody copies a token by hand, and no value ever reaches a result.
//
// Rules, and why:
// - The listener is on 127.0.0.1, port 0, and only while a sign-in is open. At idle nothing
//   listens. Each sign-in has one timer, its 10 minute expiry, cleared when it ends.
// - PKCE (S256) and a random state on every sign-in: a code is useless without the verifier, and a
//   callback whose state is not one we made is refused. States are compared in constant time, and
//   each works once.
// - A Deck on another device never reaches this loopback, so `finish` takes the address the
//   browser landed on, pasted, and ends the sign-in the same way.
// - Every error is scrubbed of every value a sign-in touched: the client secret, the code, the
//   verifier and every token. Log lines and events carry ids and names only.
// Everything this file needs from vyred comes in as a function, so it can be tested alone.

import crypto from "node:crypto";
import http from "node:http";
import { scrub, checkTokenUri } from "../../lib/connectors/auth.js";
import { SCOPE, SCOPES } from "./api.js";
import { NAME, EMAIL } from "./accounts.js";
import { newPrefixedId } from "../../lib/id.js";

export const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URI = "https://oauth2.googleapis.com/token";
export const EXPIRES_MS = 10 * 60_000;
export const CALLBACK = "/google/callback";
const TIMEOUT_MS = 30_000;
const MAX_ENDED = 200;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NO_REFRESH = "Google did not send a refresh token, which happens when this client was already allowed before. " +
  "Remove Vyre's access at myaccount.google.com/permissions and sign in again.";

/** Every scope a sign-in asks for: who signed in, and each scope the module uses. */
export const CONSENT_SCOPES = ["openid", "email", ...SCOPES.map(s => SCOPE + s)];

/**
 * @typedef {{ id: string, name: string, state: string, verifier: string, redirect: string, base?: string,
 *   client: { item: string, client_id: string, client_secret: string, token_uri: string },
 *   values: string[], timer: any }} Flow
 * @typedef {{
 *   fetchItem: (item: string, field: string) => Promise<string>,
 *   taken: (name: string) => boolean | Promise<boolean>,
 *   blocked?: (item: string) => Promise<string | null>,
 *   save: (item: string, fields: Record<string, string>) => Promise<void>,
 *   add: (account: { name: string, email: string, auth: { type: "oauth", item: string }, base?: string }) => Promise<void>,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, expiresMs?: number,
 * }} ConnectDeps
 */

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const hash = s => crypto.createHash("sha256").update(String(s)).digest();
const random = () => crypto.randomBytes(32).toString("base64url");

/** An https URI, or http on loopback for the test fakes, as auth.js demands of a token endpoint. */
function checkUri(uri, what, item) {
  try { return checkTokenUri(uri, `vault item ${item}`); } catch {
    throw fail(`vault item ${item} has a ${what} that is not an https address`, "config");
  }
}

/** The small page the browser shows after Google sends it back here. */
function page(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vyre</title>` +
    `<body style="font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem"><p>${esc}</p></body>`;
}

/** @param {ConnectDeps} deps */
export function connector(deps) {
  const log = deps.log || (() => {});
  const f = deps.fetch || globalThis.fetch;
  const expiresMs = deps.expiresMs || EXPIRES_MS;
  /** @type {Map<string, Flow>} */ const flows = new Map();
  /** How each recent sign-in ended, by id and by its state's hash, so a reuse gets a plain answer. */
  /** @type {Map<string, string>} */ const ended = new Map();
  /** @type {http.Server | null} */ let server = null;
  /** @type {Promise<number> | null} */ let opening = null;
  let port = 0;

  const end = (flow, why) => {
    clearTimeout(flow.timer);
    flows.delete(flow.id);
    for (const k of [flow.id, hash(flow.state).toString("hex")]) { ended.delete(k); ended.set(k, why); }
    while (ended.size > MAX_ENDED) ended.delete(ended.keys().next().value);
    if (!flows.size) close();
  };

  const endedText = why => ({
    used: "That sign-in was already used. Each one works once; start a new one in Vyre.",
    expired: "That sign-in expired (they last 10 minutes). Start a new one in Vyre.",
    cancelled: "That sign-in was cancelled. Start a new one in Vyre.",
  })[why] || "That sign-in has ended. Start a new one in Vyre.";

  function close() {
    if (!server) return;
    const s = server;
    server = null;
    port = 0;
    s.close();
    s.closeIdleConnections?.();
    log("google sign-in listener closed");
  }

  /** Open the loopback listener if it is not open, and give its port. */
  async function listen() {
    if (server) return port;
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { onRequest(req, res).catch(() => { if (!res.headersSent) answer(res, 500, "Something went wrong; go back to Vyre and try again."); }); });
      s.on("error", e => { if (!server) reject(e); else log("google sign-in listener failed", { error: String(/** @type {any} */ (e)?.code || "error") }); });
      s.listen(0, "127.0.0.1", () => {
        server = s;
        port = /** @type {import("node:net").AddressInfo} */ (s.address()).port;
        log("google sign-in listener open", { port });
        resolve(port);
      });
    });
    try { return await opening; } finally { opening = null; }
  }

  function answer(res, status, text) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff" });
    res.end(page(text));
  }

  async function onRequest(req, res) {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET" || u.pathname !== CALLBACK) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    const out = await land(u.searchParams, null);
    answer(res, out.ok ? 200 : 400, out.ok ? "You can close this tab and go back to Vyre." : out.error);
  }

  /** The open sign-in whose state this is, compared in constant time over every open one. */
  function byState(state) {
    const h = hash(state);
    let hit = null;
    for (const flow of flows.values()) if (crypto.timingSafeEqual(h, hash(flow.state))) hit = flow;
    return hit;
  }

  /**
   * A browser came back, to the loopback or pasted. `want` is the sign-in a paste names; the
   * state must be that one's. Resolves to { ok, ... } and never throws.
   * @param {URLSearchParams} q @param {Flow | null} want
   */
  async function land(q, want) {
    const state = q.get("state") || "";
    const flow = state ? byState(state) : null;
    if (!flow || (want && flow !== want)) {
      const why = state ? ended.get(hash(state).toString("hex")) : undefined;
      return { ok: false, error: why ? endedText(why) : "This address is not from a sign-in Vyre started. Start a new one in Vyre." };
    }
    end(flow, "used");
    const refusal = q.get("error");
    if (refusal) {
      const error = refusal === "access_denied" ? "Google sign-in was declined, so nothing was connected." : `Google refused the sign-in: ${refusal.slice(0, 80)}.`;
      return failed(flow, error);
    }
    const code = q.get("code");
    if (!code) return failed(flow, "Google sent no sign-in code. Start a new one in Vyre.");
    flow.values.push(code);
    try {
      return { ok: true, ...(await complete(flow, code)) };
    } catch (e) {
      return failed(flow, String(/** @type {any} */ (e)?.message || e));
    }
  }

  function failed(flow, error) {
    const clean = scrub(error, flow.values);
    deps.emit("google.connect-failed", { id: flow.id, error: clean });
    log("google sign-in failed", { id: flow.id, name: flow.name });
    return { ok: false, error: clean };
  }

  /** Exchange the code, keep the refresh token in a new vault item, and add the account. */
  async function complete(flow, code) {
    const c = flow.client;
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirect,
      client_id: c.client_id, client_secret: c.client_secret, code_verifier: flow.verifier });
    let res;
    try {
      res = await f(c.token_uri, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
    } catch (e) {
      throw fail(`Google's token endpoint ${/** @type {any} */ (e)?.name === "TimeoutError" ? "did not answer in 30 s" : "could not be reached"}.`, "network");
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    for (const k of ["access_token", "refresh_token", "id_token"]) if (typeof json?.[k] === "string") flow.values.push(json[k]);
    if (res.status >= 300 && res.status < 400) throw fail(`Google's token endpoint answered a redirect (${res.status}), which is refused.`, "refused");
    if (!res.ok) {
      const err = typeof json?.error === "string" ? json.error : "";
      // Scrubbed before it is cut, so a value cut in half cannot slip past the scrub.
      const desc = typeof json?.error_description === "string" ? ` (${scrub(json.error_description, flow.values).slice(0, 200)})` : "";
      const hint = err === "invalid_client" ? " Check the client ID and secret in the vault item." : err === "invalid_grant" ? " The sign-in code was refused; start a new sign-in." : "";
      throw fail(`Google refused the sign-in code: ${err || `status ${res.status}`}${desc}.${hint}`, "refused");
    }
    const refresh = json?.refresh_token;
    if (typeof refresh !== "string" || !refresh) throw fail(NO_REFRESH, "no_refresh_token");
    // The id_token came straight from the token endpoint over TLS, so its payload is read as is.
    let email = "";
    try { email = String(JSON.parse(Buffer.from(String(json.id_token).split(".")[1] || "", "base64url").toString("utf8")).email || ""); } catch {}
    if (!EMAIL.test(email)) throw fail("Google did not say which address signed in. Start a new sign-in and allow Vyre to see your email address.", "refused");
    if (await deps.taken(flow.name)) throw fail(`An account named ${flow.name} was added while you signed in; start again with another name.`, "exists");
    const item = `google-${flow.name}`;
    await deps.save(item, { client_id: c.client_id, client_secret: c.client_secret, refresh_token: refresh, token_uri: c.token_uri });
    await deps.add({ name: flow.name, email, auth: { type: "oauth", item }, ...(flow.base ? { base: flow.base } : {}) });
    deps.emit("google.connected", { id: flow.id, name: flow.name, email });
    log("google sign-in connected", { id: flow.id, name: flow.name });
    return { name: flow.name, email, item };
  }

  /** Run and scrub: every error leaves with no value any open sign-in holds. */
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (e) {
      const err = /** @type {any} */ (e);
      const values = [...flows.values()].flatMap(x => x.values);
      throw Object.assign(new Error(scrub(String(err?.message || err), values)), { code: typeof err?.code === "string" ? err.code : "failed" });
    }
  };

  return {
    /**
     * Start a sign-in: returns the consent page's address for the person to open.
     * @param {{ name: string, client: string, base?: string }} input
     */
    start: guarded(async ({ name, client, base }) => {
      if (!NAME.test(String(name || ""))) throw fail("name must be lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (!ITEM.test(String(client || ""))) throw fail("client must name a vault item: an env-set with client_id and client_secret");
      if (await deps.taken(name)) throw fail(`an account named ${name} is already connected; remove it first or choose another name`, "exists");
      if ([...flows.values()].some(x => x.name === name)) throw fail(`a sign-in for ${name} is already open; finish or cancel it first`, "exists");
      const why = deps.blocked ? await deps.blocked(`google-${name}`) : null;
      if (why) throw fail(why, "exists");
      const values = [];
      const read = async (field, optional) => {
        try {
          const v = await deps.fetchItem(client, field);
          if (typeof v === "string" && v) { values.push(v); return v; }
        } catch (e) {
          if (!optional) throw fail(`vault item ${client} could not be read (${field}): ${scrub(String(/** @type {any} */ (e)?.message || e), values)}. It needs \`vyre vault grant ${client} google\`.`, "vault");
        }
        if (!optional) throw fail(`vault item ${client} has no ${field}`, "vault");
        return "";
      };
      const client_id = await read("client_id", false);
      const client_secret = await read("client_secret", false);
      const auth_uri = checkUri((await read("auth_uri", true)) || AUTH_URI, "auth_uri", client);
      const token_uri = checkUri((await read("token_uri", true)) || TOKEN_URI, "token_uri", client);
      // Only the secret is a secret; the client ID and the endpoints are in the consent address.
      const kept = [client_secret];
      const p = await listen();
      const flow = /** @type {Flow} */ ({ id: newPrefixedId("gc"), name, state: random(), verifier: random(),
        redirect: `http://127.0.0.1:${p}${CALLBACK}`, ...(base ? { base } : {}),
        client: { item: client, client_id, client_secret, token_uri }, values: kept, timer: null });
      kept.push(flow.verifier);
      const challenge = crypto.createHash("sha256").update(flow.verifier).digest("base64url");
      const url = new URL(auth_uri);
      for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: flow.redirect, scope: CONSENT_SCOPES.join(" "),
        access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state: flow.state })) url.searchParams.set(k, v);
      flow.timer = setTimeout(() => {
        if (flows.get(flow.id) !== flow) return;
        end(flow, "expired");
        failed(flow, "The sign-in expired after 10 minutes. Start a new one in Vyre.");
      }, expiresMs);
      flow.timer.unref?.();
      flows.set(flow.id, flow);
      log("google sign-in started", { id: flow.id, name });
      return { id: flow.id, url: url.toString(), redirect: flow.redirect };
    }),

    /**
     * Finish a sign-in with the address the browser landed on, pasted from another device.
     * @param {{ id: string, url: string }} input
     */
    finish: guarded(async ({ id, url }) => {
      const flow = flows.get(String(id || ""));
      if (!flow) throw fail(ended.has(String(id)) ? endedText(ended.get(String(id))) : `no sign-in ${String(id).slice(0, 40)} is open`, "not_found");
      let u;
      try { u = new URL(String(url || "")); } catch { throw fail("paste the whole address from the browser's address bar, starting with http"); }
      const out = await land(u.searchParams, flow);
      if (!out.ok) throw fail(out.error, "refused");
      return { name: out.name, email: out.email, item: out.item };
    }),

    /** @param {{ id: string }} input */
    cancel: guarded(async ({ id }) => {
      const flow = flows.get(String(id || ""));
      if (!flow) throw fail(`no sign-in ${String(id).slice(0, 40)} is open`, "not_found");
      end(flow, "cancelled");
      failed(flow, "The sign-in was cancelled.");
      return { cancelled: true };
    }),

    /** The listener's port while it is open, else null. */
    port: () => (server ? port : null),

    /** Module stop: drop every open sign-in and close the listener. */
    stop() {
      for (const flow of [...flows.values()]) { clearTimeout(flow.timer); flows.delete(flow.id); }
      close();
    },
  };
}
