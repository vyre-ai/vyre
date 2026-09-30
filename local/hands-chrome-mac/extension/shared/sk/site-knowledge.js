// VENDORED from work/iq (lib/site-knowledge.js, lib/secret-shapes.js, core/vault/detect.js) at e3bb3bc8, import path adjusted. Do not edit here: change it upstream and re-copy (see VERSION).
// @ts-check
// site-knowledge: what Vyre for Chrome learns about a website, as a record that holds structure and
// never a value (team/0.2/chrome-learning-plan.md). PURE: no fs, no vyred, no chrome.* API, so the
// extension, standalone Vyre for Chrome and core/memory use the same code and a record means the
// same thing in each.
//
// Two rules hold everything else:
//   1. Allowlist. Only the fields below survive, with types and length limits; anything else is
//      dropped. A string that looks like a credential, a pairing code or a key (lib/secret-shapes.js,
//      the recall redaction and the Vault's named shapes) or carries an email makes the WHOLE patch
//      refused (fail closed); the refusal names the field and never the text.
//   2. A control's label is stored only when it is stable and cannot be a person's data: seen in two
//      separate visits, not inside a row, cell or list of records, not repeated among siblings, and
//      without an email, phone or long number in it. Otherwise the control is found by identifier or
//      by structure (role, container, nth). Chrome supplies the evidence; this code decides.

import { redact } from "./secret-shapes.js";

export const SITE_V = 1;

export const LIMITS = Object.freeze({
  str: 120, text: 600, names: 4, related: 8, signals: 8, authHosts: 8, frames: 16, controls: 200, api: 300,
  flows: 40, notes: 20, steps: 60, params: 12, expects: 8, tombstones: 200, recordBytes: 256 * 1024, cardBytes: 8 * 1024,
  shapeDepth: 6, shapeKeys: 60, perPageCard: 10,
});

export const SIGNAL_KINDS = Object.freeze(["landmark", "selector", "url", "net-idle", "dom-quiet", "password-field", "otp-field", "auth-host", "auth-path"]);
export const STRATEGIES = Object.freeze(["identifier", "role+name", "name", "name-ci", "aria", "nearby-label", "text", "structure"]);
export const FRAME_ROLES = Object.freeze(["shell", "app", "builder", "auth", "ad", "other"]);
export const SRCS = Object.freeze(["learned", "taught", "shipped"]);
export const WRITE_KINDS = Object.freeze(["create", "edit", "delete", "publish", "send"]);
export const PARAM_TYPES = Object.freeze(["string", "number", "boolean", "choice"]);
const SHAPE_TYPES = new Set(["string", "number", "boolean", "null", "id", "object", "secret", "empty", "text", "opaque", "mixed", "json", "undefined", "bigint", "{key}"]);
/** Roles whose text is data (a person, a record, a cell), never a fixed UI string. */
export const DATA_ROLES = new Set(["heading", "cell", "gridcell", "row", "rowheader", "listitem", "treeitem", "option", "textbox", "searchbox", "combobox", "paragraph", "text", "img", "article", "definition", "term"]);
/** Containers that hold records: a control inside one is a row's control. */
export const DATA_CONTAINERS = new Set(["row", "cell", "gridcell", "listitem", "treeitem", "list", "listbox", "table", "grid", "tree", "rowgroup", "feed", "log"]);

const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const FAMILY_KEY = /^family:[a-z0-9][a-z0-9-]{0,39}$/;
const ID_TOKEN = /^[A-Za-z0-9_.:~-]{1,64}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const EMAIL = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?\d[\s().-]?){7,}\d/;
const LONG_NUMBER = /\d{6,}/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY = 86_400_000;

/** @typedef {{ path: string, why: string }} Problem */

const obj = (/** @type {unknown} */ v) => (v && typeof v === "object" && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null);
const num = (/** @type {unknown} */ v, lo, hi, dflt) => { const n = typeof v === "number" && Number.isFinite(v) ? v : dflt; return Math.min(hi, Math.max(lo, n)); };
const int = (/** @type {unknown} */ v, lo, hi, dflt) => Math.round(num(v, lo, hi, dflt));

/** Ids the way real APIs issue them: numeric, uuid, hex, or a long mixed-case/digit token (as apilearn.looksLikeId). @param {string} s */
export function looksLikeId(s) {
  if (!s) return false;
  if (/^\d+$/.test(s) || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{12,}$/i.test(s)) return true;
  return /^[A-Za-z0-9_-]{16,}$/.test(s) && !/^[a-z]+([-_][a-z]+)+$/.test(s) && (/\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s)));
}

