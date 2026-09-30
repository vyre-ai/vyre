// @ts-check
// The credential library the connectors share (ADR 0016, decision 2). The MCP hub and the Google
// module both need to turn a vault item into something a request can carry: a bearer header, an
// OAuth access token minted by refresh, or a Google service-account JWT exchanged for one. This
// file does that once, for both, and remembers every value it touched so callers can scrub them
// from anything that leaves the module.
//
// Rules, and why:
// - Values come only from the injected `fetchItem`. This file never reads a vault, a file or env,
//   so the module that owns the grant is the only door.
// - Access tokens live in process memory only. Refresh tokens and private keys are fetched per
//   mint and dropped; only their scrub forms are kept.
// - No value is ever logged or put in an error. Token-endpoint replies are scrubbed before they
//   become a message, because an endpoint can echo what it was sent.
// - Token requests refuse redirects: a redirect would carry a refresh token or an assertion to a
//   host the key never named.
// This file does not import core/gate (modules never import each other's files), so it keeps its
// own copy of the Gate's scrub.

import crypto from "node:crypto";

const CONCEALED = "<concealed by vyre>";
const TIMEOUT_MS = 30_000;
const EARLY_MS = 60_000;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KNOWN = 2000;

/**
 * @typedef {{ type: "none" } | { type: "bearer", item: string, field?: string, header?: string, format?: string }
 *   | { type: "oauth", item: string } | { type: "service-account", item: string, field?: string, subject?: string }} Auth
 * @typedef {{ fetchItem: (item: string, field?: string) => Promise<string>, fetch?: typeof fetch,
 *   save?: (item: string, fields: Record<string, string>) => Promise<void>,
 *   now?: () => number, log?: (message: string, fields?: Record<string, unknown>) => void }} CredentialDeps
 */

const isStr = v => typeof v === "string";

/**
 * Replace every occurrence of each value, and of its base64, base64url and URL-encoded forms,
 * with a marker. Values under 4 characters are skipped: scrubbing them would shred text.
 * Copied from core/gate/senders.js on purpose (see the header).
 * @param {unknown} text @param {string[]} values
 */
export function scrub(text, values) {
  let out = String(text ?? "");
  const forms = new Set();
  for (const v of values || []) {
    if (!isStr(v) || v.length < 4) continue;
    const b = Buffer.from(v, "utf8");
    for (const f of [v, b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"),
      encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1)]) if (f.length >= 4) forms.add(f);
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(CONCEALED);
  return out;
}

/**
 * Scrub every string inside a JSON-able value, keys included. It walks the value rather than
 * scrubbing its JSON text, so a value with a newline or a quote (a PEM key) still matches.
 * @template T @param {T} v @param {string[]} values @returns {T}
 */
export function scrubAll(v, values) {
  const walk = x => {
    if (isStr(x)) return scrub(x, values);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      if (x instanceof Error) return Object.assign(new Error(scrub(x.message, values)), { name: x.name });
      return Object.fromEntries(Object.entries(x).map(([k, val]) => [scrub(k, values), walk(val)]));
    }
    return x;
  };
  return walk(v);
}

/** A readable failure that carries no value. `code` lets callers tell refusals from outages. */
export class CredentialError extends Error {
  /** @param {string} message @param {{ code?: string, status?: number, oauthError?: string, scopes?: string[] }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = "CredentialError";
    this.code = info.code || "credential";
    if (info.status) this.status = info.status;
    if (info.oauthError) this.oauthError = info.oauthError;
    if (info.scopes) this.scopes = info.scopes;
  }
}

const b64url = s => Buffer.from(s).toString("base64url");
const scopeList = scopes => [...new Set((scopes || []).filter(isStr))].sort();

/** A token endpoint must be https, or http on loopback (the test fakes). */
export function checkTokenUri(uri, what) {
  let u;
  try { u = new URL(uri); } catch { throw new CredentialError(`${what} has no valid token_uri`, { code: "config" }); }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) {
    throw new CredentialError(`${what} has a token_uri that is not https`, { code: "config" });
  }
  return u.toString();
}

export class Credentials {
  /** @type {CredentialDeps["fetchItem"]} */ #fetchItem;
  /** @type {typeof fetch} */ #fetch;
  /** @type {() => number} */ #now;
  /** @type {(m: string, f?: Record<string, unknown>) => void} */ #log;
  /** @type {CredentialDeps["save"]} */ #save;
  /** A rotated refresh token whose save failed, kept so the connection keeps working while vyred runs and the save is tried again. */
  /** @type {Map<string, string>} */ #rotated = new Map();
  /** Items whose stored access token was refused (a 401), so the next mint refreshes instead. */
  /** @type {Set<string>} */ #stale = new Set();
  /** @type {Map<string, { token: string, expires: number }>} */ #cache = new Map();
  /** @type {Map<string, Promise<string>>} */ #inflight = new Map();
  /** Every value this instance has touched, in insertion order, for scrubbing. */
  /** @type {Set<string>} */ #known = new Set();

