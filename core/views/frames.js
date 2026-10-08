// @ts-check
// The Capsule's frames: what a `view:` declaration and a tool's answer make (ADR 0033).
//
// Everything here is pure. A template is a string with {names} from a fixed set and nothing else;
// a `map` is dotted paths into the tool's JSON; a frame is small, versioned and bounded. The
// Capsule sends ids and never tool names, so this is the one place a declaration is turned into a
// call and an answer into something drawn.

import crypto from "node:crypto";

export const LIMITS = { rows: 50, bytes: 256 * 1024, string: 500, body: 8000, actions: 12, fields: 12 };

/** @param {any} v */
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/** A value at a dotted path, or undefined: `a.b.0.c`. No expressions. @param {any} obj @param {string} path */
export function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object" && typeof cur !== "string") return undefined;
    if (typeof cur === "string") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** @param {any} v @param {number} [max] */
export function clip(v, max = LIMITS.string) {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Fill {names} in a string from `vars`. An unknown name is an empty string. `allow` (when given)
 * limits which names may be filled at all; the rest fill as empty, whatever `vars` holds.
 * @param {string} tpl @param {Record<string, any>} vars @param {Set<string> | null} [allow]
 */
export function fill(tpl, vars, allow = null) {
  return String(tpl).replace(/\{([A-Za-z][A-Za-z0-9_.]{0,40})\}/g, (_m, name) => {
    if (allow && !allow.has(name)) return "";
    const v = vars[name];
    return v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v);
  });
}

/**
 * Fill a JSON value: strings are templates; a string that is exactly one {name} keeps the value's
 * own type (a number stays a number); arrays and objects are walked. Depth is bounded.
 * @param {any} value @param {Record<string, any>} vars @param {Set<string> | null} [allow] @param {number} [depth]
 * @returns {any}
 */
export function fillDeep(value, vars, allow = null, depth = 0) {
  if (depth > 6) return undefined;
  if (typeof value === "string") {
    const one = /^\{([A-Za-z][A-Za-z0-9_.]{0,40})\}$/.exec(value);
    if (one && (!allow || allow.has(one[1])) && vars[one[1]] !== undefined && vars[one[1]] !== null && typeof vars[one[1]] !== "object") return vars[one[1]];
    return fill(value, vars, allow);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(v => fillDeep(v, vars, allow, depth + 1));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, fillDeep(v, vars, allow, depth + 1)]));
  return value;
}

/** The names a template may fill: the row's own, the typed words, a form's fields, and `front.*` only when declared. */
export function allowed({ fields = [], front = false } = {}) {
  const base = ["q", "id", "title", "subtitle", "accessory", "url", "icon", "group", "column", ...fields];
  return new Set(front ? [...base, "front.app", "front.selection"] : base);
}

/**
 * A tool's answer, as the value the maps read: the data of a { data } answer.
 * @param {any} r
 */
export const dataOf = r => (r && typeof r === "object" && r.data !== undefined ? r.data : r);

/** @param {any} frame */
function bounded(frame) {
  let f = frame;
  while (f.kind === "list" && Buffer.byteLength(JSON.stringify(f)) > LIMITS.bytes && f.rows.length > 1) {
    f = { ...f, rows: f.rows.slice(0, Math.ceil(f.rows.length / 2)), more: true };
  }
  if (Buffer.byteLength(JSON.stringify(f)) > LIMITS.bytes) return error("too_big", "That answer is too large to show.");
  return f;
}

/** @param {string} code @param {string} message @param {string} [next] */
export const error = (code, message, next) => ({ v: 1, kind: "error", code, message: clip(message, 300), ...(next ? { next: clip(next, 200) } : {}) });

/**
 * Actions as the Capsule draws them: ids and titles, never the tools behind them.
 * @param {any[] | undefined} actions
 */
export function actionsOf(actions) {
  return (Array.isArray(actions) ? actions : []).slice(0, LIMITS.actions).map(a => ({
    id: String(a.id), title: clip(a.title, 60),
    ...(a.shortcut ? { shortcut: String(a.shortcut) } : {}), ...(a.confirm ? { confirm: true } : {}), ...(a.outward || (a.form) ? { outward: Boolean(a.outward) } : {}),
  }));
}

/**
 * A list frame from a tool's answer.
 * @param {any} list the declaration's `list` @param {any} answer the tool's data
 * @param {{ title: string, cursor?: string }} o
 * @returns {{ frame: any, rows: Map<string, Record<string, string>> }} the frame, and each row's fields for later templates
 */
