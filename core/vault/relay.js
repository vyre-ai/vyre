// @ts-check
// relay: the transport and the pure checks behind a relayed pass (ADR 0001, decision 7).
//
// A relayed pass lets a holder use an owner's credential without ever receiving it. The holder's
// vyred signs a request envelope and posts it to the owner's relay listener; the owner checks the
// signature, the clock, the nonce and the destination, adds the value, sends the request and
// scrubs the value from what comes back. This file holds the parts of that path that need no
// pass database: encoding cards and tickets, signing and checking envelopes, the host allowlist,
// placeholder substitution, scrubbing, the outbound send and the listener itself. The vault
// module supplies pass lookup through the onRelay callback, so every check here stays testable
// on its own.
//
// Rules this file enforces, and why:
// - A placeholder in a URL is refused. A value in a URL lands in access logs and proxies.
// - Redirects are never followed. A redirect would carry the credential to a host nobody allowed.
// - Origins match exactly, scheme, host and port. A wildcard is a way to reach a host you control.
// - Responses are scrubbed of the value and of its base64 and URL-encoded forms, since servers
//   echo what they are sent.

import crypto from "node:crypto";
import http from "node:http";
import { sign, verify, canonical } from "./crypto.js";

const CARD_PREFIX = "vyre-card:v1:";
const TICKET_PREFIX = "vyre-pass:v1:";
const CONCEALED = "<concealed by vyre>";
const SKEW_MS = 60_000;
const SEEN_TTL_MS = 120_000;

const isStr = v => typeof v === "string" && v.length > 0;
const b64url = s => Buffer.from(s, "utf8").toString("base64url");

function unwrap(str, prefix, what) {
  if (typeof str !== "string") throw new Error(`a ${what} must be a string`);
  const s = str.trim();
  if (!s.startsWith(prefix)) throw new Error(`not a ${what}: it should start with "${prefix}"`);
  const rest = s.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) throw new Error(`this ${what} is damaged: the part after "${prefix}" is not base64url`);
  let obj;
  try { obj = JSON.parse(Buffer.from(rest, "base64url").toString("utf8")); }
  catch { throw new Error(`this ${what} is damaged: its contents are not JSON`); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`this ${what} is damaged: its contents are not an object`);
  return obj;
}

/** @typedef {{ name: string, sign: string, box: string, relay: string }} Card */

/** @param {any} c @returns {Card} */
function checkCard(c) {
  // relay may be empty: a Vyre with no relay listener can still receive sealed passes.
  for (const k of ["name", "sign", "box"]) if (!isStr(c?.[k])) throw new Error(`card is missing "${k}"`);
  if (typeof c.relay !== "string") throw new Error(`card is missing "relay"`);
  return { name: c.name, sign: c.sign, box: c.box, relay: c.relay };
}

/** A person's public card: `vyre-card:v1:` + base64url(canonical JSON). Carries no secret. @param {Card} obj */
export const encodeCard = obj => CARD_PREFIX + b64url(canonical(checkCard(obj)));

/** Read a card back. Throws a readable error on a wrong prefix or a malformed body. @param {string} str @returns {Card} */
export const decodeCard = str => checkCard(unwrap(str, CARD_PREFIX, "Vyre card"));

/**
 * @typedef {{ pass: string, owner: string, relay: string, ownerSign: string, holder: string,
 *   items: string[], mode: "relayed"|"sealed", expires: number|null, sealed?: Record<string, any> }} Ticket
 */

/** @param {any} t @returns {Ticket} */
function checkTicket(t) {
  for (const k of ["pass", "owner", "ownerSign", "holder"]) if (!isStr(t?.[k])) throw new Error(`pass ticket is missing "${k}"`);
  if (typeof t.relay !== "string" || (t.mode === "relayed" && !t.relay)) throw new Error(`pass ticket is missing "relay"`);
  if (!Array.isArray(t.items) || !t.items.length || !t.items.every(isStr)) throw new Error("pass ticket needs a non-empty list of item names");
  if (t.mode !== "relayed" && t.mode !== "sealed") throw new Error(`pass ticket mode must be "relayed" or "sealed"`);
  if (t.expires !== null && !(typeof t.expires === "number" && Number.isFinite(t.expires))) throw new Error("pass ticket expires must be a time in ms or null");
  /** @type {Ticket} */
  const out = { pass: t.pass, owner: t.owner, relay: t.relay, ownerSign: t.ownerSign, holder: t.holder, items: [...t.items], mode: t.mode, expires: t.expires };
  if (t.mode === "sealed") {
    if (!t.sealed || typeof t.sealed !== "object" || Array.isArray(t.sealed)) throw new Error("a sealed pass ticket must carry its sealed items");
    for (const item of t.items) if (!t.sealed[item] || typeof t.sealed[item] !== "object") throw new Error(`sealed pass ticket is missing item "${item}"`);
    out.sealed = t.sealed;
  } else if (t.sealed !== undefined) throw new Error("a relayed pass ticket carries no sealed items");
  return out;
}

