// @ts-check
// vault.request: one HTTP call to a vendor API with an `api-credential` (0.2 plan "Vault-routed
// API access", PLAN.md P5, P17). The credential is used only here, in-process: its key never
// reaches a caller, a header a caller can read, a log, an event or a response. What the call may
// reach and what it may do is decided by api-request.js (hosts, presets, the SSRF guard); what
// this file adds is the path a call takes:
//
//   check     the url against the credential's hosts, then the address it resolves to (stricter
//             than the MCP hub's check: public addresses only), pinned for the connection
//   classify  read, send, spend or delete, from the credential's endpoints and the presets
//   read      runs at once (a watcher may run only these)
//   outward   matched against what the person said (said.js): a match runs at once, no prompt;
//             no match is held at the Gate as one `vault-api` item with a card Vyre builds from
//             parsed fields, and approving it runs exactly that request, re-checked
//   response  scrubbed of every value the credential touched, and cut to the size an MCP result gets
//
// Rules, and why:
// - A caller cannot choose its own authentication: no Authorization, Cookie or Host header, and a
//   DWD subject is fixed on the credential. The credential's secret is fetched inside execute()
//   and lives only in that frame and the scrub list.
// - Every hop is checked as the first was, at connect time. A redirect is followed only for a
//   read and only on the same host; a redirect to another host, or on a write, is refused, so the
//   Authorization header never travels anywhere the credential did not name.
// - An approval binds to a hash of the method, url, headers and body the person saw. What runs
//   is rebuilt from the Gate's own record and must hash to that value, so an edit, a swapped row
//   or a changed credential is refused rather than sent.
// - Audit rows (action api-request) name the credential and the host, never a value, a body or
//   a query.
// The network and DNS are injected (deps.transport, deps.lookup) so tests never reach out; the
// production defaults are the strict ones, and no seam turns a check off.

import crypto from "node:crypto";
import { agentClaim } from "../modules/index.js";
import https from "node:https";
import http from "node:http";
import { forwardFile, sendFile } from "./forward-file.js";
import { registerService } from "./service.js";
import { defaultField } from "../../lib/vault-kinds/kinds.js";
import { buildRequest } from "../../records/connectors/format.js";
import { rowMac, same } from "./crypto.js";
import {
  checkTarget, classify, presetFor, presetRead, parseFields, summarize, approvalHash, checkHeaders, checkQuery, buildUrl, pinnedOptions,
  readerMayRead, scopeAllows,
} from "./api-request.js";

const GATE_SENDER = "vault-api";
const GATE_KINDS = { send: "send", spend: "spend", delete: "delete" };
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const MAX_BODY = 1_000_000;
const MAX_RESPONSE = 2_000_000;
/** The same cut a model's MCP result gets (core/mcp/hub.js MAX_RESULT). */
export const MAX_RESULT = 256 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_HOPS = 5;
/** Longest a call waits for a rate allowance, and the longest Retry-After it will honour by waiting (a longer one comes back to the caller, who knows better what to do). */
const MAX_WAIT_MS = 30_000, MAX_RETRY_AFTER_MS = 30_000, MAX_429_RETRIES = 2;
const EARLY_MS = 60_000;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CONCEALED = "<concealed by vyre>";
/** Response headers worth handing back. Never a cookie, never anything that authenticates. */
const KEEP_HEADERS = ["content-type", "content-length", "etag", "last-modified", "retry-after", "x-request-id", "request-id", "x-ms-request-id", "x-goog-request-id", "ratelimit-remaining"];

/**
 * The request headers a lent computer's program may send through the home. An allow-list, not a pattern (reviewer-2 FW-1): a small safe default (content negotiation, validators), plus
 * exactly the names the ROUTE's own record lists (`allow_headers`, set at the home, never by the program). Every other header, every `x-` header that is not named, is dropped. Some are
 * dropped even when a route names them, because they change what the vendor does with the request or who it thinks sent it: authorization, cookies, host, the forwarding and rewrite families
 * (x-forwarded-*, x-real-ip, x-original-url, x-rewrite-url, x-host), method overrides (x-http-method*, x-method-override), proxy and sec- headers, and the credential-carrying `x-*` names.
 * @param {any} h the program's headers @param {string[]} [named] the route's own exact names
 */
const FORWARD_DEFAULT = new Set(["accept", "accept-language", "content-type", "content-language", "if-match", "if-none-match"]);
const FORWARD_NEVER = /^(authorization|proxy-authorization|cookie|set-cookie|host|connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|expect|forwarded|via|origin|referer|sec-.*|proxy-.*|x-forwarded-.*|x-real-ip|x-client-ip|x-cluster-client-ip|true-client-ip|x-original-url|x-original-uri|x-rewrite-url|x-host|x-http-method.*|x-method-override|x-vyre-.*|x-api-key|x-auth.*|x-token.*|x-access-token.*|x-oauth.*|x-session.*|x-goog-api-key|x-csrf.*|x-xsrf.*|x-goog-iam-.*|x-goog-authenticated-user.*|x-amz-security-token|x-amz-.*authorization.*|x-ms-authorization.*|.*authorization.*)$/;
export function forwardHeaders(h, named = []) {
  if (!isObj(h)) return {};
  const ok = new Set([...FORWARD_DEFAULT, ...(Array.isArray(named) ? named.map(x => String(x).toLowerCase()).filter(x => /^[a-z0-9-]{1,64}$/.test(x)) : [])]);
  const out = {};
  for (const [k, v] of Object.entries(h)) { const n = k.toLowerCase(); if (ok.has(n) && !FORWARD_NEVER.test(n) && typeof v === "string") out[n] = v; }
  return out;
}

const strs = { type: "array", items: { type: "string" } };
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = v => typeof v === "string";
const bad = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const printable = (s, n) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const b64url = s => Buffer.from(s).toString("base64url");

// ---- scrubbing (the connectors' own copy: modules never import each other's files) ----

/** @param {unknown} text @param {string[]} values */
export function scrub(text, values) {
  let out = String(text ?? "");
  const forms = new Set();
  for (const v of values) {
    if (!isStr(v) || v.length < 4) continue;
    const b = Buffer.from(v, "utf8");
    for (const f of [v, b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(v),
      encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1)]) if (f.length >= 4) forms.add(f);
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(CONCEALED);
  return out;
}

/** Every string inside a JSON-able value, keys included; walks the value so a PEM key with newlines still matches. */
function scrubAll(v, values) {
  const walk = x => {
    if (isStr(x)) return scrub(x, values);
    if (Array.isArray(x)) return x.map(walk);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, val]) => [scrub(k, values), walk(val)]));
    return x;
  };
  return walk(v);
}

/** A secret and, for a PEM key, its body lines, so a partial leak is caught too. */
function forms(v) {
  if (!isStr(v) || v.length < 4) return [];
  return v.includes("-----BEGIN") ? [v, ...v.split(/\r?\n/).filter(l => l.length >= 16 && !l.startsWith("-----"))] : [v];
}

// ---- the production transport: one https request to an address already validated ----