  /** @param {CredentialDeps} deps */
  constructor(deps) {
    if (!deps || typeof deps.fetchItem !== "function") throw new TypeError("Credentials needs fetchItem");
    this.#fetchItem = deps.fetchItem;
    this.#fetch = deps.fetch || globalThis.fetch;
    this.#now = deps.now || Date.now;
    this.#log = deps.log || (() => {});
    this.#save = deps.save;
  }

  /** Every value currently known: raw tokens, refresh tokens, keys, assertions, access tokens. */
  secrets() { return [...this.#known]; }

  /** Scrub a string of every known value. */
  scrub(text) { return scrub(text, this.secrets()); }

  /** Scrub every string in a JSON-able value of every known value. */
  scrubAll(v) { return scrubAll(v, this.secrets()); }

  /**
   * Headers for one HTTP call. With `url`, an oauth item that records the resource(s) its token was
   * minted for (a `resource` field, space separated; PLAN.md P21) is refused for any other target.
   * @param {Auth} auth @param {{ scopes?: string[], url?: string }} [opts] @returns {Promise<Record<string, string>>}
   */
  async headers(auth, opts = {}) {
    const type = auth?.type || "none";
    if (type === "none") return {};
    if (type === "bearer") {
      const a = /** @type {any} */ (auth);
      const value = await this.#item(a.item, a.field);
      const header = String(a.header || "authorization").toLowerCase();
      const format = isStr(a.format) ? a.format : "Bearer {value}";
      if (!format.includes("{value}")) throw new CredentialError("a bearer format needs {value}", { code: "config" });
      const out = format.split("{value}").join(value);
      if (/[\r\n]/.test(out)) throw new CredentialError(`vault item ${a.item} has a line break, which a header cannot carry`, { code: "config" });
      this.#remember(out);
      return { [header]: out };
    }
    if (type === "oauth" || type === "service-account") {
      if (type === "oauth" && opts.url) await this.#checkBound(/** @type {any} */ (auth), opts.url);
      return { authorization: `Bearer ${await this.token(auth, opts)}` };
    }
    throw new CredentialError(`unknown auth type ${String(type).slice(0, 40)}`, { code: "config" });
  }

  /**
   * An access token for an oauth or service-account auth, from the cache when it is still good.
   * @param {Auth} auth @param {{ scopes?: string[] }} [opts]
   */
  async token(auth, opts = {}) {
    const scopes = scopeList(opts.scopes);
    const key = this.#key(auth, scopes);
    const hit = this.#cache.get(key);
    if (hit && hit.expires - EARLY_MS > this.#now()) return hit.token;
    // Two calls that miss together share one mint, so a burst does not hammer the endpoint.
    const running = this.#inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const { token, expiresIn } = auth.type === "oauth"
        ? await this.#refresh(/** @type {any} */ (auth), scopes)
        : await this.#serviceAccount(/** @type {any} */ (auth), scopes);
      this.#cache.set(key, { token, expires: this.#now() + expiresIn * 1000 });
      this.#log("access token minted", { type: auth.type, item: auth.item, scopes, expiresIn });
      return token;
    })();
    this.#inflight.set(key, p);
    try { return await p; } finally { this.#inflight.delete(key); }
  }

  /** Drop a cached access token, so the next call mints a new one (after a 401). */
  invalidate(auth, scopes) {
    if (!auth || auth.type === "none" || auth.type === "bearer") return;
    if (auth.type === "oauth") this.#stale.add(auth.item);
    this.#cache.delete(this.#key(auth, scopeList(scopes)));
  }

  /**
   * Env vars for a stdio server's own process.
   * @param {Record<string, string | { item: string, field?: string }>} spec @returns {Promise<Record<string, string>>}
   */
  async env(spec) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [name, ref] of Object.entries(spec || {})) {
      if (!ENV_NAME.test(name)) throw new CredentialError(`${name.slice(0, 40)} is not an env var name`, { code: "config" });
      const r = isStr(ref) ? { item: ref } : ref;
      if (!r || !isStr(r.item)) throw new CredentialError(`${name} needs a vault item`, { code: "config" });
      out[name] = await this.#item(r.item, r.field);
    }
    return out;
  }

