// GENERATED from lib/siteops/apilearn.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// apilearn: turn captured XHR/fetch traffic into a catalog of an app's own API.
//
// PURE. It takes plain request records and returns plain entries; it touches no browser, no
// storage and no network. That keeps it testable against realistic traffic and keeps the rule that
// matters checkable: the catalog holds SHAPES, never sample values. A path id becomes {id}, a
// query value becomes a type name, a JSON body becomes its keys with value types, a credential
// becomes a kind ("bearer", "cookie", "header:token-id"). Nothing a person typed and nothing a
// server issued survives into an entry, so a catalog can be shown to a model and stored.
//
// Input record: { method, url, status?, type?, requestHeaders?, postData? } (as net.js keeps them).

import { secretName } from "./redact.js";
import * as redact from "./redact.js";

export const MAX_ENTRIES = 300;
const MAX_DEPTH = 6;
const MAX_KEYS = 60;

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{12,}$/i;

/** Ids the way real APIs issue them: numeric, uuid, hex, or a long mixed-case/digit token. @param {string} s */
export function looksLikeId(s) {
  if (!s) return false;
  if (NUMERIC.test(s) || UUID.test(s) || HEX.test(s)) return true;
  if (/^[A-Za-z0-9_-]{16,}$/.test(s) && !/^[a-z]+([-_][a-z]+)+$/.test(s) && (/\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s)))) return true;
  return false;
}

/** @param {string} path @returns {string} */
export function templatePath(path) {
  let n = 0;
  const segs = path.split("/").map(seg => {
    if (!seg) return seg;
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (looksLikeId(s)) return n++ === 0 ? "{id}" : `{id${n}}`;
    return redact.text(s);
  });
  return segs.join("/") || "/";
}

/** @param {string} v */
function valueType(v) {
  if (v === "") return "empty";
  if (NUMERIC.test(v)) return "number";
  if (/^(true|false)$/i.test(v)) return "boolean";
  if (looksLikeId(v)) return "id";
  return "string";
}

/** @param {any} v */
function primitive(v) {
  if (v === null) return "null";
  if (typeof v === "string") return looksLikeId(v) ? "id" : "string";
  return typeof v;
}

/** JSON keys and value types only. Secret-named keys become "secret". @param {any} v @param {number} [d] @returns {any} */
export function shapeOf(v, d = 0) {
  if (v === null || typeof v !== "object") return primitive(v);
  if (d >= MAX_DEPTH) return "object";
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], d + 1)] : [];
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, MAX_KEYS)) {
    // A key that is itself an id (a map keyed by record id) is a value in disguise.
    const name = looksLikeId(k) ? "{key}" : redact.text(k);
    out[name] = secretName(k) ? "secret" : shapeOf(x, d + 1);
  }
  return out;
}

/** Union two shapes seen for the same endpoint. @param {any} a @param {any} b @returns {any} */
export function mergeShape(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (typeof a === "string" && typeof b === "string") return a === b ? a : [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
  if (Array.isArray(a) && Array.isArray(b)) return a.length ? (b.length ? [mergeShape(a[0], b[0])] : a) : b;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, x] of Object.entries(b)) out[k] = mergeShape(out[k], x);
    return out;
  }
  return "mixed";
}

/** @param {string | undefined} post @param {string} ct */
function bodyShape(post, ct) {
  if (post == null || post === "") return undefined;
  const t = post.trimStart();
  if (/json/i.test(ct) || t.startsWith("{") || t.startsWith("[")) {
    try { return shapeOf(JSON.parse(post)); } catch { return "text"; }
  }
  if (/x-www-form-urlencoded/i.test(ct) || /^[^\s=&]+=/.test(post)) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of new URLSearchParams(post)) out[redact.text(k)] = secretName(k) ? "secret" : valueType(v);
    return out;
  }
  return "opaque";
}

/** @param {any} h @param {string} name */
function hget(h, name) {
  if (!h) return undefined;
  if (Array.isArray(h)) return h.find(x => String(x.name).toLowerCase() === name)?.value;
  const k = Object.keys(h).find(x => x.toLowerCase() === name);
  return k ? h[k] : undefined;
}