/** A path template: slashes, plain segments and {id} placeholders, nothing that is an id, no query. @param {string} p */
export function templateOk(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > LIMITS.str * 2 || /[?#\s]/.test(p)) return false;
  return p.split("/").every(seg => !seg || /^\{[a-z0-9]{1,8}\}$/i.test(seg) || (/^[A-Za-z0-9_.~:@=,+-]{1,48}$/.test(seg) && !looksLikeId(seg)));
}

/** @param {string} s */
const piiShape = s => EMAIL.test(s) || PHONE.test(s) || LONG_NUMBER.test(s);
/** An identifier with a record id inside it (contact-row-3f2b8c1e) is not stable and is itself data. @param {string} s */
const identifierHasId = s => s.split(/[-_:.]/).some(t => /^[0-9a-f]{8,}$/i.test(t) || /^\d{5,}$/.test(t) || looksLikeId(t));

// ---------------------------------------------------------------------------------------------
// The allowlist: each cleaner returns the cleaned value or null (dropped), and files problems.

/**
 * @typedef {{ refused: Problem[], dropped: Problem[] }} Ctx
 */

/** One string. Too long is dropped; a secret shape or an email refuses the whole patch. @param {any} v @param {number} max @param {string} path @param {Ctx} c @returns {string|null} */
function str(v, max, path, c) {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > max) { c.dropped.push({ path, why: "too long" }); return null; }
  if (redact(t) !== t) { c.refused.push({ path, why: "secret shape" }); return null; }
  if (EMAIL.test(t)) { c.refused.push({ path, why: "email" }); return null; }
  return t;
}
const token = (/** @type {any} */ v, path, c) => { const t = str(v, 64, path, c); return t && ID_TOKEN.test(t) ? t : null; };
const word = (/** @type {any} */ v, path, c, max = 30) => { const t = str(v, max, path, c); return t && /^[a-z][a-z0-9+_-]*$/i.test(t) ? t.toLowerCase() : null; };
const oneOf = (/** @type {any} */ v, /** @type {readonly string[]} */ set, dflt) => (typeof v === "string" && set.includes(v) ? v : dflt);
const iso = (/** @type {any} */ v) => (typeof v === "string" && ISO.test(v) ? v : null);

/** @param {any} f @param {string} path @param {Ctx} c */
function fact(f, path, c) {
  const src = oneOf(f && f.src, SRCS, "learned");
  return {
    conf: Math.round(num(f && f.conf, 0, 1, 0.5) * 1000) / 1000,
    verified: iso(f && f.verified), seen: int(f && f.seen, 0, 1e9, 1), misses: int(f && f.misses, 0, 1e6, 0), src,
    ...(iso(f && f.missAt) ? { missAt: iso(f && f.missAt) } : {}), ...(iso(f && f.qAt) ? { qAt: iso(f && f.qAt) } : {}),
    ...(f && f.outcome === "ok" || f && f.outcome === "miss" ? { outcome: f.outcome } : {}),
  };
}

/** @param {any} f @param {string} path @param {Ctx} c */
function frameRef(f, path, c) { return f == null ? undefined : token(f, path, c) || undefined; }

/** @param {any} s @param {string} path @param {Ctx} c */
function signal(s, path, c) {
  const o = obj(s); if (!o) return null;
  const kind = oneOf(o.kind, SIGNAL_KINDS, null); if (!kind) { c.dropped.push({ path: path + ".kind", why: "unknown kind" }); return null; }
  let arg;
  if (o.arg != null) {
    const a = str(o.arg, LIMITS.str, path + ".arg", c);
    if (a == null) { if (c.refused.length) return null; }
    else if (kind === "url" || kind === "auth-path") { if (!templateOk(a)) { c.dropped.push({ path: path + ".arg", why: "not a path template" }); return null; } arg = a; }
    else if (kind === "auth-host") { if (!HOST.test(a.toLowerCase())) { c.dropped.push({ path: path + ".arg", why: "not a host" }); return null; } arg = a.toLowerCase(); }
    else arg = a;
  }
  return { ...fact(o, path, c), kind, ...(arg ? { arg } : {}), ...(frameRef(o.frame, path + ".frame", c) ? { frame: frameRef(o.frame, path + ".frame", c) } : {}),
    ...(typeof o.p90ms === "number" ? { p90ms: int(o.p90ms, 0, 600000, 0) } : {}) };
}
const signalId = s => `${s.kind}|${s.arg || ""}|${s.frame || ""}`;

/** @param {any} f @param {string} path @param {Ctx} c */
function frame(f, path, c) {
  const o = obj(f); if (!o) return null;
  const id = token(o.id, path + ".id", c); if (!id) return null;
  const m = obj(o.match) || {};
  const originPart = m.originPart != null ? str(m.originPart, LIMITS.str, path + ".match.originPart", c) : null;
  const pathTemplate = m.pathTemplate != null ? (templateOk(String(m.pathTemplate)) ? String(m.pathTemplate) : null) : null;
  const name = m.name != null ? str(m.name, LIMITS.str, path + ".match.name", c) : null;
  return { ...fact(o, path, c), id, match: { ...(originPart ? { originPart } : {}), ...(pathTemplate ? { pathTemplate } : {}), ...(name && !piiShape(name) ? { name } : {}),
    ...(Number.isInteger(m.ordinal) ? { ordinal: int(m.ordinal, 0, 99, 0) } : {}) },
    role: oneOf(o.role, FRAME_ROLES, "other"), ...(o.parent != null && token(o.parent, path + ".parent", c) ? { parent: token(o.parent, path + ".parent", c) } : {}), readable: o.readable !== false };
}