  /** Refuse an item's token for a url outside the resource(s) it was minted for. An item that records none is unbound. */
  async #checkBound(auth, url) {
    let recorded = "";
    try { recorded = await this.#fetchItem(auth.item, "resource"); } catch { return; }
    const list = isStr(recorded) ? recorded.split(/\s+/).filter(Boolean) : [];
    if (!list.length) return;
    let target;
    try { target = new URL(url); } catch { throw new CredentialError("the target address is not a valid url", { code: "bound" }); }
    const ok = list.some(r => {
      try { const b = new URL(r); return b.origin === target.origin && target.pathname.startsWith(b.pathname === "/" ? "/" : b.pathname.replace(/\/$/, "")); } catch { return false; }
    });
    if (!ok) throw new CredentialError(`the token in vault item ${auth.item} was minted for a different service and is not sent to ${target.origin}`, { code: "bound" });
  }

  #key(auth, scopes) {
    const a = /** @type {any} */ (auth);
    return JSON.stringify([a.type, a.item, a.field || "", a.subject || "", scopes]);
  }

  #remember(...values) {
    for (const v of values) {
      if (!isStr(v) || v.length < 4) continue;
      this.#known.delete(v);
      this.#known.add(v);
      // A PEM key's body lines are scrubbed one by one too, so a partial leak is still caught.
      if (v.includes("-----BEGIN")) for (const line of v.split(/\r?\n/)) if (line.length >= 16 && !line.startsWith("-----")) this.#known.add(line);
    }
    // Bounded, oldest first: a long-running vyred mints a token an hour per connection.
    while (this.#known.size > MAX_KNOWN) this.#known.delete(this.#known.values().next().value);
  }

  /** Fetch one vault value, remember it, and never let the vault's own error text through raw. */
  async #item(item, field) {
    if (!isStr(item) || !item) throw new CredentialError("auth needs a vault item", { code: "config" });
    let v;
    try { v = await this.#fetchItem(item, field); } catch (e) {
      const msg = scrub(String(/** @type {any} */ (e)?.message || e), this.secrets());
      throw new CredentialError(`vault item ${item} could not be fetched: ${msg}`, { code: "vault" });
    }
    if (!isStr(v) || !v) throw new CredentialError(`vault item ${item}${field ? ` field ${field}` : ""} is empty`, { code: "vault" });
    this.#remember(v);
    return v;
  }

  async #refresh(auth, scopes) {
    const fields = {};
    for (const f of ["client_id", "token_uri"]) fields[f] = await this.#item(auth.item, f);
    // A public client (dynamic registration) has no secret; a vendor may also send no refresh token
    // and rely on a long-lived access token, which the sign-in stored with its expiry.
    fields.client_secret = await this.#optional(auth.item, "client_secret");
    fields.refresh_token = this.#rotated.get(auth.item) || await this.#optional(auth.item, "refresh_token");
    // The token the sign-in just stored is used while it is good, so a fresh connection does not
    // spend (and, at a vendor that rotates, replace) its refresh token before it has to.
    if (!this.#stale.has(auth.item)) {
      const access = await this.#optional(auth.item, "access_token");
      const at = Number(await this.#optional(auth.item, "expires_at"));
      if (access && at && at - EARLY_MS > this.#now()) return { token: access, expiresIn: Math.floor((at - this.#now()) / 1000) };
      if (access && !at && !fields.refresh_token) return { token: access, expiresIn: 3600 };
    }
    if (!fields.refresh_token) {
      throw new CredentialError(`vault item ${auth.item} has no refresh token and its access token has ended; sign in again`, { code: "refused", oauthError: "invalid_grant" });
    }
    const uri = checkTokenUri(fields.token_uri, `vault item ${auth.item}`);
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: fields.client_id, refresh_token: fields.refresh_token });
    // A vendor that takes the client secret only in a Basic header says so at sign-in (token_auth).
    const basic = fields.client_secret && (await this.#optional(auth.item, "token_auth")) === "basic";
    if (fields.client_secret && !basic) body.set("client_secret", fields.client_secret);
    if (basic) this.#remember(Buffer.from(`${fields.client_id}:${fields.client_secret}`).toString("base64"));
    const out = await this.#exchange(uri, body, { scopes, what: `vault item ${auth.item}`,
      ...(basic ? { headers: { authorization: "Basic " + Buffer.from(`${fields.client_id}:${fields.client_secret}`).toString("base64") } } : {}) });
    this.#stale.delete(auth.item);
    // Many vendors rotate the refresh token on every use, so the new one replaces the old or the
    // next refresh fails. A rotation that cannot be saved is an error, never silent.
    if (out.refresh && out.refresh !== fields.refresh_token) {
      this.#rotated.set(auth.item, out.refresh);
      this.#remember(out.refresh);
      if (!this.#save) throw new CredentialError(`the vendor rotated the refresh token for ${auth.item} but nothing can save it`, { code: "config" });
      try { await this.#save(auth.item, { refresh_token: out.refresh, access_token: out.token, expires_at: String(this.#now() + out.expiresIn * 1000) }); }
      catch (e) { throw new CredentialError(`the new sign-in for ${auth.item} could not be saved: ${scrub(String(/** @type {any} */ (e)?.message || e), this.secrets())}`, { code: "vault" }); }
    }
    this.#rotated.delete(auth.item);
    return { token: out.token, expiresIn: out.expiresIn };
  }

  /** One vault field that may be absent: an empty string when it is not there. */
  async #optional(item, field) {
    try {
      const v = await this.#fetchItem(item, field);
      if (isStr(v) && v) { this.#remember(v); return v; }
    } catch {}
    return "";
  }

  async #serviceAccount(auth, scopes) {
    const raw = await this.#item(auth.item, auth.field);
    let key;
    // JSON.parse's message quotes the text it choked on, so its error never goes anywhere.
    try { key = JSON.parse(raw); } catch { key = null; }
    if (!key || !isStr(key.client_email) || !isStr(key.private_key)) {
      throw new CredentialError(`vault item ${auth.item} is not a service-account key (client_email, private_key)`, { code: "config" });
    }
    this.#remember(key.private_key);
    if (key.private_key_id) this.#remember(String(key.private_key_id));
    const uri = checkTokenUri(key.token_uri || "https://oauth2.googleapis.com/token", `vault item ${auth.item}`);
    if (!scopes.length) throw new CredentialError("a service-account token needs at least one scope", { code: "config" });
    const iat = Math.floor(this.#now() / 1000);
    const claims = { iss: key.client_email, scope: scopes.join(" "), aud: uri, iat, exp: iat + 3600 };
    if (auth.subject) claims.sub = auth.subject;
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    let sig;
    try { sig = crypto.sign("sha256", Buffer.from(unsigned), key.private_key).toString("base64url"); } catch {
      throw new CredentialError(`vault item ${auth.item} has a private key that cannot sign`, { code: "config" });
    }
    const assertion = `${unsigned}.${sig}`;
    this.#remember(assertion);
    const body = new URLSearchParams({ grant_type: JWT_BEARER, assertion });
    return this.#exchange(uri, body, { scopes, subject: auth.subject, what: `vault item ${auth.item}` });
  }

  /** POST to a token endpoint and read the access token, or throw a readable, scrubbed reason. */
  async #exchange(uri, body, { scopes, subject, what, headers = {} }) {
    let res;
    try {
      res = await this.#fetch(uri, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers }, body: body.toString() });
    } catch (e) {
      const why = /** @type {any} */ (e)?.name === "TimeoutError" ? "did not answer in 30 s" : "could not be reached";
      throw new CredentialError(`the token endpoint for ${what} ${why}`, { code: "network" });
    }
    const text = scrub(await res.text().catch(() => ""), this.secrets());
    if (res.status >= 300 && res.status < 400) {
      throw new CredentialError(`the token endpoint answered a redirect (${res.status}), which is refused`, { code: "redirect", status: res.status });
    }
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw refusal(res.status, json, text, scopes, subject);
    const token = json?.access_token;
    if (!isStr(token) || !token) throw new CredentialError(`the token endpoint for ${what} answered with no access token`, { code: "token", status: res.status });
    this.#remember(token);
    if (isStr(json.refresh_token)) this.#remember(json.refresh_token);
    const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
    return { token, expiresIn, refresh: isStr(json.refresh_token) ? json.refresh_token : "" };
  }
}