export function listFrame(list, answer, o) {
  const map = isObj(list.map) ? list.map : {};
  const raw = map.rows !== undefined ? getPath(answer, map.rows) : Array.isArray(answer) ? answer : getPath(answer, "rows");
  const source = Array.isArray(raw) ? raw : [];
  /** @type {Map<string, Record<string, string>>} */
  const cache = new Map();
  const rows = [];
  for (const r of source.slice(0, LIMITS.rows)) {
    const get = (/** @type {string} */ k, /** @type {string} */ fallback) => clip(getPath(r, map[k] || fallback));
    const id = get("id", "id");
    if (!id) continue;
    const row = { id, title: get("title", "title") || get("title", "name"), subtitle: get("subtitle", "sub") || get("subtitle", "subtitle"), accessory: get("accessory", "accessory"), url: get("url", "url"), icon: get("icon", "icon"), group: get("group", "group") };
    cache.set(id, row);
    rows.push({ id, title: row.title, ...(row.subtitle ? { subtitle: row.subtitle } : {}), ...(row.icon ? { icon: row.icon } : {}), ...(row.accessory ? { accessory: row.accessory } : {}), ...(row.group ? { group: row.group } : {}), actions: actionsOf(list.actions) });
  }
  const more = source.length > LIMITS.rows;
  return { frame: bounded({ v: 1, kind: "list", title: clip(o.title, 60), rows, ...(more ? { more: true } : {}), ...(rows.length ? {} : { empty: clip(list.empty || "Nothing here.", 200) }) }), rows: cache };
}

/** A column id or a { id, title } as a column. @param {any} c */
const columnOf = c => (typeof c === "string" ? { id: c, title: c } : isObj(c) && typeof c.id === "string" ? { id: c.id, title: String(c.title || c.id) } : null);

/**
 * A board frame from a tool's answer: the rows of a list, grouped into the declared columns by the field `map.column` names.
 * A row whose value is no declared column goes to a last column "Other" (only when there are such rows).
 * @param {any} board the declaration's `board` @param {any} answer
 * @param {{ title: string }} o
 * @returns {{ frame: any, rows: Map<string, Record<string, string>> }}
 */
export function boardFrame(board, answer, o) {
  const { frame: base, rows: cache } = listFrame(board, answer, o);
  if (base.kind !== "list") return { frame: base, rows: cache };
  const map = isObj(board.map) ? board.map : {};
  const decl = (Array.isArray(board.columns) ? board.columns : []).slice(0, 8).map(columnOf).filter(Boolean);
  const raw = map.rows !== undefined ? getPath(answer, map.rows) : Array.isArray(answer) ? answer : getPath(answer, "rows");
  const source = (Array.isArray(raw) ? raw : []).slice(0, LIMITS.rows);
  /** @type {Map<string, string>} */ const colOf = new Map();
  for (const r of source) { const id = clip(getPath(r, map.id || "id")); if (id) colOf.set(id, clip(getPath(r, map.column || "column"))); }
  const columns = decl.map((/** @type {any} */ c) => ({ id: clip(c.id, 40), title: clip(c.title, 40), rows: /** @type {any[]} */ ([]) }));
  const other = { id: "other", title: "Other", rows: /** @type {any[]} */ ([]) };
  for (const row of base.rows) {
    const col = columns.find((/** @type {any} */ c) => c.id === colOf.get(row.id));
    (col || other).rows.push(row);
    const cached = cache.get(row.id); if (cached) cached.column = (col || other).id;
  }
  if (other.rows.length) columns.push(other);
  return { frame: bounded({ v: 1, kind: "board", title: base.title, columns, ...(base.more ? { more: true } : {}), ...(base.rows.length ? {} : { empty: clip(board.empty || "Nothing here.", 200) }) }), rows: cache };
}

/** A number as text, or "" when the value is not one. @param {any} v */
const numText = v => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? String(n) : ""; };

/**
 * A summary frame: counts as cards and one small bar or line chart, read from the tool's answer by dotted path.
 * map: { cards: [{ label, path }], chart: { kind: "bar" | "line", rows: path to an array, label: path, value: path } }
 * @param {any} summary @param {any} answer @param {{ title: string }} o
 */
export function summaryFrame(summary, answer, o) {
  const map = isObj(summary.map) ? summary.map : {};
  const cards = (Array.isArray(map.cards) ? map.cards : []).slice(0, 8)
    .map((/** @type {any} */ c) => { const v = getPath(answer, c.path); return { label: clip(c.label, 40), value: numText(v) || clip(v, 40) }; }).filter((/** @type {any} */ c) => c.value !== "");
  let chart;
  if (isObj(map.chart)) {
    const src = getPath(answer, map.chart.rows);
    const points = (Array.isArray(src) ? src : []).slice(0, 24).map((/** @type {any} */ r) => ({ label: clip(getPath(r, map.chart.label), 24), value: Number(numText(getPath(r, map.chart.value))) }))
      .filter((/** @type {any} */ p) => p.label && Number.isFinite(p.value));
    if (points.length) chart = { kind: map.chart.kind === "line" ? "line" : "bar", points };
  }
  return bounded({ v: 1, kind: "summary", title: clip(o.title, 60), cards, ...(chart ? { chart } : {}), ...(cards.length || chart ? {} : { empty: clip(summary.empty || "Nothing to count yet.", 200) }) });
}