/** A selector: never a css string or a DOM path. @param {any} s @param {string} path @param {Ctx} c */
function selector(s, path, c) {
  const o = obj(s); if (!o) return null;
  const strategy = oneOf(o.strategy, STRATEGIES, null); if (!strategy) { c.dropped.push({ path: path + ".strategy", why: "unknown strategy" }); return null; }
  const out = /** @type {Record<string, any>} */ ({ strategy });
  if (o.identifier != null) {
    const id = str(o.identifier, LIMITS.str, path + ".identifier", c);
    if (id && !identifierHasId(id)) out.identifier = id; else if (id) c.dropped.push({ path: path + ".identifier", why: "carries a record id" });
  }
  if (o.role != null) { const r = word(o.role, path + ".role", c); if (r) out.role = r; }
  if (o.container != null) { const r = word(o.container, path + ".container", c); if (r) out.container = r; }
  if (o.nth != null) out.nth = int(o.nth, 0, 999, 0);
  if (o.name != null) { const n = labelOk(o.name, o, path + ".name", c); if (n) out.name = n; }
  const f = frameRef(o.frame, path + ".frame", c); if (f) out.frame = f;
  if (strategy === "identifier" && !out.identifier) return null;
  if (strategy === "structure" && !(out.role && out.container !== undefined)) { if (!out.role) return null; }
  return out;
}

/**
 * A label is kept only when it cannot be a person's data. The evidence comes with the observation:
 * `nameVisits` (ids of two separate visits that saw the same text), `siblings` (how many controls of
 * the same role share this container), `container` (its container's role).
 * @param {any} v @param {Record<string, any>} ev @param {string} path @param {Ctx} c @returns {string|null}
 */
function labelOk(v, ev, path, c) {
  const t = str(v, 80, path, c);
  if (!t) return null;
  const role = typeof ev.role === "string" ? ev.role.toLowerCase() : "";
  const container = typeof ev.container === "string" ? ev.container.toLowerCase() : "";
  const visits = Array.isArray(ev.nameVisits) ? new Set(ev.nameVisits.map(String).filter(Boolean)) : new Set();
  let why = "";
  if (piiShape(t)) why = "looks like a person's data";
  else if (DATA_ROLES.has(role)) why = "role holds data";
  else if (DATA_CONTAINERS.has(container)) why = "inside a record list";
  else if (int(ev.siblings, 0, 1e6, 0) > 1) why = "repeated among siblings";
  else if (visits.size < 2) why = "not seen in two visits";
  if (why) { c.dropped.push({ path, why: `label dropped: ${why}` }); return null; }
  return t;
}

/** @param {any} x @param {string} path @param {Ctx} c */
function control(x, path, c) {
  const o = obj(x); if (!o) return null;
  const id = token(o.id, path + ".id", c); if (!id) return null;
  if (!templateOk(String(o.page || ""))) { c.dropped.push({ path: path + ".page", why: "not a path template" }); return null; }
  const role = word(o.role, path + ".role", c); if (!role) return null;
  const so = obj(o.selector) || {};
  // A selector that names a role (role+name, structure) takes the control's role when it gives none.
  const needsRole = so.strategy === "structure" || so.strategy === "role+name";
  const sel = selector({ ...so, ...(needsRole ? { role: so.role ?? role } : {}), container: so.container ?? (so.strategy === "structure" ? o.container : undefined), nameVisits: o.nameVisits, siblings: o.siblings }, path + ".selector", c);
  if (!sel) { c.dropped.push({ path: path + ".selector", why: "no usable selector" }); return null; }
  const prev = o.prev != null ? selector(o.prev, path + ".prev", c) : null;
  const name = o.name != null ? labelOk(o.name, { role, container: obj(o.selector)?.container ?? o.container, nameVisits: o.nameVisits, siblings: o.siblings }, path + ".name", c) : null;
  return { ...fact(o, path, c), id, page: String(o.page), role, ...(name ? { name } : {}), selector: sel, ...(prev ? { prev } : {}) };
}

/** A body or query shape: keys and type names only, bounded. @param {any} v @param {number} d @param {string} path @param {Ctx} c @returns {any} */
function shape(v, d, path, c) {
  if (typeof v === "string") {
    const parts = v.split("|");
    return parts.every(p => SHAPE_TYPES.has(p)) && parts.length <= 6 ? v : (c.dropped.push({ path, why: "not a type name" }), "mixed");
  }
  if (d >= LIMITS.shapeDepth) return "object";
  if (Array.isArray(v)) return v.length ? [shape(v[0], d + 1, path + "[]", c)] : [];
  const o = obj(v); if (!o) return "mixed";
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, x] of Object.entries(o).slice(0, LIMITS.shapeKeys)) {
    const key = k === "{key}" ? k : str(k, 60, `${path}.${k.slice(0, 20)}`, c);
    if (!key || (key !== "{key}" && looksLikeId(key))) continue;
    out[key] = shape(x, d + 1, `${path}.${key}`, c);
  }
  return out;
}

