// @ts-check
// http: the ONE guarded client for requests that leave the machine (consolidation inventory item 10). Everything that calls a service on the internet (GitHub, Google, Slack, the update server, a
// certificate authority, the name directory, a voice or model provider ...) goes through `httpFetch`, so the rules are written once:
//
//   - the address: the host is resolved HERE, every answer must be a public address (lib/netguard.js), and the connection is made to the address that was checked, with the name kept for TLS and the
//     Host header. A name that resolves differently a moment later (DNS rebinding) changes nothing; the connected socket's remote address is checked again before a byte is written.
//   - https only (and no user:password in the URL). `allow: "any"` lifts the address rule for a caller that is given an address by the person (their own S3 endpoint, an MCP server) and then checks it
//     itself; plain http needs `allow: "any"` too. `allow: "auto"` is "public, except this machine" for an endpoint a configuration or a test may point at loopback. A caller that talks to something ON this machine does not belong here: it uses http.request on a socket or loopback, and says so.
//   - time: every request has a deadline (30 s unless asked), and an `AbortSignal` of the caller's is honoured.
//   - size: a body over `maxBytes` (4 MB unless asked) is refused while it streams, not after it is in memory.
//   - redirects: followed at most `maxRedirects` (3) times, each hop https and re-checked as a new address, and the Authorization and Cookie headers are dropped when the origin changes.
//     `redirect: "manual"` returns the 3xx as it is; `"error"` refuses one.
//   - retry: `retries` (2 for GET, HEAD, OPTIONS, PUT and DELETE, which are idempotent; 0 for anything else unless the caller says `idempotent: true`, e.g. it sent an idempotency key) with backoff
//     of 250 ms doubling, a `Retry-After` honoured up to 5 s, on a network error, a timeout, 408, 425, 429, 500, 502, 503 and 504. A POST is never retried on its own.
//
// It answers with a standard `Response`. A test that replaces `globalThis.fetch` (the whole repo's stand-in habit) is honoured: when the global is not the one Node started with, the request goes
// to it, after the same URL and https rules, but without resolving a name (there is no network to protect); a stand-in's plain-object answer is handed back as it is.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { resolvePublic, isLoopbackHost } from "./netguard.js";

const NATIVE_FETCH = globalThis.fetch;
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "timeout"]);
const DEFAULTS = Object.freeze({ timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024, maxRedirects: 3, backoffMs: 250, retryAfterMaxMs: 5_000 });

/** A refusal or failure of the guarded client: `code` is one of bad_url, not_https, credentials_in_url, not_public, too_large, too_many_redirects, redirect_refused, timeout, network. */
export class HttpError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) { super(message); this.name = "HttpError"; this.code = code; if (cause !== undefined) this.cause = cause; }
}

/**
 * @typedef {RequestInit & {
 *   timeoutMs?: number, maxBytes?: number, maxRedirects?: number, retries?: number, idempotent?: boolean, backoffMs?: number,
 *   allow?: "public" | "auto" | "any", lookup?: (host: string) => Promise<{ address: string }[]>, sleep?: (ms: number) => Promise<void>,
 * }} HttpInit
 */

const sleepReal = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** The body as bytes a retry can send again, or undefined. FormData and URLSearchParams are encoded through Response, which also gives their content type. */
async function bodyOf(/** @type {any} */ body, /** @type {Headers} */ headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  const r = new Response(body);
  const type = r.headers.get("content-type");
  if (type && !headers.has("content-type")) headers.set("content-type", type);
  return Buffer.from(await r.arrayBuffer());
}

