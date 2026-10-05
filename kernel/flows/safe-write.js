// @ts-check
// kernel/flows/safe-write.js: the pure parts of safe outside writes in the Flow runner's "Call a service" step. A connector's declaration (what the Connectors work defines; this file only
// READS it) says per operation which is a read, which is outward, whether the provider takes an idempotency key and where, and how to read a write back; and per connector how fast it may
// be called. Nothing here calls anything: the runner does, and keeps the ledger.
//
//   connector.ops   [{ name?, method, path, read?, outward?, idem?: { header } | { param }, readback?: { path, id, match } }]   path: `*` or `{x}` is one segment, a trailing `/*` the rest
//   connector.rate  { per_min }
//   readback        path: the read to make, `{id}` filled from the write's JSON answer at `id` (a dotted path); match: { <dotted path in the read's JSON>: <dotted path in the request body> }
import crypto from "node:crypto";

/** @param {string} pattern @param {string} pathname */
function pathMatch(pattern, pathname) {
  const rest = pattern.endsWith("/*");
  const pat = (rest ? pattern.slice(0, -2) : pattern).split("/"), got = pathname.split("/");
  if (rest ? got.length < pat.length : got.length !== pat.length) return false;
  return pat.every((seg, i) => seg === "*" || /^\{[A-Za-z0-9_]+\}$/.test(seg) || seg === got[i]);
}

/** The connector's declared operation for a request, or null (an undeclared one keeps the old behaviour: the route rules decide, the vault dedupes). @param {any} conn @param {string} method @param {string} path */
export function opFor(conn, method, path) {
  const ops = conn && conn.ops;
  const list = Array.isArray(ops) ? ops : ops && typeof ops === "object" ? Object.entries(ops).map(([name, o]) => ({ name, .../** @type {any} */ (o) })) : [];
  return list.find(o => o && typeof o.path === "string" && String(o.method || "GET").toUpperCase() === method && pathMatch(o.path, path)) || null;
}

/** True when the connector says anything about how to call it safely. @param {any} conn */
export const isDeclared = conn => Boolean(conn && (conn.ops || conn.rate));

/** The provider's idempotency key for one write: opaque, stable for the run and step, never the run id. @param {string} idem */
export const providerKey = idem => `vyre-${crypto.createHash("sha256").update(idem).digest("hex").slice(0, 32)}`;

/** Where the key goes in the request, as the declaration says. @param {any} op @param {string} key @returns {{ headers?: Record<string, string>, query?: Record<string, string> }} */
export function keyPlacement(op, key) {
  const i = op && op.idem;
  if (!i || typeof i !== "object") return {};
  if (typeof i.header === "string" && i.header) return { headers: { [i.header]: key } };
  if (typeof i.param === "string" && i.param) return { query: { [i.param]: key } };
  return {};
}

/** @param {any} v @param {string} path */
export function getPath(v, path) {
  let cur = v;
  for (const k of String(path).split(".")) { if (cur === null || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}

/** The path to read a write back from, filled from the write's JSON answer; null when the answer does not carry the id. @param {any} rb @param {any} json */
export function readbackPath(rb, json) {
  const id = getPath(json, String(rb.id));
  if (typeof id !== "string" && typeof id !== "number") return null;
  return String(rb.path).replace(/\{id\}/g, encodeURIComponent(String(id)));
}

/** Compare the fields the declaration pairs. @param {any} rb @param {any} written the request body @param {any} read the read's JSON @returns {{ ok: boolean, diffs: string[] }} */
export function compareReadback(rb, written, read) {
  /** @type {string[]} */ const diffs = [];
  for (const [readAt, wroteAt] of Object.entries(rb.match || {})) {
    const want = getPath(written, String(wroteAt)), got = getPath(read, readAt);
    if (JSON.stringify(want) !== JSON.stringify(got) && String(want) !== String(got)) diffs.push(readAt);
  }
  return { ok: diffs.length === 0, diffs };
}

/** Milliseconds a provider's Retry-After asks for (seconds or an HTTP date), or null. @param {Record<string, string> | undefined} headers @param {number} now */
export function retryAfterMs(headers, now) {
  const raw = headers && (headers["retry-after"] ?? headers["Retry-After"]);
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n * 1000), 3_600_000);
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? Math.min(Math.max(0, t - now), 3_600_000) : null;
}

/** A per-connector limiter from the declared `rate.per_min`: how long to wait before the next call, and a call noted. In memory (a restart forgets it; the provider's Retry-After backs it up). */
export class ConnectorRate {
  constructor() { /** @type {Map<string, number[]>} */ this.calls = new Map(); }
  /** @param {string} connector @param {any} rate @param {number} now @returns {number} ms to wait, 0 when a call may go now */
  wait(connector, rate, now) {
    const max = rate && Number.isInteger(rate.per_min) && rate.per_min > 0 ? rate.per_min : 0;
    if (!max) return 0;
    const stamps = (this.calls.get(connector) || []).filter(t => now - t < 60_000);
    this.calls.set(connector, stamps);
    return stamps.length < max ? 0 : stamps[stamps.length - max] + 60_000 - now;
  }
  /** @param {string} connector @param {number} now */
  note(connector, now) { const s = this.calls.get(connector) || []; s.push(now); this.calls.set(connector, s); }
}