/** @param {any} x @param {string} path @param {Ctx} c */
function apiEntry(x, path, c) {
  const o = obj(x); if (!o) return null;
  const id = token(o.id, path + ".id", c); if (!id) return null;
  const method = String(o.method || "GET").toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) return null;
  const origin = String(o.origin || "");
  if (!ORIGIN.test(origin)) { c.dropped.push({ path: path + ".origin", why: "not an origin" }); return null; }
  if (!templateOk(String(o.pathTemplate || ""))) { c.dropped.push({ path: path + ".pathTemplate", why: "not a path template" }); return null; }
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, t] of Object.entries(obj(o.query) || {}).slice(0, LIMITS.shapeKeys)) {
    const key = str(k, 60, `${path}.query.${k.slice(0, 20)}`, c);
    if (key && !looksLikeId(key) && typeof t === "string" && SHAPE_TYPES.has(t.split("|")[0])) query[key] = t;
  }
  const authKind = typeof o.authKind === "string" && /^(none|cookie|bearer|header:[a-z0-9-]{1,40}|header:authorization)$/i.test(o.authKind) ? o.authKind : "none";
  return { ...fact(o, path, c), id, method, origin, pathTemplate: String(o.pathTemplate), query, ...(o.bodyShape !== undefined ? { bodyShape: shape(o.bodyShape, 0, path + ".bodyShape", c) } : {}),
    authKind, statuses: (Array.isArray(o.statuses) ? o.statuses : []).filter(n => Number.isInteger(n) && n >= 100 && n < 600).slice(0, 12), count: int(o.count, 0, 1e9, 1) };
}

/** @param {any} s @param {string} path @param {Ctx} c */
function step(s, path, c) {
  const o = obj(s); if (!o) return null;
  const id = token(o.id, path + ".id", c); const op = str(o.op, 40, path + ".op", c);
  if (!id || !op || !/^[a-z][a-z0-9._-]*$/i.test(op)) return null;
  const args = jsonSafe(o.args, 0, path + ".args", c);
  return { id, ...(o.label != null && str(o.label, 80, path + ".label", c) ? { label: str(o.label, 80, path + ".label", c) } : {}), op, args,
    ...(o.via === "api" || o.via === "ui" ? { via: o.via } : {}), ...(o.fallback != null && token(o.fallback, path + ".fallback", c) ? { fallback: token(o.fallback, path + ".fallback", c) } : {}),
    ...(obj(o.expect) && signal(o.expect, path + ".expect", c) ? { expect: signal(o.expect, path + ".expect", c) } : {}),
    ...(WRITE_KINDS.includes(o.write) ? { write: o.write } : {}), ...(Number.isInteger(o.fails) ? { fails: int(o.fails, 0, 1e6, 0) } : {}) };
}

/** Step arguments: placeholders, stored control ids, and short plain strings; numbers and booleans as they are. No long or secret-shaped text. @param {any} v @param {number} d @param {string} path @param {Ctx} c @returns {any} */
function jsonSafe(v, d, path, c) {
  if (v == null || typeof v === "boolean") return v ?? null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = str(v, LIMITS.str, path, c);
    if (t == null) return null;
    // A literal that looks like a value somebody typed (a phone, a long number) is not allowed in a stored step.
    if (!/^\{[A-Za-z0-9_]+\}$/.test(t) && (PHONE.test(t) || LONG_NUMBER.test(t))) { c.refused.push({ path, why: "a literal value in a step" }); return null; }
    return t;
  }
  if (d >= 5) return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x, i) => jsonSafe(x, d + 1, `${path}[${i}]`, c));
  const o = obj(v); if (!o) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, x] of Object.entries(o).slice(0, 40)) { const key = str(k, 60, `${path}.${k.slice(0, 20)}`, c); if (key) out[key] = jsonSafe(x, d + 1, `${path}.${key}`, c); }
  return out;
}