/** Merge the caller's signal with the deadline. @param {AbortSignal | null | undefined} signal @param {number} ms */
function deadline(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/**
 * One request to a checked address and nothing else: no redirect, no retry. The connection goes to `address`; the socket is checked once more before the request is written.
 * @param {URL} u @param {{ method: string, headers: Headers, body?: Buffer, signal: AbortSignal, address: string | null, maxBytes: number, stream?: boolean, request?: typeof https.request }} o
 * @returns {Promise<Response>}
 */
export function requestOnce(u, { method, headers, body, signal, address, maxBytes, stream = false, request }) {
  const mod = u.protocol === "https:" ? https : http;
  const family = address ? net.isIP(address) : 0;
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const hs = Object.fromEntries(headers.entries());
    if (body && !headers.has("content-length")) hs["content-length"] = String(body.length);
    const req = (request || mod.request)({
      protocol: u.protocol, hostname: bare, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers: hs, signal, agent: false,
      servername: net.isIP(bare) ? undefined : bare,
      ...(address ? { lookup: (/** @type {string} */ _h, /** @type {any} */ o, /** @type {any} */ cb) => (o && o.all ? cb(null, [{ address, family }]) : cb(null, address, family)) } : {}),
    }, res => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const status = res.statusCode || 0;
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); req.destroy(); reject(new HttpError("too_large", `the answer is ${declared} bytes, over the ${maxBytes}-byte limit`)); return; }
      let seen = 0;
      const guard = new Readable({ read() {} });
      res.on("data", (/** @type {Buffer} */ c) => {
        seen += c.length;
        if (seen > maxBytes) { const e = new HttpError("too_large", `the answer is over the ${maxBytes}-byte limit`); res.destroy(); guard.destroy(e); if (!stream) reject(e); return; }
        guard.push(c);
      });
      res.on("end", () => guard.push(null));
      res.on("error", e => { guard.destroy(e); if (!stream) reject(e); });
      const empty = status === 204 || status === 304 || method === "HEAD";
      if (stream && !empty) { resolve(new Response(/** @type {any} */ (Readable.toWeb(guard)), { status, headers: out })); return; }
      if (empty) { res.resume(); resolve(new Response(null, { status, headers: out })); return; }
      const chunks = /** @type {Buffer[]} */ ([]);
      guard.on("data", c => chunks.push(c));
      guard.on("end", () => resolve(new Response(Buffer.concat(chunks), { status, headers: out })));
      guard.on("error", reject);
    });
    // The socket that actually connected must be the address that was checked, whatever resolved it.
    if (address) req.on("socket", (/** @type {any} */ sock) => {
      const check = () => { const r = sock.remoteAddress; if (r && r !== address && r.replace(/^::ffff:/, "") !== address) req.destroy(new HttpError("not_public", "the connection went to an address that was not checked")); };
      if (sock.connecting) sock.once("connect", check); else check();
    });
    req.on("error", e => reject(e instanceof HttpError ? e : (/** @type {any} */ (e)).name === "AbortError" || signal.aborted ? new HttpError("timeout", "the request ran out of time", e) : new HttpError("network", String((/** @type {any} */ (e)).message || e), e)));
    if (body) req.write(body);
    req.end();
  });
}

/** What the `allow` option means for this URL: "auto" lets a loopback address through (a configured or test endpoint on this machine) and holds every other to the public rule. @param {URL} u @param {HttpInit} init */
const allowHere = (u, init) => (init.allow === "any" || (init.allow === "auto" && isLoopbackHost(u.hostname.replace(/^\[|\]$/g, ""))) ? "any" : "public");

/**
 * The address to connect to for this URL, or a refusal. `allow: "public"` (the default) needs every answer to be a public address.
 * @param {URL} u @param {HttpInit} init @returns {Promise<string | null>}
 */
async function pin(u, init) {
  if (u.username || u.password) throw new HttpError("credentials_in_url", "a request URL may not carry a user name or password");
  if (allowHere(u, init) === "any") return null;
  if (u.protocol !== "https:") throw new HttpError("not_https", "only https leaves the machine");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  try { return await resolvePublic(host, init.lookup ? { lookup: init.lookup } : {}); }
  catch (e) { throw new HttpError("not_public", `${host} is not a public address`, e); }
}

/** @param {number} n @param {number} base */
const backoff = (n, base) => base * 2 ** n + Math.floor(Math.random() * base / 2);

/**
 * fetch, guarded. See the top of this file for the rules. `init` is the usual RequestInit plus the options named there.
 * @param {string | URL} input @param {HttpInit} [init] @returns {Promise<Response>}
 */
