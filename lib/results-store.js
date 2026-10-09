// @ts-check
// lib/results-store: results by reference (R031-00p). A big tool result is kept at home and the model gets a handle and a short summary; it reads the slice it needs with results_read.
//
// What this holds, and the rules it keeps (lead ruling 9 Oct, conditions 1):
//   - exactly what the caller was already given by the tool: the store sits behind the call, so grants, reach and redaction have already cut the answer; a sealed field arrived as a placeholder and stays one;
//   - memory only, never a file: a restart drops every handle, and so does the time limit (30 minutes) or the size limit (64 MB per owner, oldest out first);
//   - a handle belongs to the identity that made the call. Another owner is told "not_found", the same words as a handle that never was, so nothing says that it exists;
//   - 128 bits of randomness in the handle; it is the only thing about a result that goes into a transcript.
// It is a cache of an answer, not a place to keep items: a later call can fetch the same thing again.
// Pure but for the clock and the random source, which are injected so a test is exact.

import crypto from "node:crypto";
import { tokens } from "./tokens.js";
import { parse, evaluate } from "../kernel/flows/expr.js";

export const LIMITS = Object.freeze({
  /** A result over this many tokens (lib/tokens.js) goes by reference. */
  threshold: 2000,
  ttlMs: 30 * 60 * 1000,
  /** Bytes of stored results per owner. */
  maxBytes: 64 * 1024 * 1024,
  /** What one results_read gives back at most, in tokens: a slice is never again a large result. */
  sliceTokens: 3000,
  /** Items a results_read pages by default and at most. */
  defaultItems: 20, maxItems: 200,
  /** Characters of a text a results_read gives by default and at most. */
  defaultChars: 4000, maxChars: 12000,
});

/** @param {unknown} v @param {number} [n] */
const cut = (v, n = 80) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "..." : s; };
/** @param {any} v @returns {string} */
const kind = (v) => (v === null ? "null" : Array.isArray(v) ? `array(${v.length})${v.length ? " of " + kind(v[0]).replace(/\(.*$/, "") : ""}` : typeof v);

/**
 * A short, deterministic description of a value, made without a model: its type and size, the shape one level down, and the first three items cut short.
 * @param {any} v
 */
export function summarize(v) {
  if (typeof v === "string") return { type: "string", length: v.length, head: v.slice(0, 300) };
  if (Array.isArray(v)) return { type: `array(${v.length})`, head: v.slice(0, 3).map(headItem) };
  if (v && typeof v === "object") {
    const keys = Object.fromEntries(Object.keys(v).slice(0, 40).map((k) => [k, kind(v[k])]));
    // the largest list in it is what the reader wants a taste of
    const lists = Object.entries(v).filter(([, x]) => Array.isArray(x)).sort((a, b) => b[1].length - a[1].length);
    const head = lists.length ? { in: lists[0][0], items: lists[0][1].slice(0, 3).map(headItem) } : Object.fromEntries(Object.entries(v).filter(([, x]) => x === null || typeof x !== "object").slice(0, 8).map(([k, x]) => [k, typeof x === "string" ? cut(x) : x]));
    return { type: "object", keys, head };
  }
  return { type: kind(v), value: v };
}
/** @param {any} item */
function headItem(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).slice(0, 12).map(([k, x]) => [k, x === null || typeof x === "number" || typeof x === "boolean" ? x : cut(x)]));
  return typeof item === "string" ? cut(item) : item;
}

/** Tokens a value costs the model when it is sent as JSON. @param {any} v */
export const costOf = (v) => tokens(typeof v === "string" ? v : JSON.stringify(v) ?? "null");

/**
 * @param {{ now?: () => number, random?: (n: number) => Buffer, ttlMs?: number, maxBytes?: number, threshold?: number }} [o]
 */