/** A pass ticket: `vyre-pass:v1:` + base64url(canonical JSON). @param {Ticket} obj */
export const encodeTicket = obj => TICKET_PREFIX + b64url(canonical(checkTicket(obj)));

/** Read a ticket back. Throws a readable error on a wrong prefix or a malformed body. @param {string} str @returns {Ticket} */
export const decodeTicket = str => checkTicket(unwrap(str, TICKET_PREFIX, "pass ticket"));

/**
 * @typedef {{ method?: string, url: string, headers?: Record<string, string>, body?: string }} RelayRequest
 * @typedef {{ pass: string, item: string, request: RelayRequest, ts: number, nonce: string, sig: string }} Envelope
 */

/**
 * Sign a relay request with the holder's device key.
 * @param {{ pass: string, item: string, request: RelayRequest, privDer: string, now?: number }} a
 * @returns {Envelope}
 */
export function envelope({ pass, item, request, privDer, now = Date.now() }) {
  const signed = { pass, item, request, ts: now, nonce: crypto.randomBytes(16).toString("base64url") };
  return { ...signed, sig: sign(privDer, signed) };
}

/**
 * Check an envelope against the pass's holder key. Returns null when valid, otherwise a short
 * reason. A valid nonce is recorded in `seen` (nonce -> ts); entries older than 120 s are dropped,
 * which is safe because a timestamp that old already fails the 60 s window.
 * @param {any} env
 * @param {{ holderKey: string, now?: number, seen: Map<string, number> }} o
 * @returns {string|null}
 */
export function checkEnvelope(env, { holderKey, now = Date.now(), seen }) {
  for (const [nonce, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(nonce);
  if (!env || typeof env !== "object" || !isStr(env.pass) || !isStr(env.item) || !isStr(env.nonce) || !isStr(env.sig)
    || typeof env.ts !== "number" || !env.request || typeof env.request !== "object" || !isStr(env.request.url)) return "malformed envelope";
  const { pass, item, request, ts, nonce, sig } = env;
  if (!verify(holderKey, { pass, item, request, ts, nonce }, sig)) return "bad signature";
  if (Math.abs(now - ts) > SKEW_MS) return "timestamp outside 60 s window";
  if (seen.has(nonce)) return "replayed nonce";
  seen.set(nonce, ts);
  return null;
}

/**
 * True only when `url` is http or https and its origin equals one of `hosts` exactly (scheme,
 * host and port). No wildcards. Each host is an origin string like "https://api.example.com".
 * @param {string} url @param {string[]} hosts
 */
export function allowedOrigin(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  for (const h of hosts || []) {
    try { if (new URL(h).origin === u.origin) return true; } catch {}
  }
  return false;
}

const PLACEHOLDER = /\{\{\s*vault(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*vault(?:\.[A-Za-z0-9_-]+)?\s*\}\}/;

/**
 * Put an item's field values into a request's header values and body. `{{vault}}` means the
 * default field, `{{vault.<field>}}` a named one. A placeholder in the URL or a header name is
 * refused, and so is an unknown field. Returns a new request and the values used, for scrubbing.
 * @param {RelayRequest} request @param {Record<string, string>} fields @param {string} defaultField
 * @returns {{ request: RelayRequest, values: string[] }}
 */
export function substitute(request, fields, defaultField) {
  if (!request || typeof request.url !== "string") throw new Error("request needs a url");
  if (HAS_PLACEHOLDER.test(request.url)) throw new Error("a vault placeholder cannot go in the url: a value there ends up in access logs. Put it in a header or the body");
  const values = new Set();
  const fill = s => String(s).replace(PLACEHOLDER, (_, field) => {
    const name = field || defaultField;
    const v = fields?.[name];
    if (typeof v !== "string") throw new Error(`this item has no field "${name}"`);
    values.add(v);
    return v;
  });
  /** @type {RelayRequest} */
  const out = { ...request };
  if (request.headers) {
    out.headers = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (HAS_PLACEHOLDER.test(k)) throw new Error("a vault placeholder cannot go in a header name");
      out.headers[k] = fill(v);
    }
  }
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body !== "string") throw new Error("request body must be a string");
    out.body = fill(request.body);
  }
  return { request: out, values: [...values] };
}

