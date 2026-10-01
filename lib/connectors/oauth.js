// @ts-check
// A generic OAuth loopback+PKCE connect flow (0.2 plan: team/0.2/plans/vault.md, PLAN.md P5/P21).
// Generalizes core/google/connect.js's flow (state, PKCE, a loopback listener, a pasted-address
// finish for another device) so it is driven by whatever the target names, not Google's own
// constants: RFC 9728 protected-resource discovery, RFC 8414 authorization-server metadata, and
// RFC 7591 dynamic client registration when the target offers it. A caller with no
// registration_endpoint (Google, GitHub) instead supplies its own pre-registered client, the same
// vault item shape core/google/connect.js already reads (client_id, client_secret?).
//
// Rules, and why (unchanged from google/connect.js, which this supersedes as the shared engine):
// - The listener is on 127.0.0.1, port 0, and only while a sign-in is open. Each sign-in has one
//   timer, its expiry, cleared when it ends.
// - PKCE (S256) and a random state on every sign-in, compared in constant time; a callback whose
//   state is not one we made is refused, and each works once.
// - A Deck on another device never reaches this loopback, so `finish` takes the address the
//   browser landed on, pasted, and ends the sign-in the same way.
// - Every error is scrubbed of every value a sign-in touched. Log lines and events carry ids and
//   names only.
// - Token/issuer binding (PLAN.md P21): every token this mints is returned with the issuer and
//   resource it was minted for, and with the token endpoint that minted it. A caller stores that
//   alongside the token and refuses to use it anywhere else; this file does not itself decide
//   where a token may be spent, it only ever hands back what it minted it for.
// - This file has no ctx and knows nothing about the vault, the hub or google/; a caller decides
//   what "complete" means (save a vault item, add a hub row, wire a push connection).

import crypto from "node:crypto";
import http from "node:http";
import { scrub } from "./auth.js";

export const EXPIRES_MS = 10 * 60_000;
export const CALLBACK = "/connect/callback";
const TIMEOUT_MS = 30_000;
const MAX_ENDED = 200;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const hash = s => crypto.createHash("sha256").update(String(s)).digest();
const random = () => crypto.randomBytes(32).toString("base64url");
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** An https URI, or http on loopback for test fakes. @param {string} uri @param {string} what */
export function checkHttpsUri(uri, what) {
  let u;
  try { u = new URL(String(uri)); } catch { throw fail(`${what} is not a valid address`, "config"); }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) throw fail(`${what} must be https`, "config");
  return u.toString();
}