/** What kind of credential a request carried, never the credential. @param {any} h */
export function authKind(h) {
  const a = hget(h, "authorization");
  if (a && /^bearer\s/i.test(String(a))) return "bearer";
  if (a) return "header:authorization";
  const names = Array.isArray(h) ? h.map(x => String(x.name)) : Object.keys(h || {});
  const custom = names.find(n => { const l = n.toLowerCase(); return l !== "cookie" && l !== "authorization" && !l.startsWith("sec-") && !l.startsWith(":") && l !== "x-requested-with" && secretName(n); });
  if (custom) return `header:${custom.toLowerCase()}`;
  if (hget(h, "cookie")) return "cookie";
  return "none";
}

/** @param {string} s */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, "0");
}

/** Stable id for one endpoint. @param {string} method @param {string} host @param {string} template */
export const entryId = (method, host, template) => "e_" + hash(`${method} ${host} ${template}`);

/**
 * @param {Array<{ method?: string, url: string, status?: number, type?: string, requestHeaders?: any, postData?: string }>} reqs
 * @returns {Array<{ id: string, method: string, origin: string, host: string, pathTemplate: string, query: Record<string, string>, bodyShape?: any, authKind: string, statuses: number[], count: number }>}
 */
export function learn(reqs) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const r of reqs || []) {
    if (!/^(xhr|fetch)$/i.test(String(r.type || ""))) continue;
    let u;
    try { u = new URL(r.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const method = String(r.method || "GET").toUpperCase();
    const pathTemplate = templatePath(u.pathname);
    const id = entryId(method, u.host, pathTemplate);
    let e = map.get(id);
    if (!e) {
      e = { id, method, origin: u.origin, host: u.host, pathTemplate, query: {}, authKind: "none", statuses: new Set(), count: 0 };
      map.set(id, e);
    }
    e.count++;
    if (r.status) e.statuses.add(r.status);
    for (const [k, v] of u.searchParams) {
      const t = secretName(k) ? "secret" : valueType(v);
      const key = redact.text(k);
      e.query[key] = e.query[key] && e.query[key] !== t ? "string" : t;
    }
    const ak = authKind(r.requestHeaders);
    if (e.authKind === "none" || (ak !== "none" && ak !== "cookie")) e.authKind = ak;
    const ct = String(hget(r.requestHeaders, "content-type") || "");
    const bs = bodyShape(r.postData, ct);
    if (bs !== undefined) e.bodyShape = mergeShape(e.bodyShape, bs);
  }
  return [...map.values()].map(e => ({ ...e, statuses: [...e.statuses].sort((a, b) => a - b) }));
}

/** Fold fresh entries into a stored list: counts add, statuses union, shapes merge, bounded. @param {any[]} old @param {any[]} fresh */
export function mergeCatalog(old, fresh) {
  const by = new Map((old || []).map(e => [e.id, e]));
  for (const f of fresh || []) {
    const o = by.get(f.id);
    if (!o) { by.set(f.id, f); continue; }
    by.set(f.id, {
      ...o,
      count: o.count + f.count,
      statuses: [...new Set([...o.statuses, ...f.statuses])].sort((a, b) => a - b),
      query: { ...o.query, ...f.query },
      bodyShape: mergeShape(o.bodyShape, f.bodyShape),
      authKind: o.authKind === "none" || o.authKind === "cookie" ? f.authKind : o.authKind,
    });
  }
  const all = [...by.values()];
  return all.length > MAX_ENTRIES ? all.sort((a, b) => b.count - a.count).slice(0, MAX_ENTRIES) : all;
}

/**
 * Build the request an entry describes. Path placeholders must all be supplied; query values are
 * encoded; a body is sent as JSON.
 * @param {{ method: string, origin: string, pathTemplate: string }} entry
 * @param {{ path?: Record<string, any>, query?: Record<string, any>, body?: any }} [params]
 */
export function buildCall(entry, params = {}) {
  const path = entry.pathTemplate.replace(/\{(id\d*)\}/g, (_, name) => {
    const v = params.path?.[name];
    if (v == null || v === "") throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params.query || {})) if (v != null) q.set(k, String(v));
  const qs = q.toString();
  const hasBody = params.body !== undefined && !/^(GET|HEAD)$/.test(entry.method);
  return {
    method: entry.method,
    url: `${entry.origin}${path}${qs ? "?" + qs : ""}`,
    ...(hasBody ? { body: JSON.stringify(params.body), headers: { "content-type": "application/json" } } : {}),
  };
}