/**
 * A detail frame from a tool's answer.
 * @param {any} detail the declaration's `detail` @param {any} answer @param {{ title: string, actions?: any[] }} o
 */
export function detailFrame(detail, answer, o) {
  const map = isObj(detail.map) ? detail.map : {};
  const fields = (Array.isArray(map.fields) ? map.fields : []).slice(0, LIMITS.fields)
    .map((/** @type {any} */ f) => ({ label: clip(f.label, 40), value: clip(getPath(answer, f.path)) })).filter((/** @type {any} */ f) => f.value);
  return bounded({ v: 1, kind: "detail", title: clip(getPath(answer, map.title || "title") || o.title, 120), body: clip(getPath(answer, map.body || "body"), LIMITS.body), fields, actions: actionsOf(o.actions) });
}

/**
 * A form frame. `defaults` fill fields that name a template.
 * @param {any} form @param {Record<string, any>} vars @param {string} formId
 */
export function formFrame(form, vars, formId) {
  const names = allowed({ fields: (form.fields || []).map((/** @type {any} */ f) => f.name) });
  return { v: 1, kind: "form", id: formId, title: clip(fill(form.title, vars, names), 100),
    fields: (form.fields || []).slice(0, LIMITS.fields).map((/** @type {any} */ f) => ({ name: f.name, label: clip(f.label, 60), type: f.type, ...(f.required ? { required: true } : {}), ...(Array.isArray(f.choices) ? { choices: f.choices.map(String) } : {}), ...(f.default !== undefined ? { default: clip(fill(String(f.default), vars, names)) } : {}) })),
    submit: { title: clip(form.submit.title, 60), ...(form.submit.outward ? { outward: true } : {}) } };
}

/** This process's secret for preview tokens: never written anywhere, gone on restart. */
const SECRET = crypto.randomBytes(32);
/** How long a preview may be confirmed. */
export const PREVIEW_MS = 2 * 60_000;

/**
 * A token proving a preview was made by this vyred for this caller and hash, valid for a couple of
 * minutes. The hash alone is public and repeatable; this is what the second Enter must carry.
 * @param {string} hash @param {string} caller @param {number} [now]
 */
export function previewToken(hash, caller, now = Date.now()) {
  const exp = now + PREVIEW_MS;
  return `${exp}.${crypto.createHmac("sha256", SECRET).update(`${hash}|${exp}|${caller}`).digest("hex").slice(0, 32)}`;
}

/** Does this token belong to a preview of this hash, for this caller, and is it still fresh? @param {string} hash @param {string} caller @param {any} token @param {number} [now] */
export function previewOk(hash, caller, token, now = Date.now()) {
  const [exp, mac] = String(token || "").split(".");
  if (!/^\d{10,16}$/.test(exp || "") || !mac || Number(exp) < now || Number(exp) > now + PREVIEW_MS + 1000) return false;
  const want = crypto.createHmac("sha256", SECRET).update(`${hash}|${exp}|${caller}`).digest("hex").slice(0, 32);
  return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac));
}

/** The hash an asked send is bound to: the exact tool and input, in a fixed key order. @param {string} module @param {string} tool @param {any} input */
export function askedHash(module, tool, input) {
  const canon = (/** @type {any} */ v) => Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
  return crypto.createHash("sha256").update(JSON.stringify([module, tool, canon(input)])).digest("hex").slice(0, 32);
}

/** Schemes an added module may open: links that go somewhere. A vyre: link can act (pair, sign in, approve), so it is a first party module's alone. */
const ADDED_SCHEMES = new Set(["https:", "mailto:"]);

/**
 * A finished `do` effect, filled and checked. An added module may open https, mailto and Vyre links only.
 * @param {Record<string, string>} effect one key: open, copy, say, ask, push @param {Record<string, any>} vars @param {Set<string>} names @param {boolean} firstParty
 * @returns {{ effect: Record<string, string> } | { error: any }}
 */
export function effectOf(effect, vars, names, firstParty) {
  const [kind, tpl] = Object.entries(effect)[0];
  const value = fill(tpl, vars, names);
  if (kind === "open") {
    let u;
    try { u = new URL(value); } catch { return { error: error("bad_url", "That link is not one Vyre opens.") }; }
    const ok = ADDED_SCHEMES.has(u.protocol) || (firstParty && (u.protocol === "vyre:" || u.protocol === "http:" || u.protocol === "file:" || u.protocol === "x-apple.systempreferences:"));
    if (!ok) return { error: error("bad_url", `Vyre does not open ${u.protocol} links from a module.`) };
  }
  return { effect: { [kind]: clip(value, kind === "copy" || kind === "say" || kind === "ask" ? 4000 : 2000) } };
}