/** The small page the browser shows after the vendor sends it back here. */
function page(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vyre</title>` +
    `<body style="font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem"><p>${esc}</p></body>`;
}

// ---- discovery (RFC 9728, RFC 8414) and dynamic client registration (RFC 7591) ----

/**
 * RFC 9728: given the URL of the service itself (an MCP server, an API), find which
 * authorization server(s) protect it. Returns the first one named, or null if the target has no
 * protected-resource metadata (a vendor that expects a manually-named authorization server).
 * @param {string} resourceUrl @param {typeof fetch} f
 */
export async function discoverResource(resourceUrl, f = globalThis.fetch) {
  const u = new URL(resourceUrl);
  const paths = u.pathname && u.pathname !== "/"
    ? [`${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}`, `${u.origin}/.well-known/oauth-protected-resource`]
    : [`${u.origin}/.well-known/oauth-protected-resource`];
  for (const p of paths) {
    const doc = await tryFetchJson(p, f);
    if (doc && Array.isArray(doc.authorization_servers) && doc.authorization_servers.length) {
      // RFC 9728: the document must be about the service we asked. Vendors often name the origin, so
      // an equal address or a parent path on the same origin counts; another origin never does.
      if (doc.resource !== undefined) {
        let r;
        try { r = new URL(String(doc.resource)); } catch { throw fail(`${u.origin} names a resource that is not an address`, "resource_mismatch"); }
        const base = r.pathname.replace(/\/$/, "");
        if (r.origin !== u.origin || !(u.pathname.replace(/\/$/, "") + "/").startsWith(base + "/")) throw fail(`${u.origin} says its sign-in is for ${r.origin}${r.pathname}, not for ${u.origin}${u.pathname}; refused`, "resource_mismatch");
      }
      return { issuer: String(doc.authorization_servers[0]), resource: String(doc.resource || resourceUrl) };
    }
  }
  return null;
}

/**
 * RFC 8414 authorization-server metadata, falling back to OpenID's discovery document (many
 * authorization servers, Google included, publish that shape instead or as well).
 * @param {string} issuer @param {typeof fetch} f
 */
export async function discoverAuthServer(issuer, f = globalThis.fetch, { strict = false } = {}) {
  const iu = new URL(issuer);
  const path = iu.pathname.replace(/\/$/, "");
  const cands = [`${iu.origin}/.well-known/oauth-authorization-server${path}`, `${iu.origin}/.well-known/openid-configuration${path}`,
    `${iu.origin}${path}/.well-known/openid-configuration`];
  if (path) cands.push(`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`);
  for (const p of [...new Set(cands)]) {
    const doc = await tryFetchJson(p, f);
    if (doc && typeof doc.authorization_endpoint === "string" && typeof doc.token_endpoint === "string") {
      // RFC 8414 3.3: the document's issuer is the one it was fetched for, or it is not about this server.
      if (doc.issuer !== undefined && String(doc.issuer).replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw fail(`${iu.origin} published sign-in metadata for a different issuer (${String(doc.issuer).slice(0, 80)}); refused`, "issuer_mismatch");
      // Every address the vendor's own document names is checked before any code or secret goes to it.
      const ok = (uri, what) => { const c = checkHttpsUri(uri, what); if (strict && new URL(c).protocol !== "https:") throw fail(`${what} must be https`, "config"); return c; };
      return { issuer: String(doc.issuer || issuer), authorize_uri: ok(doc.authorization_endpoint, "the sign-in address"), token_uri: ok(doc.token_endpoint, "the token address"),
        registration_endpoint: typeof doc.registration_endpoint === "string" ? ok(doc.registration_endpoint, "the registration address") : null,
        scopes_supported: Array.isArray(doc.scopes_supported) ? doc.scopes_supported.filter(x => typeof x === "string") : [],
        token_auth_methods: Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported.filter(x => typeof x === "string") : [] };
    }
  }
  throw fail(`${iu.origin} does not publish authorization-server metadata (RFC 8414); its OAuth endpoints must be named directly`, "no_metadata");
}

async function tryFetchJson(url, f) {
  try {
    const res = await f(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * RFC 7591 dynamic client registration: the box registers itself as a public client, no person
 * ever sees a client_id and nothing here is verified by the vendor, because nothing was
 * registered ahead of time. @param {string} registrationEndpoint @param {string} redirectUri @param {typeof fetch} f
 */
export async function registerClient(registrationEndpoint, redirectUri, f = globalThis.fetch) {
  let res;
  try {
    res = await f(registrationEndpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  } catch (e) { throw fail(`could not reach ${new URL(registrationEndpoint).origin} to register: ${/** @type {any} */ (e)?.message || e}`, "network"); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json.client_id !== "string" || !json.client_id) throw fail(`dynamic client registration was refused (status ${res.status})`, "refused");
  return { client_id: json.client_id, client_secret: typeof json.client_secret === "string" ? json.client_secret : null };
}

// ---- the loopback connect flow ----

/**
 * @typedef {{ issuer: string, authorize_uri: string, token_uri: string, registration_endpoint?: string|null, scopes_supported?: string[], token_auth_methods?: string[] }} AuthServer
 * @typedef {{ access_token: string, refresh_token?: string, expires_in?: number, scope?: string,
 *   id_token?: string, issuer: string, resource?: string, token_uri: string, client_id: string, token_auth?: "basic", obtained_at: number }} TokenSet
 * @typedef {{ id: string, name: string, state: string, verifier: string, redirect: string, basic?: boolean,
 *   server: AuthServer, resource?: string, client: { client_id: string, client_secret: string|null },
 *   scopes: string[], values: string[], bind?: string[], timer: any }} Flow
 * @typedef {{
 *   fetchItem?: (item: string, field?: string) => Promise<string>,
 *   complete: (flow: Flow, tokens: TokenSet) => Promise<any> | any,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, expiresMs?: number,
 * }} ConnectDeps
 */

/**
 * @param {ConnectDeps} deps
 */
export function connector(deps) {
  const log = deps.log || (() => {});
  const f = deps.fetch || globalThis.fetch;
  const expiresMs = deps.expiresMs || EXPIRES_MS;
  /** @type {Map<string, Flow>} */ const flows = new Map();
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
    used: "That sign-in was already used. Each one works once; start a new one.",
    expired: "That sign-in expired (they last 10 minutes). Start a new one.",
    cancelled: "That sign-in was cancelled. Start a new one.",
  })[why] || "That sign-in has ended. Start a new one.";

  function close() {
    if (!server) return;
    const s = server;
    server = null;
    port = 0;
    s.close();
    s.closeIdleConnections?.();
    log("connect listener closed");
  }

  /** @param {number} [want] a fixed port for a vendor app whose redirect address was typed in ahead of time; 0 picks a free one */
  async function listen(want = 0) {
    if (server) {
      if (want && port !== want) throw fail(`another sign-in is using port ${port}; finish or cancel it first`, "exists");
      return port;
    }
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { onRequest(req, res).catch(() => { if (!res.headersSent) answer(res, 500, "Something went wrong; go back and try again."); }); });
      s.on("error", e => { if (!server) reject(e); else log("connect listener failed", { error: String(/** @type {any} */ (e)?.code || "error") }); });
      s.listen(want, "127.0.0.1", () => { server = s; port = /** @type {import("node:net").AddressInfo} */ (s.address()).port; log("connect listener open", { port }); resolve(port); });
    });
    try { return await opening; } finally { opening = null; }
  }

  function answer(res, status, text) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end(page(text));
  }

  async function onRequest(req, res) {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET" || u.pathname !== CALLBACK && u.pathname !== "/") { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    const out = await land(u.searchParams, null);
    answer(res, out.ok ? 200 : 400, out.ok ? "You can close this tab and go back to Vyre." : out.error);
  }

  function byState(state) {
    const h = hash(state);
    let hit = null;
    for (const flow of flows.values()) if (crypto.timingSafeEqual(h, hash(flow.state))) hit = flow;
    return hit;
  }

  /** @param {URLSearchParams} q @param {Flow | null} want */
  async function land(q, want) {
    const state = q.get("state") || "";
    const flow = state ? byState(state) : null;
    if (!flow || (want && flow !== want)) {
      const why = state ? ended.get(hash(state).toString("hex")) : undefined;
      return { ok: false, error: why ? endedText(why) : "This address is not from a sign-in Vyre started. Start a new one." };
    }
    end(flow, "used");
    const refusal = q.get("error");
    if (refusal) return failed(flow, refusal === "access_denied" ? "Sign-in was declined, so nothing was connected." : `Sign-in was refused: ${refusal.slice(0, 80)}.`);
    const code = q.get("code");
    if (!code) return failed(flow, "No sign-in code came back. Start a new one.");
    flow.values.push(code);
    try { return { ok: true, ...(await complete(flow, code)) }; }
    catch (e) { return failed(flow, String(/** @type {any} */ (e)?.message || e)); }
  }

  function failed(flow, error) {
    const clean = scrub(error, flow.values);
    deps.emit("connect.failed", { id: flow.id, name: flow.name, error: clean });
    log("connect sign-in failed", { id: flow.id, name: flow.name });
    return { ok: false, error: clean };
  }

  /** Exchange the code for a token set bound to its issuer and resource (P21), then hand it to the caller. */
  async function complete(flow, code) {
    const c = flow.client;
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirect, client_id: c.client_id, code_verifier: flow.verifier });
    // A vendor that takes the secret only in a Basic header (Zoom) gets it there and not in the body.
    if (c.client_secret && !flow.basic) body.set("client_secret", c.client_secret);
    if (flow.resource) body.set("resource", flow.resource);
    let res;
    try {
      res = await f(flow.server.token_uri, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json",
          ...(flow.basic && c.client_secret ? { authorization: "Basic " + Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64") } : {}) }, body: body.toString() });
    } catch (e) {
      throw fail(`the token endpoint ${/** @type {any} */ (e)?.name === "TimeoutError" ? "did not answer in 30 s" : "could not be reached"}.`, "network");
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    for (const k of ["access_token", "refresh_token", "id_token"]) if (typeof json?.[k] === "string") flow.values.push(json[k]);
    if (res.status >= 300 && res.status < 400) throw fail(`the token endpoint answered a redirect (${res.status}), which is refused.`, "refused");
    if (!res.ok) {
      const err = typeof json?.error === "string" ? json.error : "";
      const desc = typeof json?.error_description === "string" ? ` (${scrub(json.error_description, flow.values).slice(0, 200)})` : "";
      throw fail(`the sign-in was refused: ${err || `status ${res.status}`}${desc}.`, "refused");
    }
    if (typeof json?.access_token !== "string" || !json.access_token) throw fail("the token endpoint sent no access token.", "refused");
    /** @type {TokenSet} */
    const tokens = { access_token: json.access_token, ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
      ...(json.expires_in ? { expires_in: Number(json.expires_in) } : {}), ...(json.scope ? { scope: String(json.scope) } : {}),
      ...(json.id_token ? { id_token: json.id_token } : {}), issuer: flow.server.issuer, ...(flow.resource ? { resource: flow.resource } : flow.bind ? { resource: flow.bind.join(" ") } : {}),
      token_uri: flow.server.token_uri, client_id: c.client_id, ...(flow.basic ? { token_auth: "basic" } : {}), obtained_at: Date.now() };
    const out = await deps.complete(flow, tokens);
    deps.emit("connect.connected", { id: flow.id, name: flow.name, issuer: flow.server.issuer });
    log("connect sign-in connected", { id: flow.id, name: flow.name });
    return isObj(out) ? out : { name: flow.name };
  }

  const guarded = fn => async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      const err = /** @type {any} */ (e);
      const values = [...flows.values()].flatMap(x => x.values);
      throw Object.assign(new Error(scrub(String(err?.message || err), values)), { code: typeof err?.code === "string" ? err.code : "failed" });
    }
  };

  return {
    /**
     * Start a sign-in. Names the target either by `resource` (an MCP server or API url; RFC 9728
     * discovery finds its authorization server, and RFC 7591 registers a client automatically
     * when the server offers it) or by explicit `server` metadata (issuer/authorize_uri/token_uri,
     * for a vendor with no protected-resource document). Either way, when the target has no
     * registration_endpoint (or the caller passes `client` anyway), `client` names a vault item
     * with `client_id` and optionally `client_secret`, read through `fetchItem`.
     * `bind` names the resource url(s) the token is minted for when the vendor's authorize call
     * takes no `resource` parameter (Google): it is recorded on the token set (P21) and never sent.
     * @param {{ name: string, resource?: string, server?: Partial<AuthServer>, client?: string, scopes?: string[], bind?: string[], offline?: boolean, port?: number, pin?: string[],
     *   redirect?: { scheme?: "http" | "https", host?: string, path?: string }, basic?: boolean }} input
     */
    start: guarded(async ({ name, resource, server, client, scopes: asked = [], bind, offline, port: fixedPort, redirect: redirectSpec, basic, pin }) => {
      if (!NAME.test(String(name || ""))) throw fail("name must be lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (!Array.isArray(asked) || !asked.every(s => typeof s === "string" && s)) throw fail("scopes must be a list of strings");
      if (fixedPort !== undefined && !(Number.isInteger(fixedPort) && fixedPort >= 1024 && fixedPort <= 65535)) throw fail("port must be from 1024 to 65535");
      const scopes = [...asked];
      // Where the vendor sends the browser back. Loopback http on a free port by default; a vendor that
      // wants https (Slack) or `localhost` (Microsoft) says so, and an https address has no listener:
      // the browser cannot load it, and the person pastes the address it shows (finish).
      const rs = redirectSpec || {};
      const scheme = rs.scheme === "https" ? "https" : "http";
      const rhost = rs.host === "localhost" ? "localhost" : "127.0.0.1";
      const rpath = rs.path === "/" ? "/" : CALLBACK;
      if (scheme === "https" && !fixedPort) throw fail("an https redirect needs a fixed port, so the address can be typed into the vendor ahead of time", "config");
      const redirectFor = p => `${scheme}://${rhost}:${p}${rpath}`;
      if ([...flows.values()].some(x => x.name === name)) throw fail(`a sign-in for ${name} is already open; finish or cancel it first`, "exists");
      if (!resource && !(server && server.authorize_uri && server.token_uri)) throw fail("say either resource (a url to discover) or server (authorize_uri and token_uri)");

      /** @type {AuthServer} */
      let as;
      let discoveredResource = resource;
      if (server && server.authorize_uri && server.token_uri) {
        as = { issuer: server.issuer || new URL(server.token_uri).origin, authorize_uri: checkHttpsUri(server.authorize_uri, "server.authorize_uri"),
          token_uri: checkHttpsUri(server.token_uri, "server.token_uri"), registration_endpoint: server.registration_endpoint || null };
      } else {
        const found = await discoverResource(String(resource), f);
        const issuer = found ? found.issuer : String(resource);
        if (found) discoveredResource = found.resource;
        as = await discoverAuthServer(issuer, f, { strict: new URL(String(resource)).protocol === "https:" });
      }

      // The sign-in servers the catalog expects for this app. The vendor's own document chooses where the
      // code, and for an own-app sign-in the client secret, are sent, so anything else is refused.
      if (Array.isArray(pin) && pin.length) {
        for (const [what, uri] of [["issuer", as.issuer], ["sign-in address", as.authorize_uri], ["token address", as.token_uri], ["registration address", as.registration_endpoint]]) {
          if (!uri) continue;
          let o; try { o = new URL(uri).origin; } catch { o = ""; }
          if (!pin.includes(o)) throw fail(`the ${what} (${o.slice(0, 80)}) is not one of the servers this app signs in with; refused`, "unexpected_server");
        }
      }
      // A vendor that keeps refresh tokens behind offline_access gets it, but only if it says it knows it.
      if (offline && (as.scopes_supported || []).includes("offline_access") && !scopes.includes("offline_access")) scopes.push("offline_access");
      const values = [];
      let clientId, clientSecret = null;
      if (client) {
        if (!deps.fetchItem) throw fail("this connector has no fetchItem, so client cannot name a vault item", "config");
        const read = async (field, optional) => {
          try { const v = await deps.fetchItem(client, field); if (typeof v === "string" && v) { values.push(v); return v; } }
          catch (e) { if (!optional) throw fail(`vault item ${client} could not be read (${field}): ${scrub(String(/** @type {any} */ (e)?.message || e), values)}`, "vault"); }
          if (!optional) throw fail(`vault item ${client} has no ${field}`, "vault");
          return "";
        };
        clientId = await read("client_id", false);
        clientSecret = (await read("client_secret", true)) || null;
      } else if (as.registration_endpoint) {
        const p = scheme === "https" ? fixedPort : await listen(fixedPort);
        const redirect = redirectFor(p);
        const reg = await registerClient(as.registration_endpoint, redirect, f);
        clientId = reg.client_id;
        clientSecret = reg.client_secret;
      } else {
        throw fail(`${as.issuer} has no dynamic client registration; pass client naming a vault item with client_id (and client_secret if it needs one)`, "no_dcr");
      }
      if (clientSecret) values.push(clientSecret);

      const p = scheme === "https" ? fixedPort : await listen(fixedPort);
      const flow = /** @type {Flow} */ ({ id: `oa_${crypto.randomBytes(9).toString("base64url")}`, name, state: random(), verifier: random(),
        redirect: redirectFor(p), ...(basic || (as.token_auth_methods && as.token_auth_methods.length && !as.token_auth_methods.some(m => m !== "client_secret_basic")) ? { basic: true } : {}), server: as, ...(discoveredResource ? { resource: discoveredResource } : {}),
        client: { client_id: clientId, client_secret: clientSecret }, scopes, values, ...(Array.isArray(bind) && bind.length ? { bind: bind.map(String) } : {}), timer: null });
      values.push(flow.verifier);
      const challenge = crypto.createHash("sha256").update(flow.verifier).digest("base64url");
      const url = new URL(as.authorize_uri);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: flow.redirect, ...(scopes.length ? { scope: scopes.join(" ") } : {}),
        ...(offline ? { access_type: "offline", prompt: "consent" } : {}), code_challenge: challenge, code_challenge_method: "S256", state: flow.state, ...(discoveredResource ? { resource: discoveredResource } : {}) })) {
        url.searchParams.set(k, v);
      }
      flow.timer = setTimeout(() => { if (flows.get(flow.id) !== flow) return; end(flow, "expired"); failed(flow, "The sign-in expired after 10 minutes. Start a new one."); }, expiresMs);
      flow.timer.unref?.();
      flows.set(flow.id, flow);
      log("connect sign-in started", { id: flow.id, name, issuer: as.issuer });
      return { id: flow.id, url: url.toString(), redirect: flow.redirect, host: url.host };
    }),

    /** @param {{ id: string, url: string }} input */
    finish: guarded(async ({ id, url }) => {
      const flow = flows.get(String(id || ""));
      if (!flow) throw fail(ended.has(String(id)) ? endedText(ended.get(String(id))) : `no sign-in ${String(id).slice(0, 40)} is open`, "not_found");
      let u;
      try { u = new URL(String(url || "")); } catch { throw fail("paste the whole address from the browser's address bar, starting with http"); }
      const out = await land(u.searchParams, flow);
      if (!out.ok) throw fail(out.error, "refused");
      const { ok, ...rest } = out;
      return rest;
    }),

    /** @param {{ id: string }} input */
    cancel: guarded(async ({ id }) => {
      const flow = flows.get(String(id || ""));
      if (!flow) throw fail(`no sign-in ${String(id).slice(0, 40)} is open`, "not_found");
      end(flow, "cancelled");
      failed(flow, "The sign-in was cancelled.");
      return { cancelled: true };
    }),

    port: () => (server ? port : null),

    stop() {
      for (const flow of [...flows.values()]) { clearTimeout(flow.timer); flows.delete(flow.id); }
      close();
    },
  };
}