/** @param {any} x @param {string} path @param {Ctx} c */
function flow(x, path, c) {
  const o = obj(x); if (!o) return null;
  const name = str(o.name, 60, path + ".name", c); if (!name || !/^[a-z][a-z0-9._-]*$/i.test(name)) return null;
  const src = oneOf(o.src, SRCS, "learned");
  const params = (Array.isArray(o.params) ? o.params : []).slice(0, LIMITS.params).map((p, i) => {
    const po = obj(p); const n = po && str(po.name, 40, `${path}.params[${i}].name`, c);
    return po && n ? { name: n, type: oneOf(po.type, PARAM_TYPES, "string"), ...(Array.isArray(po.choices) ? { choices: po.choices.slice(0, 20).map((x, j) => str(x, 60, `${path}.params[${i}].choices[${j}]`, c)).filter(Boolean) } : {}) } : null;
  }).filter(Boolean);
  const steps = src === "shipped" ? undefined : (Array.isArray(o.steps) ? o.steps : []).slice(0, LIMITS.steps).map((s, i) => step(s, `${path}.steps[${i}]`, c)).filter(Boolean);
  const expects = (Array.isArray(o.expects) ? o.expects : []).slice(0, LIMITS.expects).map((s, i) => signal(s, `${path}.expects[${i}]`, c)).filter(Boolean);
  const f = fact(o, path, c);
  // Nothing proved a flow without `expects` worked: its trust is capped.
  if (!expects.length && f.conf > 0.5) f.conf = 0.5;
  return { ...f, src, name, title: str(o.title, LIMITS.str, path + ".title", c) || name, params, ...(steps ? { steps } : {}), expects, runs: int(o.runs, 0, 1e9, 0), fails: int(o.fails, 0, 1e9, 0),
    p50ms: int(o.p50ms, 0, 3_600_000, 0), ...(o.failedStep != null && token(o.failedStep, path + ".failedStep", c) ? { failedStep: token(o.failedStep, path + ".failedStep", c) } : {}) };
}

/** @param {any} x @param {string} path @param {Ctx} c */
function note(x, path, c) {
  const o = obj(x); if (!o) return null;
  const name = str(o.name, 60, path + ".name", c); const text = str(o.text, LIMITS.text, path + ".text", c);
  if (!name || !text) return null;
  if (piiShape(text) && (EMAIL.test(text) || PHONE.test(text))) { c.refused.push({ path: path + ".text", why: "looks like a person's data" }); return null; }
  return { ...fact(o, path, c), name, text, ...(o.about != null && templateOk(String(o.about)) ? { about: String(o.about) } : {}) };
}

const list = (/** @type {any} */ v, max, fn, path, /** @type {Ctx} */ c) => (Array.isArray(v) ? v : []).slice(0, max).map((x, i) => fn(x, `${path}[${i}]`, c)).filter(Boolean);

// ---------------------------------------------------------------------------------------------
// Public: sanitize, empty, merge

/** @param {string} key an origin or "family:<id>" */
export function emptyRecord(key) {
  return { v: SITE_V, key, rev: 0, updated: null, names: [], family: null, related: [], ready: [], login: { wall: [], signedIn: [], authHosts: [] },
    frames: [], controls: [], api: [], flows: [], notes: [], tombstones: [] };
}

/** @param {string} key */
export const keyOk = key => typeof key === "string" && (ORIGIN.test(key) || FAMILY_KEY.test(key));
export const isFamilyKey = (/** @type {string} */ k) => FAMILY_KEY.test(k);

/**
 * Clean a record or a patch through the allowlist. `ok: false` means something secret-shaped was in
 * it and nothing is kept (fail closed); `refused` names the fields, never their text. `dropped` lists
 * what the allowlist removed without refusing the rest.
 * @param {any} input
 * @returns {{ ok: boolean, record: any, refused: Problem[], dropped: Problem[] }}
 */
export function sanitize(input) {
  /** @type {Ctx} */
  const c = { refused: [], dropped: [] };
  const o = obj(input);
  if (!o) return { ok: false, record: null, refused: [{ path: "", why: "not an object" }], dropped: [] };
  const key = typeof o.key === "string" ? o.key : typeof o.origin === "string" ? o.origin : "";
  if (!keyOk(key)) return { ok: false, record: null, refused: [{ path: "key", why: "not an origin or a family key" }], dropped: [] };
  const names = (Array.isArray(o.names) ? o.names : []).slice(0, LIMITS.names).map((n, i) => str(n, 40, `names[${i}]`, c)).filter(Boolean);
  const family = o.family != null && /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(o.family)) ? String(o.family) : null;
  const related = (Array.isArray(o.related) ? o.related : []).filter(x => typeof x === "string" && ORIGIN.test(x)).slice(0, LIMITS.related);
  const login = obj(o.login) || {};
  const tombstones = (Array.isArray(o.tombstones) ? o.tombstones : []).slice(0, LIMITS.tombstones).map(t => { const to = obj(t); return to && ["controls", "api", "flows", "notes", "frames", "ready", "wall", "signedIn"].includes(to.part) && iso(to.at) && typeof to.id === "string" && to.id.length <= 200 ? { part: to.part, id: to.id, at: to.at } : null; }).filter(Boolean);
  const record = { v: SITE_V, key, rev: int(o.rev, 0, 1e12, 0), updated: iso(o.updated), names, family, related,
    ready: list(o.ready, LIMITS.signals, signal, "ready", c), login: { wall: list(login.wall, LIMITS.signals, signal, "login.wall", c), signedIn: list(login.signedIn, LIMITS.signals, signal, "login.signedIn", c),
      authHosts: (Array.isArray(login.authHosts) ? login.authHosts : []).map(h => String(h).toLowerCase()).filter(h => HOST.test(h)).slice(0, LIMITS.authHosts) },
    frames: list(o.frames, LIMITS.frames, frame, "frames", c), controls: list(o.controls, LIMITS.controls, control, "controls", c), api: list(o.api, LIMITS.api, apiEntry, "api", c),
    flows: list(o.flows, LIMITS.flows, flow, "flows", c), notes: list(o.notes, LIMITS.notes, note, "notes", c), tombstones,
    ...(Array.isArray(o.remove) ? { remove: o.remove.slice(0, 100).map(r => { const ro = obj(r); return ro && typeof ro.part === "string" && typeof ro.id === "string" && ro.id.length <= 200 ? { part: ro.part, id: ro.id } : null; }).filter(Boolean) } : {}) };
  if (c.refused.length) return { ok: false, record: null, refused: c.refused, dropped: c.dropped };
  return { ok: true, record, refused: [], dropped: c.dropped };
}