/**
 * @typedef {{ url: URL, address: string, method: string, headers: Record<string, string>, body?: string, timeoutMs?: number, maxBytes?: number }} Send
 * @typedef {{ status: number, headers: Record<string, string>, body: Buffer, truncated?: boolean }} Reply
 */

/**
 * Connect to `address` (never the name), with the url's host as Host and TLS server name, and read
 * at most maxBytes back. No redirect is followed here; execute() decides.
 * @param {Send} s @returns {Promise<Reply>}
 */
export function httpsTransport({ url, address, method, headers, body, timeoutMs = TIMEOUT_MS, maxBytes = MAX_RESPONSE }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    // The one plain-http target there is: an app module's API on this machine (appTarget), never a name, only 127.0.0.1. Everything else is https to a checked, pinned address.
    if (url.protocol === "http:" && address !== "127.0.0.1") return reject(new Error("plain http is only for an app on this machine"));
    const opts = url.protocol === "http:"
      ? { protocol: "http:", hostname: "127.0.0.1", port: Number(url.port), path: url.pathname + url.search, method, headers: { ...h, host: url.host }, agent: false, timeout: timeoutMs }
      : pinnedOptions(url, address, { method, headers: h, timeout: timeoutMs });
    const req = (url.protocol === "http:" ? http : https).request(opts, res => {
      /** @type {Buffer[]} */ const chunks = [];
      let n = 0, truncated = false, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const heads = {};
        for (const [k, v] of Object.entries(res.headers)) heads[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        resolve({ status: res.statusCode || 0, headers: heads, body: Buffer.concat(chunks), ...(truncated ? { truncated: true } : {}) });
      };
      res.on("data", c => {
        if (truncated) return;
        n += c.length;
        if (n > maxBytes) { chunks.push(c.subarray(0, c.length - (n - maxBytes))); truncated = true; res.destroy(); }
        else chunks.push(c);
      });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", e => { if (truncated) finish(); else if (!done) { done = true; reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("the API did not answer in time")));
    req.on("error", e => reject(e));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * @typedef {{ lookup?: (hostname: string) => Promise<{ address: string, family: number }[]>, transport?: (s: Send) => Promise<Reply>,
 *   call?: (tool: string, input: any) => Promise<any>, said?: { match: (call: any, where?: any) => Promise<{ id: string } | null> },
 *   now?: () => number, log?: (m: string) => void }} RequestDeps
 */

export class ApiRequests {
  /** @param {import("./vault.js").Vault} vault @param {RequestDeps} [deps] */
  constructor(vault, deps = {}) {
    this.vault = vault;
    this.deps = deps;
    this.transport = deps.transport || httpsTransport;
    this.now = deps.now || Date.now;
    /** Minted access tokens, in memory only. @type {Map<string, { token: string, expires: number }>} */
    this.tokens = new Map();
    /** One refresh in flight per oauth credential. @type {Map<string, Promise<string>>} */
    this.refreshing = new Map();
    this.stopped = false;
    /** @type {Set<any>} */
    this.timers = new Set();
    this.sleep = deps.sleep || (ms => new Promise(r => { const t = setTimeout(r, ms); if (typeof t.unref === "function") t.unref(); }));
    /** Per credential: the times of its requests in the last minute, and a cooldown the provider's own "too many requests" set. The limit is the Space's: every caller shares it. @type {Map<string, { times: number[], until: number }>} */
    this.rates = new Map();
  }

  /**
   * Wait for this credential's allowance (its `rate.per_minute`, if it has one, and any cooldown a "too many requests" answer set), up to MAX_WAIT_MS; beyond that the call is refused
   * with `rate_limited` and the seconds to wait, never left hanging. Counts one request when it returns.
   * @param {{ name: string, config: any }} plan
   */
  async throttle(plan) {
    const per = plan.config.rate?.per_minute, st = this.rates.get(plan.name) ?? (this.rates.set(plan.name, { times: [], until: 0 }), /** @type {any} */ (this.rates.get(plan.name)));
    const start = this.now();
    for (;;) {
      const t = this.now(); st.times = st.times.filter(x => t - x < 60_000);
      const wait = Math.max(st.until - t, per && st.times.length >= per ? st.times[0] + 60_000 - t : 0);
      if (wait <= 0) break;
      if (t - start + wait > MAX_WAIT_MS) throw Object.assign(bad(`${plan.name} is at its limit of ${per ?? "the provider's"} requests a minute; try again in ${Math.ceil(wait / 1000)} s`, "rate_limited"), { retryAfter: Math.ceil(wait / 1000) });
      await this.sleep(Math.min(wait, MAX_WAIT_MS));
    }
    st.times.push(this.now());
  }
  /** The provider said "too many requests": hold every caller of this credential for as long as its Retry-After says (seconds or a date). @returns {number} ms, 0 when it names none we may honour */
  coolDown(name, reply) {
    const h = String(reply.headers["retry-after"] ?? ""), ms = /^\d+$/.test(h) ? Number(h) * 1000 : Date.parse(h) - this.now();
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_RETRY_AFTER_MS) return 0;
    const st = this.rates.get(name) ?? (this.rates.set(name, { times: [], until: 0 }), /** @type {any} */ (this.rates.get(name)));
    st.until = Math.max(st.until, this.now() + ms); return ms;
  }

  // ---- building the plan: everything a decision needs, from the request alone ----

  /**
   * An app module's API on this machine, for a Connection with `app`. The address a caller gives is the sentinel one (<app>.app.invalid), checked like any other address for its shape; the real
   * origin is the app's own to say, and only while it runs (`appmods.origin`), and is taken only if it is exactly http://127.0.0.1:<port> with a port from 1024: nothing else is ever reached, and a
   * name an app module gives that is anything but that is refused here.
   * @param {any} config @param {string} rawUrl @returns {Promise<{ url: URL, addresses: string[], display: URL }>}
   */
  async appTarget(config, rawUrl) {
    const sentinel = `${config.app}.app.invalid`;
    const shaped = await checkTarget(rawUrl, [sentinel], { lookup: async () => [{ address: "203.0.113.1", family: 4 }] });
    if (!this.deps.call) throw bad("the apps are not running, so an app's connection has nowhere to go", "unavailable");
    const r = await this.deps.call("appmods.origin", { name: config.app });
    const origin = r && r.data && typeof r.data.origin === "string" ? r.data.origin : "";
    if (!origin) throw bad("the app is not running", "unavailable");
    const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(origin);
    if (!m || Number(m[1]) < 1024 || Number(m[1]) > 65535) throw bad("the app named an address this machine will not send a key to", "denied");
    return { url: new URL(shaped.url.pathname + shaped.url.search, origin), addresses: ["127.0.0.1"], display: shaped.url };
  }

  /**
   * A public document by its https address, for a person who pointed at it (an API description to import): a plain GET with no credential and no cookie, the address resolved and checked against
   * private, loopback, link-local and metadata ranges at every hop, the connection pinned to the address that was checked, at most 3 redirects (each checked the same way), a size cap, and a timeout.
   * It sends nothing of the person's. The caller decides who may ask (the connectors module, for a person's own import).
   * @param {string} rawUrl @param {number} [maxBytes]
   */
  async fetchPublic(rawUrl, maxBytes = 5_000_000) {
    let url = String(rawUrl || "");
    for (let hops = 0; ; hops++) {
      let host;
      try { host = new URL(url).hostname; } catch { throw bad("that is not an address"); }
      const t = await checkTarget(url, [host], { lookup: this.deps.lookup });
      const r = await this.transport({ url: t.url, address: t.addresses[0], method: "GET", headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*;q=0.1", "user-agent": "vyre-import" }, timeoutMs: 20_000, maxBytes });
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        if (hops >= 3) throw bad("that address redirected more than three times", "redirect");
        let next;
        try { next = new URL(r.headers.location, t.url); } catch { throw bad("the redirect was not an address", "redirect"); }
        if (next.protocol !== "https:") throw bad("the redirect left https", "redirect");
        url = next.toString();
        continue;
      }
      if (r.truncated) throw bad(`that file is larger than ${Math.round(maxBytes / 1_000_000)} MB`, "too_large");
      if (!(r.status >= 200 && r.status < 300)) throw bad(`the address answered ${r.status}`, "not_found");
      return { status: r.status, body: Buffer.from(r.body).toString("utf8"), type: String(r.headers["content-type"] || "") };
    }
  }

  /**
   * An operation of a Connection as the request it stands for. A declared name builds from its path and shapes (the input is checked, an input it does not declare is refused); `request` is the
   * generic one: any method and path on the credential's host. Nothing is allowed here that the request below would not allow: this only writes the request down.
   * @param {any} input @param {string} name
   */
  async fromOperation(input, name) {
    const { config } = await this.vault.apiCredential(name);
    const host = config.hosts.length === 1 && !config.hosts[0].startsWith("*.") ? config.hosts[0] : null;
    if (!config.operations || !host) throw bad(`${name} is not a Connection: it has no operations to run`, "not_found");
    const op = String(input.operation);
    const given = isObj(input.input) ? input.input : {};
    /** @type {any} */ let built;
    if (op === "request") {
      const path = String(given.path || "");
      if (!/^\/[^\s?#]*$/.test(path)) throw bad("the generic request names a path from the root, with the query in `query`");
      built = { method: String(given.method || "GET").toUpperCase(), path, query: given.query, headers: given.headers, body: given.body };
    } else {
      if (!Object.hasOwn(config.operations, op)) throw bad(`${name} has no operation ${printable(op, 40)}; it has ${Object.keys(config.operations).slice(0, 12).join(", ") || "none declared"}, and request`, "not_found");
      try { built = buildRequest({ id: name, ops: config.operations }, op, given); }
      catch (e) { throw bad(/** @type {Error} */ (e).message, "bad_input"); }
    }
    const { operation: _o, input: _i, ...rest } = input;
    return { ...rest, method: built.method, url: `https://${host}${built.path}`, ...(built.query !== undefined ? { query: built.query } : {}), ...(built.headers !== undefined ? { headers: built.headers } : {}),
      ...(built.body !== undefined ? { body: built.body } : {}) };
  }

  /**
   * Check and classify a request. Throws with a reason a person can act on; touches no network
   * except the DNS lookup checkTarget does.
   * @param {any} input @param {string} name the credential
   */
  async plan(input, name) {
    const { row, config, secret } = await this.vault.apiCredential(name);
    const method = String(input.method || "").toUpperCase();
    if (!METHODS.includes(method)) throw bad(`method must be one of ${METHODS.join(", ")}`);
    const headers = checkHeaders(input.headers);
    const rawUrl = buildUrl(input.url, input.query);
    const target = config.app ? await this.appTarget(config, rawUrl) : await checkTarget(rawUrl, config.hosts, { lookup: this.deps.lookup });
    const url = target.url;
    checkQuery(url);
    let body;
    if (input.body !== undefined && input.body !== null && input.body !== "") {
      if (method === "GET" || method === "HEAD") throw bad("a GET or HEAD carries no body");
      body = encodeBody(input.body, headers["content-type"]);
      if (Buffer.byteLength(body) > MAX_BODY) throw bad("body is larger than 1 MB");
    }
    const pathAndQuery = url.pathname + url.search;
    const cls = classify(method, pathAndQuery, config.endpoints);
    const wildcard = config.hosts.some(h => h.startsWith("*."));
    // An unlisted GET on a wildcard host is not a read (reviewer M8): a shared-domain wildcard
    // would let an injected agent read or leak through a URL it chose. The credential's own
    // endpoints, or a preset's read list on the preset's host, make it one.
    if (cls.kind === "read" && !cls.matched && wildcard && !presetRead(method, pathAndQuery, url.hostname))
      throw bad(`${method} ${printable(url.pathname, 80)} is not listed as a read for this credential, and its hosts include a wildcard; add the path to its endpoints as a read, or name the exact host`, "not_listed");
    const preset = presetFor(method, pathAndQuery);
    const parsed = cls.kind === "read" ? { recipients: [] } : parseFields(preset, { body, contentType: headers["content-type"] });
    const actingAs = config.auth.type === "service-account" ? config.auth.subject : row.name;
    // an app's address is its port of the day: what is approved and shown is the stable name (<app>.app.invalid), not the port
    const href = target.display ? target.display.toString() : url.toString();
    const hash = approvalHash({ credential: row.name, method, url: href, headers, body });
    return { name: row.name, ver: Number(row.ver || 0), config, secret, method, url, href, headers, body, kind: cls.kind, classified: cls, parsed, actingAs, hash,
      to: parsed.recipients.length ? parsed.recipients : [url.hostname],
      summary: cls.kind === "read" ? "" : summarize({ kind: cls.kind, method, url: href, actingAs, parsed }) };
  }

  // ---- authentication ----

  /** The secret a credential authenticates with: its own sealed one, or the vault item it names. @returns {Promise<string>} */
  async secretOf(plan) {
    const a = plan.config.auth;
    if (!a.item) {
      if (!plan.secret) throw bad(`${plan.name} has no secret`, "config");
      return plan.secret;
    }
    const r = this.vault.row(a.item);
    if (!r) throw bad(`${plan.name} names the vault item ${a.item}, which is not there`, "config");
    if (r.kind === "api-credential") throw bad(`${plan.name} names another api-credential, which never hands out a value`, "config");
    const f = await this.vault.fields(r);
    if (a.type === "basic" && !a.field && isStr(f.username) && isStr(f.password) && f.username && f.password) return `${f.username}:${f.password}`;
    const want = a.field || defaultField(r.kind, Object.keys(f));
    if (!want || !isStr(f[want]) || !f[want]) throw bad(`${plan.name}: ${a.item} has no ${want || "field named"}`, "config");
    return f[want];
  }

  /**
   * The authentication headers for a plan and every value it touched, for scrubbing. Fetched
   * per call; only a minted access token is kept, in memory, until shortly before it expires.
   * @returns {Promise<{ headers: Record<string, string>, query?: Record<string, string>, known: string[] }>}
   */
  async authFor(plan) {
    const a = plan.config.auth;
    if (a.type === "oauth") {
      const known = [];
      const token = await this.oauthToken(plan, known);
      known.push(token);
      return { headers: { authorization: `Bearer ${token}` }, known };
    }
    const secret = await this.secretOf(plan);
    const known = forms(secret);
    if (a.type === "service-account") {
      const token = await this.mint(plan, secret, known);
      known.push(token);
      return { headers: { authorization: `Bearer ${token}` }, known };
    }
    if (a.type === "basic") {
      if (/[\r\n]/.test(secret)) throw bad(`${plan.name}'s secret has a line break, which a header cannot carry`, "config");
      const value = `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
      // the pair, its encoding, and the password alone (an API that echoes the password back must not get it past the scrub)
      const at = secret.indexOf(":");
      known.push(value, Buffer.from(secret, "utf8").toString("base64"), ...(at >= 0 && secret.length - at > 1 ? [secret.slice(at + 1)] : []));
      return { headers: { authorization: value }, known };
    }
    if (a.type === "api-key" && a.in === "query") {
      if (/[\r\n]/.test(secret)) throw bad(`${plan.name}'s secret has a line break, which a query cannot carry`, "config");
      known.push(encodeURIComponent(secret));
      return { headers: {}, query: { [a.param]: secret }, known };
    }
    const header = String(a.header || (a.type === "api-key" ? "x-api-key" : "authorization")).toLowerCase();
    const format = a.format || (a.type === "bearer" ? "Bearer {value}" : "{value}");
    const value = format.split("{value}").join(secret);
    if (/[\r\n]/.test(value)) throw bad(`${plan.name}'s secret has a line break, which a header cannot carry`, "config");
    known.push(value);
    return { headers: { [header]: value }, known };
  }

  /**
   * The access token of a signed-in oauth credential. The sign-in (the connectors module, through
   * vault.credential.tokens) stored { refresh_token, access_token, expires_at } as this credential's
   * sealed secret; a stored token is used while it is good, then refreshed at the config's own
   * token_uri (never one from the secret), which must pass the same target check. A vendor that
   * rotates the refresh token has the new one sealed before the call goes on.
   * @param {any} plan @param {string[]} known
   */
  async oauthToken(plan, known) {
    const key = `${plan.name}\u0000${plan.ver}`;
    const hit = this.tokens.get(key);
    if (hit && hit.expires - EARLY_MS > this.now()) { known.push(hit.token); return hit.token; }
    // One refresh per credential at a time: a vendor that rotates the refresh token would refuse the
    // second of two concurrent refreshes, and the loser could be the one sealed last. The second caller
    // waits for the first and re-reads the sealed tokens.
    const running = this.refreshing.get(plan.name);
    if (running) {
      await running.catch(() => {});
      const fresh = await this.vault.apiCredential(plan.name);
      return this.oauthToken({ ...plan, ver: Number(fresh.row.ver || 0), secret: fresh.secret }, known);
    }
    const p = this.refreshOauth(plan, known);
    this.refreshing.set(plan.name, p);
    try { return await p; } finally { if (this.refreshing.get(plan.name) === p) this.refreshing.delete(plan.name); }
  }

  /** The refresh itself; see oauthToken. @param {any} plan @param {string[]} known */
  async refreshOauth(plan, known) {
    const a = plan.config.auth;
    const key = `${plan.name}\u0000${plan.ver}`;
    let t;
    try { t = JSON.parse(plan.secret || ""); } catch { t = null; }
    if (!isObj(t) || (!isStr(t.refresh_token) && !isStr(t.access_token))) throw bad(`${plan.name} is not signed in yet · vyre connect add app <name>`, "not_signed_in");
    for (const k of ["refresh_token", "access_token"]) if (isStr(t[k])) known.push(t[k]);
    const at = Number(t.expires_at) || 0;
    if (isStr(t.access_token) && at - EARLY_MS > this.now()) { this.tokens.set(key, { token: t.access_token, expires: at }); return t.access_token; }
    if (!isStr(t.refresh_token)) throw bad(`${plan.name}'s sign-in has ended; sign in again · vyre connect add app <name> --replace`, "not_signed_in");
    const row = this.vault.row(a.client.item);
    if (!row) throw bad(`${plan.name} names the vault item ${a.client.item}, which is not there`, "config");
    if (row.kind === "api-credential") throw bad(`${plan.name} names another api-credential as its app, which never hands out a value`, "config");
    const f = await this.vault.fields(row);
    const clientId = f[a.client.field || "client_id"], clientSecret = f.client_secret;
    if (!isStr(clientId) || !clientId) throw bad(`${a.client.item} has no client_id`, "config");
    if (isStr(clientSecret)) known.push(clientSecret);
    let host;
    try { host = new URL(a.token_uri).hostname; } catch { throw bad(`${plan.name} has a token_uri that is not an address`, "config"); }
    const target = await checkTarget(a.token_uri, [host], { lookup: this.deps.lookup });
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId });
    if (a.scopes.length) body.set("scope", a.scopes.join(" "));
    if (isStr(clientSecret) && clientSecret) body.set("client_secret", clientSecret);
    const r = await this.transport({ url: target.url, address: target.addresses[0], method: "POST", body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, timeoutMs: TIMEOUT_MS, maxBytes: 100_000 });
    const text = scrub(r.body.toString("utf8"), known);
    if (r.status >= 300 && r.status < 400) throw bad("the token endpoint answered a redirect, which is refused", "redirect");
    let j = null;
    try { j = JSON.parse(r.body.toString("utf8")); } catch { /* not JSON */ }
    if (isObj(j)) for (const k of ["access_token", "refresh_token", "id_token"]) if (isStr(j[k])) known.push(j[k]);
    if (r.status !== 200) {
      const why = isObj(j) && isStr(j.error) ? `${j.error}${isStr(j.error_description) ? ` (${scrub(j.error_description, known).slice(0, 200)})` : ""}` : text.slice(0, 200) || "no reason given";
      throw bad(`the token endpoint answered ${r.status}: ${why}. If the sign-in ended, sign in again · vyre connect add app <name> --replace`, "refused");
    }
    if (!isObj(j) || !isStr(j.access_token) || !j.access_token) throw bad("the token endpoint answered with no access token", "token");
    const secs = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
    const expires = this.now() + secs * 1000;
    // Seal the new tokens before using them, so a rotation is never lost: the old refresh token is spent.
    const next = { refresh_token: isStr(j.refresh_token) && j.refresh_token ? j.refresh_token : t.refresh_token, access_token: j.access_token, expires_at: expires };
    await this.vault.setApiSecret(plan.name, JSON.stringify(next));
    this.tokens.set(key, { token: j.access_token, expires });
    return j.access_token;
  }

  /** Forget every access token held for a credential (its sign-in was replaced). @param {string} name */
  forget(name) {
    for (const k of [...this.tokens.keys()]) if (k.startsWith(`${name}\u0000`)) this.tokens.delete(k);
  }

  /**
   * A service account's access token for its fixed subject: an RS256 assertion signed here and
   * exchanged at the key's token_uri, which must itself pass the same target check.
   * @param {any} plan @param {string} raw the key JSON @param {string[]} known
   */
  async mint(plan, raw, known) {
    const a = plan.config.auth;
    const cache = crypto.createHash("sha256").update(JSON.stringify([plan.name, plan.ver, a.subject, [...a.scopes].sort()])).digest("hex");
    const hit = this.tokens.get(cache);
    if (hit && hit.expires - EARLY_MS > this.now()) { known.push(hit.token); return hit.token; }
    let key;
    try { key = JSON.parse(raw); } catch { key = null; }
    if (!isObj(key) || !isStr(key.client_email) || !isStr(key.private_key)) throw bad(`${plan.name}'s secret is not a service-account key (client_email, private_key)`, "config");
    known.push(...forms(key.private_key));
    if (key.private_key_id) known.push(String(key.private_key_id));
    const uri = isStr(key.token_uri) && key.token_uri ? key.token_uri : "https://oauth2.googleapis.com/token";
    let host;
    try { host = new URL(uri).hostname; } catch { throw bad(`${plan.name}'s key has a token_uri that is not an address`, "config"); }
    const t = await checkTarget(uri, [host], { lookup: this.deps.lookup });
    const iat = Math.floor(this.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: key.client_email, sub: a.subject, scope: a.scopes.join(" "), aud: uri, iat, exp: iat + 3600 }))}`;
    let sig;
    try { sig = crypto.sign("sha256", Buffer.from(unsigned), key.private_key).toString("base64url"); } catch { throw bad(`${plan.name}'s private key cannot sign`, "config"); }
    const assertion = `${unsigned}.${sig}`;
    known.push(assertion);
    const r = await this.transport({ url: t.url, address: t.addresses[0], method: "POST", body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, timeoutMs: TIMEOUT_MS, maxBytes: 100_000 });
    const text = scrub(r.body.toString("utf8"), known);
    if (r.status >= 300 && r.status < 400) throw bad("the token endpoint answered a redirect, which is refused", "redirect");
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status !== 200) {
      const why = j && isStr(j.error) ? `${j.error}${isStr(j.error_description) ? ` (${j.error_description.slice(0, 200)})` : ""}` : text.slice(0, 200) || "no reason given";
      throw bad(`the token endpoint answered ${r.status}: ${why}. Check ${a.subject} is one this service account may act as, with these scopes, under domain-wide delegation`, "refused");
    }
    if (!j || !isStr(j.access_token) || !j.access_token) throw bad("the token endpoint answered with no access token", "token");
    const secs = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
    this.tokens.set(cache, { token: j.access_token, expires: this.now() + secs * 1000 });
    return j.access_token;
  }

  // ---- running it ----

  /**
   * Make the call. Re-checks the target on every hop, follows a redirect only for a read on the
   * same host, and returns the response scrubbed and cut.
   * @param {any} plan @param {{ who: string, said?: string|null, released?: string|null }} o
   */
  async execute(plan, { who, said = null, released = null, raw = false }) {
    let known = [];
    const tag = `${plan.method} ${plan.url.hostname} ${plan.kind}${said ? ` said:${said}` : ""}${released ? ` released:${released}` : ""}`;
    try {
      const auth = await this.authFor(plan);
      known = auth.known;
      const headers = { accept: "application/json", ...plan.headers, ...(plan.body !== undefined && !plan.headers["content-type"] ? { "content-type": looksJson(plan.body) ? "application/json" : "application/x-www-form-urlencoded" } : {}), ...(plan.config.headers || {}), ...auth.headers };
      // a query api-key is added here, at every hop, so the approval hash and the audit line never carry it
      const withKey = (/** @type {URL} */ u) => { if (!auth.query) return u; const c = new URL(u.toString()); for (const [k, v] of Object.entries(auth.query)) c.searchParams.set(k, v); return c; };
      let url = plan.url, method = plan.method, hops = 0, tooMany = 0;
      /** @type {Reply} */ let reply;
      for (;;) {
        const t = plan.config.app ? { url: withKey(url), addresses: ["127.0.0.1"] } : await checkTarget(withKey(url).toString(), plan.config.hosts, { lookup: this.deps.lookup });
        await this.throttle(plan);
        reply = await this.transport({ url: t.url, address: t.addresses[0], method, headers, ...(plan.body !== undefined && method === plan.method ? { body: plan.body } : {}),
          timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE });
        // "Too many requests" means the provider did not act on it, so waiting out its Retry-After and trying again is safe for any method; the cooldown is shared by every caller.
        if (reply.status === 429 && tooMany < MAX_429_RETRIES && this.coolDown(plan.name, reply) > 0) { tooMany++; continue; }
        if (plan.config.app && reply.status >= 300 && reply.status < 400) throw bad("an app on this machine answered a redirect, which is not followed", "redirect");
        if (reply.status >= 300 && reply.status < 400 && reply.headers.location) {
          if (method !== "GET" && method !== "HEAD") throw bad("the API answered a redirect to a write, which is refused; call the address it names directly", "redirect");
          let next;
          try { next = new URL(reply.headers.location, t.url); } catch { throw bad("the API answered a redirect to an address that is not one", "redirect"); }
          if (next.hostname.toLowerCase() !== t.url.hostname.toLowerCase()) throw bad(`the API redirected to another host (${printable(next.hostname, 80)}); the credential never follows one`, "redirect");
          if (++hops > MAX_HOPS) throw bad("the API redirected more than five times", "redirect");
          url = next;
          continue;
        }
        break;
      }
      this.vault.audit("api-request", plan.name, who, reply.status < 500, `${tag} ${reply.status}`);
      return raw ? this.rawShape(reply, known) : this.shape(reply, known);
    } catch (e) {
      const msg = scrub(String(/** @type {Error} */ (e)?.message || e), known);
      this.vault.audit("api-request", plan.name, who, false, `${tag}: ${printable(msg, 160)}`);
      throw Object.assign(new Error(msg), { code: /** @type {any} */ (e)?.code || "failed", ...(/** @type {any} */ (e)?.retryAfter ? { retryAfter: /** @type {any} */ (e).retryAfter } : {}) });
    }
  }

  /**
   * A reply for the forward path (a lent computer's program): kept headers and the body as bytes, up to the transport's 2 MB (more is refused, never cut). Text is scrubbed of every
   * value the credential touched; bytes that carry one are withheld rather than altered.
   */
  rawShape(reply, known) {
    if (reply.truncated) throw bad("the response is larger than 2 MB, which is not sent to a lent computer; fetch it at the home", "too_large");
    const type = String(reply.headers["content-type"] || ""), heads = {};
    for (const k of [...KEEP_HEADERS, "content-disposition"]) if (reply.headers[k] !== undefined) heads[k] = scrub(String(reply.headers[k]), known);
    const textual = /json|text|xml|javascript|x-www-form-urlencoded|csv|yaml|html/i.test(type) || (!type && !reply.body.includes(0));
    let body = reply.body;
    if (textual) body = Buffer.from(scrub(body.toString("utf8"), known));
    else if (known.some(k => isStr(k) && k.length >= 8 && body.includes(k))) throw bad("the response carries a credential value and is withheld", "withheld");
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: heads, body };
  }

  /**
   * One request from a lent computer's program, run here at the home (the one mechanism: a credentialed call is never made on the lent machine and no header value,
   * key or token ever goes to it). The kernel has already matched the request to a route the session holds and allowed its method and path; this adds what the
   * credential itself says (hosts, the SSRF guard, read or outward). A read runs and its response comes back as bytes; anything outward is held for the ask-first task
   * exactly as vault.request holds it, whoever asked, and what comes back is `{ held }`, not a response. Request bodies are text, JSON or form only, up to 1 MB.
   * @param {any} input { credential, method, url, query?, headers?, body? } @param {{ caller: string, thread?: string }} meta
   */
  async forward(input, meta) {
    const caller = String(meta.caller), name = String(input.credential || "");
    if (isStr(input.body) === false && input.body !== undefined && input.body !== null && !isObj(input.body) && !Array.isArray(input.body)) throw bad("a request body is text, JSON or form fields; a binary or multipart upload is not carried to the home in this release", "binary_body");
    const audit = (ok, why) => this.vault.audit("api-request", name || null, caller, ok, why);
    const clean = { ...input, headers: forwardHeaders(input.headers, input.allow_headers) };
    let plan;
    try { plan = await this.plan(clean, name); } catch (e) { audit(false, printable(/** @type {Error} */ (e).message, 160)); throw e; }
    if (plan.kind === "read") return { ...(await this.execute(plan, { who: caller, raw: true })), kind: "read" };
    const r = await this.request(clean, { caller, ...(meta.thread ? { thread: meta.thread } : {}) });
    if (r && r.held) return { held: r.held, kind: r.kind, summary: r.summary, message: r.message };
    return { status: Number(r.status) || 200, ok: !!r.ok, headers: r.headers || {}, body: Buffer.from(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "")), kind: r.kind, ...(r.said ? { said: r.said } : {}) };
  }

  /** A reply as a caller may see it: kept headers, the body as JSON or text, scrubbed of everything the credential touched, cut. */
  shape(reply, known) {
    const type = String(reply.headers["content-type"] || "");
    const heads = {};
    for (const k of KEEP_HEADERS) if (reply.headers[k] !== undefined) heads[k] = reply.headers[k];
    /** @type {any} */
    let body;
    const textual = /json|text|xml|javascript|x-www-form-urlencoded|csv|yaml|html/i.test(type) || (!type && !reply.body.includes(0));
    if (!reply.body.length) body = "";
    else if (!textual) body = { binary: true, bytes: reply.body.length, type: type || null };
    else {
      const text = reply.body.toString("utf8");
      body = text;
      if (/json/i.test(type)) { try { body = JSON.parse(text); } catch { /* keep the text */ } }
    }
    let out = scrubAll({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: heads, body, ...(reply.truncated ? { truncated: true } : {}) }, known);
    const s = JSON.stringify(out);
    if (s.length > MAX_RESULT) {
      const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      out = { ...out, body: text.slice(0, MAX_RESULT - 4096) + ` [cut: the response was ${s.length} characters]`, truncated: true };
    }
    return out;
  }

  // ---- the tool ----

  /**
   * vault.request.
   * @param {any} input @param {{ caller: string, thread?: string, agent?: string, watcher?: string }} meta
   */
  async request(input, meta) {
    const caller = String(meta.caller);
    const name = String(input.credential || "");
    // A Connection's operation: { credential, operation, input } is built into the same method, url, query, headers and body a caller could have written, and then judged by everything below as such.
    if (input.operation !== undefined) input = await this.fromOperation(input, name);
    else if (typeof input.url !== "string" || typeof input.method !== "string") throw bad("a request names its method and url, or an operation of a Connection");
    const mod = caller.startsWith("module:") ? caller.slice(7) : null;
    // Only a module vouches for a watcher; a model's claim in its input is not heard.
    const watcher = mod && isStr(input.watcher) && input.watcher ? input.watcher : "";
    const audit = (ok, why) => this.vault.audit("api-request", name || null, watcher ? `${caller}/${watcher}` : caller, ok, why);
    // A module's right to use the credential is checked before anything else, the network included. A
    // module the person named as a reader when they made the credential needs no grant, for reads of
    // the paths named for it and nothing else.
    let reader = false;
    if (mod && !watcher) {
      try { reader = (((await this.vault.apiCredential(name)).config.readers) || []).some(x => x.module === mod); } catch { reader = false; }
    }
    if (mod && !reader) this.granted(name, mod, watcher, audit);
    let plan;
    try { plan = await this.plan(input, name); }
    catch (e) { audit(false, printable(/** @type {Error} */ (e).message, 160)); throw e; }
    if (reader && !(plan.kind === "read" && readerMayRead(plan.config, String(mod), plan.url.pathname + plan.url.search))) {
      audit(false, `${plan.method} ${plan.url.hostname} refused: ${mod} may only read the paths named for it`);
      throw bad(`${mod} may only read ${plan.config.readers.find(x => x.module === mod).paths.join(", ")} through ${name}`, "denied");
    }

    // A thread the person tagged with #<this credential> uses it by right: note it quietly (vault.used), and the hosts the item has now must be the ones it had at the tag.
    let tagged = false;
    if (meta.thread && this.deps.said && this.deps.call) {
      const use = await this.deps.said.match({ kind: "use", to: [name], hosts: plan.config.hosts }, { thread: meta.thread }).catch(() => null);
      if (use) { tagged = true; this.deps.call("vault.use.note", { item: name, thread: meta.thread, via: "vault.request" }).catch(() => {}); }
    }

    // A model reads through a credential only inside its scope: a named agent, or a session bound to a project, must be named by the
    // credential's { projects, agents } (or the person tagged the credential to its thread). The person's own session, the assistant and
    // a module with a grant keep their reach. A read inside scope still runs with no prompt.
    const agentName = meta.agent || (/(?:^|:)agent:([^:\s]+)/.exec(caller) || [])[1];
    const isModel = caller === "mcp" || caller.startsWith("mcp:") || agentClaim(caller) !== null; // an agent inside the person's CLI (cli:agent:kit) is still the agent
    if (isModel && plan.kind === "read" && (agentName || meta.project) && /** @type {any} */ (meta).agentKind !== "assistant" && !tagged
        && !scopeAllows(plan.config, { agent: agentName, project: /** @type {any} */ (meta).project })) {
      audit(false, `${plan.method} ${plan.url.hostname} refused: outside the credential's scope`);
      throw bad(`${name} is not available to ${agentName ? `the agent ${agentName}` : "this project"}: give it access in the credential's scope (projects and agents)`, "denied");
    }

    if (plan.kind === "read") return { ...(await this.execute(plan, { who: watcher ? `${caller}/${watcher}` : caller })), kind: "read" };

    // A watcher has no card to wait behind: it runs reads and is refused anything outward.
    if (watcher) {
      audit(false, `${plan.method} ${plan.url.hostname} ${plan.kind} refused: a watcher only reads`);
      throw bad(`${plan.method} ${printable(plan.url.pathname, 80)} is a ${plan.kind}; a watcher may only read through vault.request, so it is refused, not held`, "denied");
    }

    // Asking is approving: what the person's own words covered runs now.
    const said = this.deps.said ? await this.deps.said.match({
      kind: plan.kind, channel: `api:${name}`, via: `api:${name}`, to: plan.to, ...(plan.kind === "spend" ? { amount: plan.parsed.amount, payee: plan.parsed.payee, currency: plan.parsed.currency } : {}),
    }, { thread: meta.thread }).catch(() => null) : null;
    if (said) return { ...(await this.execute(plan, { who: caller, said: said.id })), kind: plan.kind, said: said.id };

    // Otherwise hold it, with a card built from parsed fields, never from the body's own words.
    if (!this.deps.call) throw bad("the Gate is not running, so an outward call cannot be held", "failed");
    await this.offer();
    const agent = meta.agent || (/^mcp:agent:(.+)$/.exec(caller) || [])[1] || undefined;
    const r = await this.deps.call("gate.request", {
      kind: GATE_KINDS[plan.kind] || "send", via: GATE_SENDER, to: plan.to, why: `vault.request on ${name}`,
      ...(meta.thread ? { thread: meta.thread } : {}), ...(agent ? { agent } : {}),
      content: this.sealed({ credential: name, method: plan.method, url: plan.href, summary: plan.summary, hash: plan.hash, kind: plan.kind,
        request: { headers: plan.headers, ...(plan.body !== undefined ? { body: plan.body } : {}) }, parsed: plan.parsed }),
    });
    if (r.error) throw bad(r.error.message || "the Gate did not take it", r.error.code || "failed");
    // The Gate matches what the person said as well (a second look at the same words): if it ran
    // the call there, that is the answer.
    if (r.data.state === "sent") return { ...(isObj(r.data.result) ? r.data.result : {}), kind: plan.kind, said: String(r.data.by || "").replace(/^said:/, "") };
    audit(true, `${plan.method} ${plan.url.hostname} ${plan.kind} held ${r.data.id}`);
    return { held: r.data.id, kind: plan.kind, summary: plan.summary, message: r.data.message, ...(r.data.error ? { error: r.data.error } : {}) };
  }

  /**
   * A seal over what a held card says and what it will run, made with the vault's own MAC key. Only
   * this file holds one item to the Gate, but the Gate's request tool is open to a model, so
   * without a seal a model could hold a card of its own with a summary it wrote (reviewer M10). An
   * item with no valid seal is never sent, so a forged card can only ever fail.
   * @param {any} c
   */
  sealed(c) { return { ...c, seal: this.seal(c) }; }

  /** @param {any} c */
  seal(c) {
    const key = /** @type {any} */ (this.vault).mkey;
    if (!key) throw bad("the vault is locked", "locked");
    return rowMac(key, "vault-api:v1", { credential: c.credential, method: c.method, url: c.url, hash: c.hash, kind: c.kind, summary: c.summary });
  }

  /** A module needs an active grant for the credential (a watcher's is its own); a person's surface does not. */
  granted(name, mod, watcher, audit) {
    const rows = /** @type {any[]} */ (this.vault.db.prepare("SELECT * FROM vault_grants WHERE item=? AND module=? AND watcher=? AND status='active'").all(name, mod, watcher));
    if (rows.some(g => this.vault.rowOk("vault_grants", g))) return;
    audit(false, "no grant");
    throw bad(`${name} is not granted to ${watcher ? `${mod}/${watcher}` : mod} for vault.request · vyre vault grant ${name} ${mod}${watcher ? ` --watcher ${watcher}` : ""}`, "denied");
  }

  /**
   * The Gate's `vault-api` sender: offered at start and before each hold, since a Gate that
   * restarted forgot it. True when the Gate took it.
   */
  async offer() {
    if (!this.deps.call) return false;
    const r = await this.deps.call("gate.offer", { name: GATE_SENDER, tool: "vault.api.send", kinds: Object.keys(GATE_KINDS),
      content: { credential: "the api-credential's name", method: "string", url: "string", summary: "string, built by Vyre", hash: "approval hash", request: "object: headers, body" } });
    if (r && r.error) { if (this.deps.log && r.error.code !== "no_such_tool") this.deps.log(`vault: could not offer the Gate sender ${GATE_SENDER}: ${r.error.message}`); return false; }
    return true;
  }

  /** Offer now, and keep trying for a while when the Gate has not started yet (modules start in dependency order, and neither needs the other). */
  offerSoon() {
    let n = 0;
    const delays = [200, 1000, 3000, 10_000, 30_000];
    const attempt = async () => {
      if (this.stopped) return;
      const ok = await this.offer().catch(() => false);
      if (ok || n >= delays.length || this.stopped) return;
      const t = setTimeout(() => { this.timers.delete(t); attempt(); }, delays[n++]);
      if (typeof t.unref === "function") t.unref();
      this.timers.add(t);
    };
    return attempt();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * The Gate approved a held request: run exactly it. Rebuilt from the Gate's own record, since a
   * module could call this tool with anything; it must be an item being sent, must hash to what
   * the person saw, and must still pass every check and classify the same way.
   * @param {{ id: string }} input @param {string} caller
   */
  async send({ id }, caller) {
    if (caller !== "module:gate") throw bad("only the Gate sends what a person approved", "denied");
    if (!this.deps.call) throw bad("the Gate is not running", "failed");
    const r = await this.deps.call("gate.get", { id });
    const it = r && r.data;
    if (!it || it.state !== "sending" || it.via !== GATE_SENDER) throw bad(`${String(id).slice(0, 40)} is not an approved item being sent`, "denied");
    const c = it.final || it.draft;
    if (!isObj(c) || !isStr(c.credential) || !isStr(c.method) || !isStr(c.url) || !isStr(c.hash)) throw bad("the approved content is not a held API request", "bad_input");
    const held = isObj(c.request) ? c.request : {};
    let sealOk = false;
    try { sealOk = isStr(c.seal) && same(c.seal, this.seal(c)); } catch { /* locked: not sent */ }
    if (!sealOk) throw bad("this card was not made by the vault, or its words were changed, so it is not sent", "denied");
    if (isObj(held.file)) {
      const files = this.deps.filesFor ? this.deps.filesFor({ session: String(held.file.session ?? "") }) : this.deps.files;
      if (!files) throw bad("the Drive is not wired, so a held file request cannot be sent", "failed");
      return sendFile(this, { files }, c, held, it, caller);
    }
    const plan = await this.plan({ credential: c.credential, method: c.method, url: c.url, headers: held.headers, body: held.body }, c.credential);
    if (plan.hash !== c.hash) throw bad("the request was changed after it was held, so it is not sent; ask again", "denied");
    if (plan.kind !== c.kind) throw bad(`this credential now classifies the request as a ${plan.kind}, not a ${c.kind}; ask again`, "denied");
    return this.execute(plan, { who: `${caller} for ${it.by || "the user"}`, released: id });
  }
}

