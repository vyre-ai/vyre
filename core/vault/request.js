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
import https from "node:https";
import { defaultField } from "../../lib/vault-kinds/kinds.js";
import { rowMac, same } from "./crypto.js";
import {
  checkTarget, classify, presetFor, presetRead, parseFields, summarize, approvalHash, checkHeaders, checkQuery, buildUrl, pinnedOptions,
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
const EARLY_MS = 60_000;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CONCEALED = "<concealed by vyre>";
/** Response headers worth handing back. Never a cookie, never anything that authenticates. */
const KEEP_HEADERS = ["content-type", "content-length", "etag", "last-modified", "retry-after", "x-request-id", "request-id", "x-ms-request-id", "x-goog-request-id", "ratelimit-remaining"];

const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = v => typeof v === "string";
const bad = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const printable = (s, n) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const b64url = s => Buffer.from(s).toString("base64url");

// ---- scrubbing (the connectors' own copy: modules never import each other's files) ----

/** @param {unknown} text @param {string[]} values */
function scrub(text, values) {
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
    const req = https.request(pinnedOptions(url, address, { method, headers: h, timeout: timeoutMs }), res => {
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
  }

  // ---- building the plan: everything a decision needs, from the request alone ----

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
    const target = await checkTarget(rawUrl, config.hosts, { lookup: this.deps.lookup });
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
    const href = url.toString();
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
    const want = a.field || defaultField(r.kind, Object.keys(f));
    if (!want || !isStr(f[want]) || !f[want]) throw bad(`${plan.name}: ${a.item} has no ${want || "field named"}`, "config");
    return f[want];
  }

  /**
   * The authentication headers for a plan and every value it touched, for scrubbing. Fetched
   * per call; only a minted access token is kept, in memory, until shortly before it expires.
   * @returns {Promise<{ headers: Record<string, string>, known: string[] }>}
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
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId, scope: a.scopes.join(" ") });
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
  async execute(plan, { who, said = null, released = null }) {
    let known = [];
    const tag = `${plan.method} ${plan.url.hostname} ${plan.kind}${said ? ` said:${said}` : ""}${released ? ` released:${released}` : ""}`;
    try {
      const auth = await this.authFor(plan);
      known = auth.known;
      const headers = { accept: "application/json", ...plan.headers, ...(plan.body !== undefined && !plan.headers["content-type"] ? { "content-type": looksJson(plan.body) ? "application/json" : "application/x-www-form-urlencoded" } : {}), ...auth.headers };
      let url = plan.url, method = plan.method, hops = 0;
      /** @type {Reply} */ let reply;
      for (;;) {
        const t = await checkTarget(url.toString(), plan.config.hosts, { lookup: this.deps.lookup });
        reply = await this.transport({ url: t.url, address: t.addresses[0], method, headers, ...(plan.body !== undefined && method === plan.method ? { body: plan.body } : {}),
          timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE });
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
      return this.shape(reply, known);
    } catch (e) {
      const msg = scrub(String(/** @type {Error} */ (e)?.message || e), known);
      this.vault.audit("api-request", plan.name, who, false, `${tag}: ${printable(msg, 160)}`);
      throw Object.assign(new Error(msg), { code: /** @type {any} */ (e)?.code || "failed" });
    }
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
    const mod = caller.startsWith("module:") ? caller.slice(7) : null;
    // Only a module vouches for a watcher; a model's claim in its input is not heard.
    const watcher = mod && isStr(input.watcher) && input.watcher ? input.watcher : "";
    const audit = (ok, why) => this.vault.audit("api-request", name || null, watcher ? `${caller}/${watcher}` : caller, ok, why);
    // A module's right to use the credential is checked before anything else, the network included.
    if (mod) this.granted(name, mod, watcher, audit);
    let plan;
    try { plan = await this.plan(input, name); }
    catch (e) { audit(false, printable(/** @type {Error} */ (e).message, 160)); throw e; }

    // A thread the person tagged with #<this credential> uses it by right: note it quietly (vault.used), and the hosts the item has now must be the ones it had at the tag.
    if (meta.thread && this.deps.said && this.deps.call) {
      const use = await this.deps.said.match({ kind: "use", to: [name], hosts: plan.config.hosts }, { thread: meta.thread }).catch(() => null);
      if (use) this.deps.call("vault.use.note", { item: name, thread: meta.thread, via: "vault.request" }).catch(() => {});
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

  tool("vault.request", ["cli", "local", "deck", "capsule", "mcp", "module"],
    "One HTTP call to a vendor API with an api-credential from the vault, which adds the key and never shows it. A read runs at once. A send, payment or deletion runs at once only if you asked for exactly it; otherwise it is held at the Gate with a card Vyre builds from the request's parsed fields. The response has every value the credential touched removed.",
    obj({ credential: str, method: { type: "string", enum: METHODS }, url: str, headers: { type: "object" }, query: { type: "object" },
      body: { anyOf: [str, { type: "object" }, { type: "array" }] }, watcher: str }, ["credential", "method", "url"]),
    (input, meta) => api.request(input, meta));

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