export const itemId = (/** @type {string} */ part, /** @type {any} */ it) => (part === "ready" || part === "wall" || part === "signedIn" ? signalId(it) : part === "flows" || part === "notes" ? it.name : it.id);

/** The trust to read an item at: stored conf, halved when unverified for 90 days. @param {any} f @param {number} [now] */
export function readConf(f, now = Date.now()) {
  const v = f && f.verified ? Date.parse(f.verified) : 0;
  const c = typeof (f && f.conf) === "number" ? f.conf : 0;
  return v && now - v > 90 * DAY ? c / 2 : !v && f && f.src === "learned" && c > 0.5 ? 0.5 : c;
}
/** An item that used to work: quarantined, shown in answers as "used to work". @param {any} f */
export const isQuarantined = f => Boolean(f && f.qAt);
/** Stale: tried last, not trusted. @param {any} f @param {number} [now] */
export const isStale = (f, now = Date.now()) => readConf(f, now) < 0.3;

/**
 * Apply one outcome to an item. ok: conf up, verified now, misses cleared. miss: conf * 0.6, and a
 * quarantine after three misses over two days or conf under 0.15.
 * @param {any} f @param {"ok"|"miss"} outcome @param {number} [now]
 */
export function heal(f, outcome, now = Date.now()) {
  const at = new Date(now).toISOString();
  const out = { ...f };
  if (outcome === "ok") {
    out.conf = Math.round(Math.min(1, (f.conf ?? 0.5) + 0.1) * 1000) / 1000; out.verified = at; out.misses = 0; delete out.missAt; delete out.qAt;
  } else {
    out.misses = (f.misses || 0) + 1; out.conf = Math.round((f.conf ?? 0.5) * 0.6 * 1000) / 1000; out.missAt = f.missAt || at;
    if ((out.misses >= 3 && now - Date.parse(out.missAt) >= 2 * DAY) || out.conf < 0.15) out.qAt = f.qAt || at;
  }
  return out;
}

const PARTS = /** @type {const} */ (["frames", "controls", "api", "flows", "notes"]);
const SIG_PARTS = [["ready", r => r.ready, (r, v) => { r.ready = v; }], ["wall", r => r.login.wall, (r, v) => { r.login.wall = v; }], ["signedIn", r => r.login.signedIn, (r, v) => { r.login.signedIn = v; }]];
const CAP = { frames: LIMITS.frames, controls: LIMITS.controls, api: LIMITS.api, flows: LIMITS.flows, notes: LIMITS.notes, ready: LIMITS.signals, wall: LIMITS.signals, signedIn: LIMITS.signals };

/** One item of a patch into the stored list. New items start no higher than 0.5. */
function foldItem(part, old, inc, now) {
  if (!old) {
    const f = { ...inc }; delete f.outcome;
    f.conf = Math.min(f.conf ?? 0.5, f.src === "shipped" ? 1 : 0.5);
    return inc.outcome ? heal(f, inc.outcome, now) : f;
  }
  let out = { ...old, ...inc, conf: old.conf, verified: old.verified, seen: (old.seen || 0) + (inc.seen || 1), misses: old.misses || 0 };
  if (old.missAt) out.missAt = old.missAt; if (old.qAt) out.qAt = old.qAt;
  if (part === "api") { out.count = (old.count || 0) + (inc.count || 0); out.statuses = [...new Set([...(old.statuses || []), ...(inc.statuses || [])])].sort((a, b) => a - b).slice(0, 12); out.query = { ...old.query, ...inc.query }; }
  if (part === "flows") { out.runs = Math.max(old.runs || 0, inc.runs || 0); out.fails = Math.max(old.fails || 0, inc.fails || 0); if (inc.src === "shipped" || old.src === "shipped") out.src = "shipped"; }
  if (part === "controls") {
    out.name = inc.name || old.name;
    // A heal: the selector that worked replaces the old one, which is kept for one cycle.
    if (inc.outcome === "ok" && JSON.stringify(inc.selector) !== JSON.stringify(old.selector)) out.prev = old.selector;
    else if (old.prev && inc.outcome === "miss") out.prev = old.prev;
    else delete out.prev;
    if (inc.outcome !== "ok") out.selector = old.selector;
  }
  delete out.outcome;
  out = inc.outcome ? heal(out, inc.outcome, now) : out;
  return out;
}