export function createStore(o = {}) {
  const now = o.now || Date.now, random = o.random || crypto.randomBytes;
  const ttlMs = o.ttlMs ?? LIMITS.ttlMs, maxBytes = o.maxBytes ?? LIMITS.maxBytes, threshold = o.threshold ?? LIMITS.threshold;
  /** @type {Map<string, { owner: string, value: any, bytes: number, tokens: number, at: number }>} */
  const rows = new Map();
  const expire = () => { const t = now(); for (const [h, r] of rows) if (t - r.at >= ttlMs) rows.delete(h); };
  const used = (/** @type {string} */ owner) => { let n = 0; for (const r of rows.values()) if (r.owner === owner) n += r.bytes; return n; };

  /** @param {string} owner @param {any} value @returns {{ handle: string, tokens: number, expires_in: number, summary: any }} */
  function put(owner, value) {
    expire();
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "null");
    if (bytes > maxBytes) throw Object.assign(new Error("a result larger than the store holds is not kept; ask for less"), { code: "too_large" });
    // oldest first out, for this owner only
    for (const [h, r] of rows) { if (used(owner) + bytes <= maxBytes) break; if (r.owner === owner) rows.delete(h); }
    const handle = "r_" + random(16).toString("base64url");
    rows.set(handle, { owner, value, bytes, tokens: costOf(value), at: now() });
    return { handle, tokens: rows.get(handle)?.tokens ?? 0, expires_in: Math.floor(ttlMs / 1000), summary: summarize(value) };
  }

  /** The row for this owner, or null: the same for a handle that is not here, that ran out and that belongs to someone else. @param {string} owner @param {unknown} handle */
  const row = (owner, handle) => { expire(); const r = typeof handle === "string" ? rows.get(handle) : undefined; return r && r.owner === owner ? r : null; };

  /**
   * What goes to the model for a tool result: the value itself when it is small, a handle and a summary when it is large.
   * @param {string} owner @param {any} value @param {{ always?: boolean }} [opt]
   */
  function shape(owner, value, opt = {}) {
    if (!opt.always && costOf(value) <= threshold) return { value };
    try { return { ref: put(owner, value) }; } catch (e) { return { value, error: /** @type {Error} */ (e).message }; }
  }

  /**
   * Read part of a stored result. `select` is a path in the expression language's own member syntax (rows, rows[0].name; `value` for a result that is a list or text); a list pages with offset
   * and limit; a text pages by characters. What comes back is capped, so a slice is never again a large result.
   * @param {string} owner @param {{ handle?: unknown, select?: unknown, offset?: unknown, limit?: unknown }} q
   * @returns {{ data: any } | { error: { code: string, message: string } }}
   */
  function read(owner, q) {
    const r = row(owner, q.handle);
    if (!r) return { error: { code: "not_found", message: "no such result: it may have expired, or the daemon restarted. Run the call again." } };
    let part = r.value;
    if (q.select !== undefined && q.select !== null && q.select !== "") {
      try {
        const node = parse(String(q.select));
        if (!pathOnly(node)) throw new Error("select is a path such as rows[0].name, nothing more");
        part = evaluate(node, r.value && typeof r.value === "object" && !Array.isArray(r.value) ? { value: r.value, ...r.value } : { value: r.value });
      } catch (e) { return { error: { code: "bad_input", message: `select: ${/** @type {Error} */ (e).message}` } }; }
    }
    const int = (/** @type {unknown} */ x, /** @type {number} */ d, /** @type {number} */ max) => { const n = Math.floor(Number(x)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };
    if (Array.isArray(part)) {
      const offset = int(q.offset, 0, part.length), want = int(q.limit, LIMITS.defaultItems, LIMITS.maxItems) || LIMITS.defaultItems;
      let items = part.slice(offset, offset + want);
      let truncated = false;
      while (items.length > 1 && costOf(items) > LIMITS.sliceTokens) { items = items.slice(0, Math.ceil(items.length / 2)); truncated = true; }
      const end = offset + items.length;
      return { data: { items, total: part.length, offset, ...(end < part.length ? { next_offset: end } : {}), ...(truncated ? { cut_to_fit: true } : {}) } };
    }
    if (typeof part === "string" && part.length <= LIMITS.defaultChars && q.offset === undefined && q.limit === undefined) return { data: { value: part } };
    if (typeof part === "string") {
      const offset = int(q.offset, 0, part.length), want = int(q.limit, LIMITS.defaultChars, LIMITS.maxChars) || LIMITS.defaultChars;
      const text = part.slice(offset, offset + want), end = offset + text.length;
      return { data: { text, length: part.length, offset, ...(end < part.length ? { next_offset: end } : {}) } };
    }
    if (costOf(part) > LIMITS.sliceTokens) return { data: { too_large: true, tokens: costOf(part), summary: summarize(part), hint: "select a smaller part: a key, or a list item such as rows[0]" } };
    return { data: { value: part } };
  }

  /** @param {string} owner @param {unknown} handle */
  const drop = (owner, handle) => { const r = row(owner, handle); if (!r) return false; rows.delete(/** @type {string} */ (handle)); return true; };

  return { put, shape, read, drop, size: () => { expire(); return rows.size; }, bytesFor: used };
}

/** Only names, members, indexes and literals: a path and nothing that computes. @param {any} n @returns {boolean} */
function pathOnly(n) {
  switch (n.k) {
    case "id": case "lit": return true;
    case "member": return pathOnly(n.obj);
    case "index": return pathOnly(n.obj) && n.idx.k === "lit";
    default: return false;
  }
}