/** Turn a token-endpoint refusal into a sentence a person can act on. */
function refusal(status, json, text, scopes, subject) {
  const error = isStr(json?.error) ? json.error : "";
  const desc = isStr(json?.error_description) ? json.error_description : "";
  let msg = `the token endpoint answered ${status}: ${error || text.slice(0, 200) || "no reason given"}`;
  if (desc) msg += ` (${desc.slice(0, 300)})`;
  // Google sometimes names the scope it refused; otherwise all we know is what we asked for.
  const named = [...new Set((desc.match(/https:\/\/[^\s"',)]+/g) || []).filter(s => scopes.includes(s)))];
  const refused = named.length ? named : scopes;
  if (error === "unauthorized_client" && subject) {
    msg += `. This service account is not allowed to act as ${subject} with ${refused.join(", ") || "these scopes"}.` +
      " Allow those scopes for its client ID under domain-wide delegation in the Workspace admin console.";
  } else if (error === "unauthorized_client") {
    msg += `. This client is not allowed ${refused.join(", ") || "these scopes"}.`;
  } else if (error === "invalid_scope") {
    msg += `. Refused scope: ${refused.join(", ")}.`;
  } else if (error === "invalid_grant" && subject) {
    msg += `. The key was refused, or ${subject} is not a user this service account can act as.`;
  } else if (error === "invalid_grant") {
    msg += ". The refresh token or key is no longer accepted; put a fresh one in the vault.";
  }
  return new CredentialError(msg, { code: "refused", status, oauthError: error || undefined,
    scopes: error === "unauthorized_client" || error === "invalid_scope" ? refused : undefined });
}
