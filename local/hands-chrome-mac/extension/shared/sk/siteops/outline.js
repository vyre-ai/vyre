// GENERATED from lib/siteops/outline.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// outline: the scout's summary. A compact picture of what each candidate request holds, so an agent chooses a request and a response recipe on few tokens instead of reading bodies.
//
// Ported from api-anything outline.ts (github.com/goodnight000/api-anything, MIT; see NOTICE). Deterministic, no model. JSON answers and JSON embedded in a page are outlined here;
// repeated page items are read from the live DOM by the shell (the page is already parsed there), so the HTML-parser half of the original is not ported.

import { extractEmbedded, getPath, innerJson, parseBody } from "./extract.js";
import { rankCandidates, suggestExtract } from "./learn.js";

const MAX_FIELDS = 30;
/** @param {string} s @param {number} [n] */
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** @param {any} v */
function sample(v) {
  if (typeof v === "string") return JSON.stringify(clip(v.replace(/\s+/g, " ")));
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}}`;
  }
  return String(v);
}

/** @param {string} path @param {string} k */
const step = (path, k) => (/^[A-Za-z_$][\w$-]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}[${JSON.stringify(k)}]`);
// an id-like key: digits, or a URN or URL-ish value ("Book:kca://book/...", "User:123")
const idLike = (/** @type {string} */ k) => /\d{3,}|[:/]/.test(k);

/** Paths (getPath syntax) to string leaves containing an example value, stepping into JSON strings. @param {any} root @param {string[]} values @param {number} [max] @returns {string[]} */
function findPaths(root, values, max = 5) {
  /** @type {string[]} */ const out = [];
  const queue = [{ v: root, path: "", depth: 0 }];
  while (queue.length && out.length < max) {
    const { v, path, depth } = /** @type {any} */ (queue.shift());
    if (typeof v === "string") {
      const inner = innerJson(v);
      if (inner && typeof inner === "object") queue.push({ v: inner, path, depth });
      else if (values.some(x => v.toLowerCase().includes(x))) out.push(path);
      continue;
    }
    if (depth > 12 || !v || typeof v !== "object") continue;
    /** @type {[string, any][]} */
    const entries = Array.isArray(v) ? v.slice(0, 100).map((c, i) => [`${path}[${i}]`, c]) : Object.entries(v).map(([k, c]) => [step(path, k), c]);
    for (const [p, c] of entries) queue.push({ v: c, path: p, depth: depth + 1 });
  }
  return out;
}

/** Leaf paths of one item (arrays as [*]) with samples. @param {any} item @returns {Record<string, string>} */
function fieldsOf(item) {
  /** @type {Record<string, string>} */ const out = {};
  /** @param {any} v @param {string} path @param {number} depth @returns {void} */
  const visit = (v, path, depth) => {
    if (Object.keys(out).length >= MAX_FIELDS) return;
    if (typeof v === "string") {
      const inner = innerJson(v);
      if (inner && typeof inner === "object" && depth < 4) return visit(inner, path, depth);
    }
    if (v && typeof v === "object" && depth < 4) {
      if (Array.isArray(v)) {
        if (path) out[path] = sample(v);
        if (v.length && v[0] && typeof v[0] === "object") visit(v[0], `${path}[*]`, depth + 1);
        return;
      }
      for (const [k, c] of Object.entries(v)) visit(c, step(path, k), depth + 1);
      return;
    }
    if (path) out[path] = sample(v);
  };
  visit(item, "", 0);
  return out;
}