/** A body as the text that goes out: text as given, an object as JSON, or as a form when the caller said so. */
function encodeBody(body, contentType) {
  if (isStr(body)) return body;
  if (/x-www-form-urlencoded/i.test(contentType || "") && isObj(body)) {
    const p = new URLSearchParams();
    const add = (k, v) => {
      if (Array.isArray(v)) v.forEach((x, i) => add(`${k}[${i}]`, x));
      else if (isObj(v)) for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv);
      else if (v !== undefined && v !== null) p.append(k, String(v));
    };
    for (const [k, v] of Object.entries(body)) add(k, v);
    return p.toString();
  }
  return JSON.stringify(body);
}
const looksJson = text => /^\s*[[{]/.test(text);

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/**
 * @param {{ vault: import("./vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void,
 *   internal: (name: string, description: string, input: any, run: Function) => void,
 *   call?: (tool: string, input: any) => Promise<any>, said?: any, deps?: RequestDeps, log?: (m: string) => void }} o
 */
export function register({ vault, tool, internal, call, said, deps = {}, log }) {
  const api = new ApiRequests(vault, { call, said, log, ...deps });

  internal("vault.forward", "The kernel's lease module forwards one request from a lent computer's program: { credential, method, url, query?, headers?, body?, session }. It runs here, at the home, through the same checks as vault.request, and returns { status, headers, body (base64) } or { held } for an outward call. Never returns a credential value.",
    obj({ credential: str, method: { type: "string", enum: METHODS }, url: str, headers: { type: "object" }, allow_headers: strs, query: { type: "object" }, body: { anyOf: [str, { type: "object" }, { type: "array" }] }, session: str }, ["credential", "method", "url", "session"]),
    async (input, { caller }) => {
      if (caller !== "kernel:leases" && caller !== "module:leases") throw bad("only the kernel's lease module forwards a lent computer's request", "denied");
      const r = await api.forward(input, { caller: `runner:${String(input.session).slice(0, 80)}` });
      return r.held ? r : { ...r, body: r.body.toString("base64") };
    });

  internal("vault.forward.file", "The kernel's lease module forwards one request that moves a file for a lent computer's program: { credential, method, url, query?, headers?, session, upload?: { drive: { path, version?, contentType } } or { multipart: [ { name, value } | { name, filename, contentType, drive: { path, version? } } ] }, saveTo?, stream?, limits?: { maxBytes, contentTypes }, drive?: { read, write } }. The file is read from, or saved to, the Space's Drive by reference at the home and moves a chunk at a time; an outward call is held for a person. Returns the response, { saved }, a stream or { held }; never a credential value.",
    obj({ credential: str, method: { type: "string", enum: METHODS }, url: str, headers: { type: "object" }, allow_headers: strs, query: { type: "object" }, upload: { type: "object" }, saveTo: str, stream: { type: "boolean" }, limits: { type: "object" }, drive: { type: "object" }, session: str }, ["credential", "method", "url", "session"]),
    async (input, { caller, files: given }) => {
      if (caller !== "kernel:leases" && caller !== "module:leases") throw bad("only the kernel's lease module forwards a lent computer's request", "denied");
      // FW-2: the Drive is reached AS THE LENT MEMBER. The kernel's own call hands `files` in-process (its Drive door under that member's chain, so a route's Drive lists only ever narrow what the member may do) and only the
      // lease module's caller is believed; else `deps.filesFor({ session })`; `deps.files` is the home's own handle for a rig with no kernel.
      const files = given || (api.deps.filesFor ? api.deps.filesFor({ session: String(input.session) }) : api.deps.files);
      if (!files) throw bad("the Drive is not wired to this vault", "failed");
      const r = await forwardFile(api, { files }, input, { caller: `runner:${String(input.session).slice(0, 80)}` });
      return r.held || r.stream ? r : { ...r, ...(r.body ? { body: r.body.toString("base64") } : {}) };
    });

  registerService({ api, vault, internal, forwardFile, forwardHeaders, obj, str });

  tool("vault.request", ["cli", "local", "deck", "capsule", "mcp", "module"],
    "One HTTP call to a vendor API with an api-credential from the vault, which adds the key and never shows it. A read runs at once. A send, payment or deletion runs at once only if you asked for exactly it; otherwise it is held at the Gate with a card Vyre builds from the request's parsed fields. The response has every value the credential touched removed.",
    obj({ credential: str, method: { type: "string", enum: METHODS }, url: str, headers: { type: "object" }, query: { type: "object" },
      body: { anyOf: [str, { type: "object" }, { type: "array" }] }, watcher: str, operation: str, input: { type: "object" } }, ["credential"]),
    (input, meta) => api.request(input, meta));

  internal("vault.fetch.public", "A person's import of an API description by its address: { url, max_bytes? } -> { status, body, type }. A plain GET with no credential to a public https address (private ranges refused at every hop, size capped). Only the connectors module asks, and it asks only for a person's own act.",
    obj({ url: str, max_bytes: { type: "integer" } }, ["url"]),
    async ({ url, max_bytes }, { caller }) => {
      if (caller !== "module:connectors") throw bad("only the connectors module fetches a description for a person's import", "denied");
      return api.fetchPublic(String(url), Math.min(5_000_000, Math.max(1000, Number(max_bytes) || 5_000_000)));
    });

  internal("vault.api.send", "The Gate calls this with { id } once a person approves a held vault.request, and it runs exactly the request the person saw, re-checked. Offered to the Gate as the vault-api sender.",
    obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id"]),
    (input, { caller }) => api.send(input, String(caller)));

  internal("vault.credential.tokens", "The connectors module stores a finished sign-in in an oauth api-credential: { name, tokens: { refresh_token?, access_token, expires_in?, token_uri } }. Refused unless the token_uri is the one the credential names.",
    obj({ name: str, tokens: { type: "object" } }, ["name", "tokens"]),
    async ({ name, tokens }, { caller }) => {
      if (caller !== "module:connectors") throw bad("only the connectors module stores a sign-in", "denied");
      const { config } = await vault.apiCredential(String(name));
      if (config.auth.type !== "oauth") throw bad(`${name} is not an oauth credential`);
      const t = isObj(tokens) ? tokens : {};
      // The token must come from the endpoint the person's config names (P21), never one the caller picks. This proves
      // what connectors claims, not where the tokens came from; that is acceptable because only the first-party
      // connectors module can call this tool (the caller check above).
      if (t.token_uri !== config.auth.token_uri) throw bad("that sign-in did not come from the token endpoint this credential names", "denied");
      if (!isStr(t.access_token) || !t.access_token) throw bad("a sign-in has an access token");
      const expires = Number(t.expires_in) > 0 ? api.now() + Number(t.expires_in) * 1000 : 0;
      await vault.setApiSecret(String(name), JSON.stringify({ ...(isStr(t.refresh_token) && t.refresh_token ? { refresh_token: t.refresh_token } : {}), access_token: t.access_token, ...(expires ? { expires_at: expires } : {}) }));
      api.forget(String(name));
      return { stored: true };
    });

  // Offer the sender now, and again until the Gate is up; every hold offers it again.
  api.offerSoon().catch(() => {});
  return api;
}