const score = (/** @type {any} */ f, /** @type {number} */ now) => { const v = f.verified ? Date.parse(f.verified) : 0; return readConf(f, now) * (v ? 1 / (1 + (now - v) / (30 * DAY)) : 0.5); };

/** Drop the lowest `conf * recency` items over a part's cap, never one the patch just touched. */
function cap(items, max, fresh, now) {
  if (items.length <= max) return items;
  const keep = items.filter(x => fresh.has(x)), rest = items.filter(x => !fresh.has(x)).sort((a, b) => score(b, now) - score(a, now));
  return [...keep, ...rest].slice(0, max);
}

/**
 * Fold a patch (a sanitized record-shaped object, items optionally carrying `outcome` and `remove`)
 * into a stored record. Merges by item id: counts add, `verified` takes the newest, conf follows heal
 * rules. Never replaces. Quarantined items older than 30 days are dropped.
 * @param {any} base a stored record (or emptyRecord) @param {any} patch from sanitize().record @param {{ now?: number }} [o]
 */
export function mergeRecord(base, patch, { now = Date.now() } = {}) {
  const out = JSON.parse(JSON.stringify(base));
  const fresh = new Set();
  const tomb = new Map((out.tombstones || []).map(t => [`${t.part}|${t.id}`, t]));
  for (const t of patch.tombstones || []) { const k = `${t.part}|${t.id}`; const o = tomb.get(k); if (!o || t.at > o.at) tomb.set(k, t); }
  const apply = (part, get, set) => {
    const cur = get(out) || [];
    const by = new Map(cur.map(x => [itemId(part, x), x]));
    for (const inc of get(patch) || []) {
      const id = itemId(part, inc);
      const t = tomb.get(`${part}|${id}`);
      if (t && inc.verified && inc.verified < t.at) continue;
      if (t && !inc.verified) continue;
      const merged = foldItem(part, by.get(id), inc, now);
      by.set(id, merged); fresh.add(merged);
    }
    set(out, cap([...by.values()].filter(x => !(x.qAt && now - Date.parse(x.qAt) > 30 * DAY)), CAP[part], fresh, now));
  };
  for (const part of PARTS) apply(part, r => r[part], (r, v) => { r[part] = v; });
  for (const [part, get, set] of SIG_PARTS) apply(part, get, set);
  for (const r of patch.remove || []) {
    const get = SIG_PARTS.find(s => s[0] === r.part)?.[1] || (rec => rec[r.part]);
    const list = get(out); if (!Array.isArray(list)) continue;
    const i = list.findIndex(x => itemId(r.part, x) === r.id);
    if (i >= 0) { list.splice(i, 1); tomb.set(`${r.part}|${r.id}`, { part: r.part, id: r.id, at: new Date(now).toISOString() }); }
  }
  out.names = [...new Set([...(out.names || []), ...(patch.names || [])])].slice(0, LIMITS.names);
  out.related = [...new Set([...(out.related || []), ...(patch.related || [])])].slice(0, LIMITS.related);
  out.login.authHosts = [...new Set([...(out.login.authHosts || []), ...(patch.login?.authHosts || [])])].slice(0, LIMITS.authHosts);
  if (patch.family) out.family = patch.family;
  out.tombstones = [...tomb.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, LIMITS.tombstones);
  out.rev = (base.rev || 0) + 1; out.updated = new Date(now).toISOString();
  return shrink(out, now);
}

/** Keep a record under its size bound by dropping the weakest items. @param {any} rec @param {number} now */
function shrink(rec, now) {
  let guard = 0;
  while (recordBytes(rec) > LIMITS.recordBytes && guard++ < 5000) {
    let worst = null;
    for (const part of [...PARTS, "ready"]) for (const x of (part === "ready" ? rec.ready : rec[part])) { const s = score(x, now); if (!worst || s < worst.s) worst = { part, x, s }; }
    if (!worst) break;
    const list = worst.part === "ready" ? rec.ready : rec[worst.part]; list.splice(list.indexOf(worst.x), 1);
  }
  return rec;
}
export const recordBytes = (/** @type {any} */ r) => JSON.stringify(r).length;

/**
 * Two replicas of one record (this device and a box, or two computers): per item the newer `verified`
 * wins, counts take the larger, and a tombstone newer than an item removes it. Nothing is overwritten.
 * @param {any} a @param {any} b @param {{ now?: number }} [o]
 */