/** Outline a parsed JSON answer. `values` are the example values, lower-cased. @param {any} root @param {string[]} values */
export function outlineJson(root, values) {
  const at = findPaths(root, values);
  // suggestExtract falls back to the biggest array; for an outline, only a path holding the example counts
  const suggested = suggestExtract(root, values);
  const carries = (/** @type {any} */ v) => values.some(x => (JSON.stringify(v) ?? "").toLowerCase().includes(x));
  const extract = suggested !== undefined && carries(getPath(root, suggested)) ? suggested : undefined;
  const target = getPath(root, extract);
  const fields = fieldsOf(Array.isArray(target) ? target[0] : target);
  const varyingKeys = [...new Set(at.flatMap(p => [...p.matchAll(/\["((?:[^"\\]|\\.)*)"\]/g)].map(m => JSON.parse(`"${m[1]}"`)).filter(idLike)))];
  return { ...(at.length ? { at } : {}), ...(extract !== undefined ? { extract } : {}), fields, ...(varyingKeys.length ? { varyingKeys: varyingKeys.slice(0, 3) } : {}) };
}

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regexes (group 1 at the JSON's start) for JSON blocks a page embeds. @param {string} body @returns {string[]} */
export function embeddedBlocks(body) {
  /** @type {string[]} */ const out = [];
  for (const m of body.matchAll(/<script\b([^>]*)>\s*([[{])/g)) {
    const attrs = m[1];
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (/application\/ld\+json/i.test(attrs)) {
      const type = /"@type"\s*:\s*"([^"]+)"/.exec(body.slice(m.index, m.index + 400))?.[1];
      out.push(`application/ld\\+json[^>]*>\\s*(\\{)${type ? `(?=[^<]*?"@type"\\s*:\\s*"${escapeRe(type)}")` : ""}`);
    } else if (id && /application\/json/i.test(attrs)) out.push(`id="${escapeRe(id)}"[^>]*>\\s*([[{])`);
  }
  for (const m of body.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*([[{])/g)) out.push(`window\\.${escapeRe(m[1])}\\s*=\\s*([[{])`);
  return [...new Set(out)];
}

/** Outline a response body. `examples` are the example values (matched case-insensitively). A page answer returns its embedded JSON; its visible items are the shell's to outline. @param {string} contentType @param {string} body @param {string[]} examples */
export function outline(contentType, body, examples) {
  const values = examples.map(v => v.toLowerCase()).filter(v => v.length >= 3);
  if (!/html/i.test(contentType)) {
    try {
      const data = parseBody(body);
      return data && typeof data === "object" ? { json: outlineJson(data, values) } : undefined;
    } catch { return undefined; }
  }
  const embedded = embeddedBlocks(body).flatMap(regex => {
    const data = extractEmbedded(body, regex);
    if (!data || typeof data !== "object") return [];
    const o = outlineJson(data, values);
    // JSON-LD is small and schema.org-stable, so it is always worth showing; other blocks only when they carry an example
    return o.at || regex.startsWith("application/ld") ? [{ regex, ...o }] : [];
  });
  return embedded.length ? { embedded: embedded.slice(0, 4) } : undefined;
}

/**
 * The scout: every candidate request of a capture, best first, each on a few tokens (method, host and path, status, why it ranks, the outline of its answer). This is what the agent reads
 * instead of the traffic. At most `limit` candidates.
 * @param {import("./learn.js").Exchange[]} exchanges @param {Record<string, any>} args @param {{ limit?: number, pages?: string[] }} [o]
 */
export function scout(exchanges, args, o = {}) {
  const values = Object.values(args).map(v => String(typeof v === "object" ? JSON.stringify(v) : v).toLowerCase());
  const ranked = rankCandidates(exchanges, args, { pages: o.pages }).slice(0, o.limit ?? 8);
  return ranked.map(c => {
    const ex = exchanges.find(e => e.id === c.id);
    let where = c.url;
    try { const u = new URL(c.url); where = `${u.host}${u.pathname.length > 60 ? u.pathname.slice(0, 59) + "…" : u.pathname}`; } catch { /* keep the raw url */ }
    const out = ex && ex.response && ex.response.body ? outline(ex.response.contentType, ex.response.body, values) : undefined;
    return { id: c.id, call: `${c.method} ${where}`, status: c.status, carries: c.hits, score: c.score, ...(c.operationName ? { operationName: c.operationName } : {}), ...(out ? { outline: out } : {}) };
  });
}