export async function httpFetch(input, init = {}) {
  const sleep = init.sleep || sleepReal;
  const method = String(init.method || "GET").toUpperCase();
  const retries = init.retries ?? (IDEMPOTENT.has(method) || init.idempotent ? 2 : 0);
  const timeoutMs = init.timeoutMs ?? DEFAULTS.timeoutMs, maxBytes = init.maxBytes ?? DEFAULTS.maxBytes, maxRedirects = init.maxRedirects ?? DEFAULTS.maxRedirects;
  let url;
  try { url = new URL(String(input)); } catch (e) { throw new HttpError("bad_url", "not a URL", e); }
  const headers = new Headers(init.headers || {});
  const body = await bodyOf(init.body, headers);
  const standIn = globalThis.fetch !== NATIVE_FETCH;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const signal = deadline(init.signal, timeoutMs);
      let current = url, hops = 0, hdrs = new Headers(headers), m = method, b = body;
      for (;;) {
        let res;
        if (standIn) {
          if (current.username || current.password) throw new HttpError("credentials_in_url", "a request URL may not carry a user name or password");
          if (allowHere(current, init) !== "any" && current.protocol !== "https:") throw new HttpError("not_https", "only https leaves the machine");
          res = await globalThis.fetch(current.toString(), { method: m, headers: hops === 0 && init.headers ? init.headers : hdrs, ...(hops === 0 && init.body !== undefined && init.body !== null ? { body: init.body } : b !== undefined ? { body: b } : {}), redirect: "manual", signal });
        } else {
          const address = await pin(current, init);
          res = await requestOnce(current, { method: m, headers: hdrs, body: b, signal, address, maxBytes, stream: false });
        }
        // A stand-in that answers with a plain object (ok, status, json) is a test's own business: it is handed back as it is.
        if (standIn && !(res instanceof Response)) return res;
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc && init.redirect !== "manual") {
          if (init.redirect === "error") throw new HttpError("redirect_refused", "the server redirected and redirects are refused here");
          if (++hops > maxRedirects) throw new HttpError("too_many_redirects", `more than ${maxRedirects} redirects`);
          const next = new URL(loc, current);
          if (current.protocol === "https:" && next.protocol !== "https:") throw new HttpError("redirect_refused", "a redirect from https to plain http is refused");
          if (next.origin !== current.origin) { hdrs = new Headers(hdrs); hdrs.delete("authorization"); hdrs.delete("cookie"); hdrs.delete("proxy-authorization"); }
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === "POST")) { m = m === "HEAD" ? "HEAD" : "GET"; b = undefined; hdrs.delete("content-type"); hdrs.delete("content-length"); }
          current = next;
          continue;
        }
        if (standIn) {
          // A stand-in answers however it likes; the size rule still holds for what it hands back.
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) throw new HttpError("too_large", `the answer is over the ${maxBytes}-byte limit`);
          res = new Response([204, 304].includes(res.status) || m === "HEAD" ? null : buf, { status: res.status, headers: res.headers });
        }
        if (RETRY_STATUS.has(res.status) && attempt < retries) {
          const ra = Number(res.headers.get("retry-after"));
          lastErr = new HttpError("network", `the server answered ${res.status}`);
          await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt, init.backoffMs ?? DEFAULTS.backoffMs), DEFAULTS.retryAfterMaxMs));
          break;
        }
        return res;
      }
    } catch (e) {
      lastErr = e;
      const code = e instanceof HttpError ? e.code : /** @type {any} */ (e)?.code;
      const again = attempt < retries && (code === "network" || code === "timeout" || RETRY_CODES.has(String(code)));
      if (!again) throw e;
      await sleep(backoff(attempt, init.backoffMs ?? DEFAULTS.backoffMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError("network", "the request failed");
}

/** `allow` for a URL a configuration or a test may point at this machine: loopback is "any", everything else "public". @param {string | URL} url */
export const allowFor = url => { try { return isLoopbackHost(new URL(String(url)).hostname.replace(/^\[|\]$/g, "")) ? /** @type {const} */ ("any") : /** @type {const} */ ("public"); } catch { return /** @type {const} */ ("public"); } };

/** A `fetch`-shaped function with fixed options (a timeout, a size cap, an allow rule) for a module to hand to code that takes `deps.fetch`. @param {HttpInit} [defaults] @returns {typeof globalThis.fetch} */
export const guardedFetch = (defaults = {}) => /** @type {any} */ ((input, init) => httpFetch(/** @type {any} */ (input), { ...defaults, ...(init || {}) }));


/** For an address the person typed or configured (their own server, an MCP server, an S3 endpoint): every rule but the public-address one, since the address is theirs to choose and the caller checks it. */
export const userHostFetch = guardedFetch({ allow: "any" });

/** For a public service whose address a configuration or a test may point at this machine: public, except loopback. */
export const autoFetch = guardedFetch({ allow: "auto" });