export function union(a, b, { now = Date.now() } = {}) {
  const out = JSON.parse(JSON.stringify(a));
  const tomb = new Map();
  for (const t of [...(a.tombstones || []), ...(b.tombstones || [])]) { const k = `${t.part}|${t.id}`; const o = tomb.get(k); if (!o || t.at > o.at) tomb.set(k, t); }
  const pick = (x, y) => { const vx = x.verified || "", vy = y.verified || ""; const w = vy > vx ? y : x; return { ...w, seen: Math.max(x.seen || 0, y.seen || 0), ...(w.count !== undefined ? { count: Math.max(x.count || 0, y.count || 0) } : {}), ...(w.runs !== undefined ? { runs: Math.max(x.runs || 0, y.runs || 0) } : {}) }; };
  const fold = (part, la, lb) => {
    const by = new Map(la.map(x => [itemId(part, x), x]));
    for (const y of lb) { const id = itemId(part, y); by.set(id, by.has(id) ? pick(by.get(id), y) : y); }
    return [...by.values()].filter(x => { const t = tomb.get(`${part}|${itemId(part, x)}`); return !t || (x.verified && x.verified >= t.at); });
  };
  for (const part of PARTS) out[part] = cap(fold(part, a[part] || [], b[part] || []), CAP[part], new Set(), now);
  for (const [part, get, set] of SIG_PARTS) set(out, cap(fold(part, get(a) || [], get(b) || []), CAP[part], new Set(), now));
  out.names = [...new Set([...(a.names || []), ...(b.names || [])])].slice(0, LIMITS.names);
  out.related = [...new Set([...(a.related || []), ...(b.related || [])])].slice(0, LIMITS.related);
  out.login.authHosts = [...new Set([...(a.login?.authHosts || []), ...(b.login?.authHosts || [])])].slice(0, LIMITS.authHosts);
  out.family = a.family || b.family || null;
  out.tombstones = [...tomb.values()].slice(0, LIMITS.tombstones);
  out.rev = Math.max(a.rev || 0, b.rev || 0) + 1; out.updated = new Date(now).toISOString();
  return shrink(out, now);
}

/**
 * What an origin reads: its own record merged with its family's. The origin's items win on the same
 * id; the family's fill in the rest. Read-only view; writes still name their target.
 * @param {any} origin @param {any} family
 */
export function mergeFamily(origin, family) {
  if (!family) return origin;
  const view = JSON.parse(JSON.stringify(origin));
  const fold = (la, lb, part) => { const by = new Map((lb || []).map(x => [itemId(part, x), x])); for (const x of la || []) by.set(itemId(part, x), x); return [...by.values()]; };
  for (const part of PARTS) view[part] = fold(origin[part], family[part], part);
  view.ready = fold(origin.ready, family.ready, "ready");
  view.login = { wall: fold(origin.login.wall, family.login.wall, "wall"), signedIn: fold(origin.login.signedIn, family.login.signedIn, "signedIn"),
    authHosts: [...new Set([...(origin.login.authHosts || []), ...(family.login.authHosts || [])])] };
  view.names = [...new Set([...(origin.names || []), ...(family.names || [])])].slice(0, LIMITS.names);
  view.family = origin.family || family.key.replace(/^family:/, "");
  return view;
}

/**
 * The small row Chrome reads on every arrival: signals, frames, the best controls for each page
 * template, and a name index of flows and API entries without their bodies. At most cardBytes.
 * @param {any} rec @param {{ now?: number }} [o]
 */
export function arrivalCard(rec, { now = Date.now() } = {}) {
  const byPage = new Map();
  for (const x of rec.controls) { if (isQuarantined(x)) continue; const l = byPage.get(x.page) || []; l.push(x); byPage.set(x.page, l); }
  const build = perPage => ({
    v: SITE_V, key: rec.key, rev: rec.rev, family: rec.family, names: rec.names, related: rec.related, ready: rec.ready, login: rec.login, frames: rec.frames,
    controls: [...byPage.values()].flatMap(l => l.sort((a, b) => readConf(b, now) - readConf(a, now)).slice(0, perPage)),
    flows: rec.flows.map(f => ({ name: f.name, title: f.title, src: f.src, conf: f.conf, verified: f.verified, params: f.params })),
    api: rec.api.map(e => ({ id: e.id, method: e.method, pathTemplate: e.pathTemplate, conf: e.conf, verified: e.verified })),
  });
  let n = LIMITS.perPageCard, card = build(n);
  while (JSON.stringify(card).length > LIMITS.cardBytes && n > 1) card = build(--n);
  // Still too big: thin the name index, weakest API entries first.
  while (JSON.stringify(card).length > LIMITS.cardBytes && card.api.length) card.api.pop();
  while (JSON.stringify(card).length > LIMITS.cardBytes && card.flows.length) card.flows.pop();
  return card;
}
export const cardBytes = (/** @type {any} */ c) => JSON.stringify(c).length;