/**
 * Replace every occurrence of each value, and of its base64, base64url and URL-encoded forms,
 * with a marker. Values shorter than 4 characters are skipped: scrubbing them would shred text.
 * @param {string} text @param {string[]} values
 */
export function scrub(text, values) {
  let out = String(text ?? "");
  const forms = new Set();
  for (const v of values || []) {
    if (typeof v !== "string" || v.length < 4) continue;
    const b = Buffer.from(v, "utf8");
    for (const f of [v, b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+")]) {
      if (f.length >= 4) forms.add(f);
    }
  }
  // Longest first, so a form that contains another is replaced whole.
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(CONCEALED);
  return out;
}

/**
 * Send a request the way a relay must: redirects off, a timeout, and a cap on the response size.
 * @param {RelayRequest} request
 * @param {{ timeoutMs?: number, maxBytes?: number }} [o]
 * @returns {Promise<{ status: number, headers: { "content-type"?: string, location?: string }, body: string }>}
 */
export async function send(request, { timeoutMs = 30000, maxBytes = 5_000_000 } = {}) {
  let u;
  try { u = new URL(request.url); } catch { throw new Error("request url is not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("request url must be http or https");
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    const res = await fetch(u, { method: (request.method || "GET").toUpperCase(), headers: request.headers, body: request.body ?? undefined, redirect: "manual", signal: ctl.signal });
    /** @type {{ "content-type"?: string, location?: string }} */
    const headers = {};
    const ct = res.headers.get("content-type"); if (ct) headers["content-type"] = ct;
    const loc = res.headers.get("location"); if (loc) headers.location = loc;
    let body = "", size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          ctl.abort();
          await reader.cancel().catch(() => {});
          throw new Error(`response is larger than ${maxBytes} bytes`);
        }
        body += dec.decode(value, { stream: true });
      }
      body += dec.decode();
    }
    return { status: res.status, headers, body };
  } catch (e) {
    if (timedOut) throw new Error(`no response within ${timeoutMs} ms`);
    throw e;
  } finally { clearTimeout(timer); }
}

const MAX_BODY = 6 * 1024 * 1024;

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "request body is over 6 MB");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "bad_input", "request body is not JSON"); }
}

/**
 * Start the relay listener. One route, `POST /v1/relay`; everything else is 404.
 * @param {{ host?: string, port?: number, onRelay: (env: any, meta: { remoteAddress?: string }) => Promise<{ status: number, body: any }> }} o
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serve({ host = "127.0.0.1", port = 0, onRelay }) {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url || "/", "http://relay").pathname;
      if (req.method !== "POST" || path !== "/v1/relay") return reply(res, 404, { error: { code: "not_found", message: `${req.method} ${path}` } });
      const env = await readJson(req);
      const out = await onRelay(env, { remoteAddress: req.socket.remoteAddress });
      reply(res, out?.status || 200, out?.body ?? {});
    } catch (e) {
      if (e instanceof HttpError) return reply(res, e.status, { error: { code: e.code, message: e.message } });
      if (!res.headersSent) reply(res, 500, { error: { code: "internal", message: e?.message || String(e) } });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(undefined)); });
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${h}:${addr.port}`,
    close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }),
  };
}

/**
 * Post an envelope to an owner's relay listener. Returns the parsed `{data}` or `{error}`, or an
 * `unreachable` error when the owner's box does not answer.
 * @param {string} relayUrl @param {Envelope} env @param {{ timeoutMs?: number }} [o]
 * @returns {Promise<any>}
 */
export async function callRelay(relayUrl, env, { timeoutMs = 45000 } = {}) {
  let res;
  const target = new URL("/v1/relay", relayUrl);
  try {
    res = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e?.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : (e?.cause?.code || e?.message || "connection failed");
    return { error: { code: "unreachable", message: `the owner's Vyre at ${target.origin} did not answer (${why})` } };
  }
  let text;
  try { text = await res.text(); } catch (e) { return { error: { code: "unreachable", message: `the owner's Vyre stopped mid-reply (${e?.message})` } }; }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && ("data" in parsed || "error" in parsed)) return parsed;
  } catch {}
  return { error: { code: "bad_response", message: `the owner's Vyre answered ${res.status} with something that is not a relay reply` } };
}
