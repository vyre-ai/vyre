// GENERATED from lib/siteops/spec.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// spec: the shape of a learned website operation, and the one validator for it. Replaces the zod schema of api-anything (github.com/goodnight000/api-anything, MIT; see NOTICE) with
// a plain checker, so the module stays dependency free and runs in the extension.
//
// An operation is data. It holds the captured request as a TEMPLATE: slots say where each input goes (through decoded layers, see codec.js), refs say where a credential comes from
// (`cookie:<name>` or `session:<name>`, resolved only inside the page that signs the request), and no credential value is ever written into it.

import { parseSelector } from "./htmlparse.js";

export const KINDS = Object.freeze(["read", "draft", "change", "send", "spend", "delete"]);
export const RUNGS = Object.freeze(["page", "public", "box", "mac"]);
const STEP = /^(path:\d+|(query|form)(\[\d+\])?:.+|header:.+|json:(\/.*)?|b64|body)$/;
const REF = /^(cookie|session):.+/;
const PARAM_TYPES = ["string", "number", "boolean", "object", "array"];
const NAME = /^[a-z][A-Za-z0-9_]{0,63}$/;

const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validRegex = (/** @type {string} */ p) => { try { new RegExp(p); return true; } catch { return false; } };

/**
 * Check an operation and fill its defaults. Never throws: returns { ok: true, op } or { ok: false, problems }. Unknown fields are dropped.
 * @param {any} input
 * @returns {{ ok: true, op: any } | { ok: false, problems: string[] }}
 */
export function parseOperation(input) {
  /** @type {string[]} */ const bad = [];
  const o = isObj(input) ? input : {};
  if (!isObj(input)) bad.push("an operation is an object");
  if (typeof o.name !== "string" || !NAME.test(o.name)) bad.push("name: a camelCase word such as listContacts");
  const kind = o.kind === undefined ? (o.readOnly === false ? "change" : "read") : o.kind;
  if (!KINDS.includes(kind)) bad.push(`kind: one of ${KINDS.join(", ")}`);
  const r = isObj(o.request) ? o.request : {};
  if (typeof r.method !== "string" || typeof r.url !== "string") bad.push("request: { method, url }");
  const headers = isObj(r.headers) ? Object.fromEntries(Object.entries(r.headers).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.toLowerCase(), v])) : {};

  const slots = (Array.isArray(o.slots) ? o.slots : []).map((/** @type {any} */ s, /** @type {number} */ i) => {
    const w = `slots[${i}]`;
    if (!isObj(s)) { bad.push(`${w}: an object`); return null; }
    if ((s.param === undefined) === (s.ref === undefined)) bad.push(`${w}: exactly one of param or ref`);
    if (s.ref !== undefined && !(typeof s.ref === "string" && REF.test(s.ref))) bad.push(`${w}: ref is cookie:<name> or session:<name>`);
    if (!Array.isArray(s.at) || !s.at.length || !s.at.every((/** @type {any} */ x) => typeof x === "string" && STEP.test(x))) bad.push(`${w}: at is a list of steps (path:<i>, query:<k>, header:<n>, form:<k>, json:<pointer>, b64, body)`);
    if (s.escape !== undefined && !["url", "json"].includes(s.escape)) bad.push(`${w}: escape is url or json`);
    if (s.transform !== undefined && !["strip-quotes", "url-decode"].includes(s.transform)) bad.push(`${w}: transform`);
    return { ...(s.param !== undefined ? { param: String(s.param) } : {}), ...(s.ref !== undefined ? { ref: String(s.ref) } : {}), at: s.at, ...(s.template !== undefined ? { template: String(s.template) } : {}),
      ...(s.transform ? { transform: s.transform } : {}), ...(s.escape ? { escape: s.escape } : {}) };
  }).filter(Boolean);

  const volatile = (Array.isArray(o.volatile) ? o.volatile : []).map((/** @type {any} */ v, /** @type {number} */ i) => {
    if (!isObj(v) || !Array.isArray(v.at) || !isObj(v.shape) || typeof v.anchor !== "string") { bad.push(`volatile[${i}]: { at, shape, anchor }`); return null; }
    return { at: v.at, shape: { charset: v.shape.charset, length: v.shape.length }, anchor: v.anchor };
  }).filter(Boolean);

  const t = isObj(o.trigger) ? o.trigger : {};
  if (typeof t.url !== "string") bad.push("trigger: { url, steps? }");
  const steps = (Array.isArray(t.steps) ? t.steps : []).map((/** @type {any} */ s, /** @type {number} */ i) => {
    if (!isObj(s) || !["click", "fill", "press", "wait", "goto"].includes(s.action)) { bad.push(`trigger.steps[${i}]: action click, fill, press, wait or goto`); return null; }
    return { action: s.action, ...(s.selector !== undefined ? { selector: String(s.selector) } : {}), ...(s.value !== undefined ? { value: String(s.value) } : {}), ...(typeof s.ms === "number" ? { ms: s.ms } : {}) };
  }).filter(Boolean);

  const m = isObj(o.match) ? o.match : {};
  const rs = isObj(o.response) ? o.response : {};
  if (rs.format !== undefined && !["json", "html", "embedded"].includes(rs.format)) bad.push("response.format: json, html or embedded");
  if (Array.isArray(rs.pick)) for (const p of rs.pick) if (typeof p !== "string" || (p.includes("~") && !validRegex(p.slice(p.indexOf("~") + 1)))) bad.push("response.pick: strings; the regex after ~ must be valid");
  if (isObj(rs.embedded) && !validRegex(String(rs.embedded.regex))) bad.push("response.embedded.regex must be a valid regular expression");
  if (rs.html !== undefined) {
    const r = rs.html;
    let ok = isObj(r) && typeof r.items === "string" && isObj(r.fields) && Object.keys(r.fields).length > 0;
    if (ok) { try { parseSelector(r.items); for (const f of Object.values(r.fields)) parseSelector(typeof f === "string" ? (f || "*") : String(isObj(f) ? f.sel || "*" : "")); } catch { ok = false; } }
    if (!ok) bad.push("response.html: { items: a selector, fields: { name: a selector or { sel, attr? } } }");
  }

  const params = (Array.isArray(o.params) ? o.params : []).map((/** @type {any} */ p, /** @type {number} */ i) => {
    if (!isObj(p) || typeof p.name !== "string" || !p.name) { bad.push(`params[${i}]: a name`); return null; }
    if (p.type !== undefined && !PARAM_TYPES.includes(p.type)) bad.push(`params[${i}]: type ${PARAM_TYPES.join(", ")}`);
    if (p.pattern !== undefined && !validRegex(String(p.pattern))) bad.push(`params[${i}]: pattern must be a valid regular expression`);
    return { name: p.name, type: p.type ?? "string", required: p.required !== false, ...(p.description ? { description: String(p.description) } : {}),
      ...(p.example !== undefined ? { example: p.example } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.pattern ? { pattern: String(p.pattern) } : {}), ...(p.hint ? { hint: String(p.hint) } : {}) };
  }).filter(Boolean);
  const names = new Set(params.map((/** @type {any} */ p) => p.name));
  for (const s of slots) if (s && s.param !== undefined && !names.has(s.param)) bad.push(`slot param ${s.param} is not a declared param`);

  const rungs = Array.isArray(o.rungs) && o.rungs.length ? o.rungs : ["page"];
  if (!rungs.every((/** @type {any} */ x) => RUNGS.includes(x))) bad.push(`rungs: any of ${RUNGS.join(", ")}`);
  if (bad.length) return { ok: false, problems: bad };

  return { ok: true, op: {
    name: o.name, ...(o.description ? { description: String(o.description) } : {}), kind,
    version: Number.isInteger(o.version) && o.version > 0 ? o.version : 1,
    request: { method: String(r.method).toUpperCase(), url: r.url, headers, ...(r.body !== undefined ? { body: String(r.body) } : {}) },
    slots, volatile,
    trigger: { url: t.url, ...(steps.length ? { steps } : {}), ...(typeof t.softFrom === "string" ? { softFrom: t.softFrom } : {}) },
    match: { ...(m.method ? { method: String(m.method) } : {}), ...(m.host ? { host: String(m.host) } : {}), ...(m.path ? { path: String(m.path) } : {}), ...(m.operationName ? { operationName: String(m.operationName) } : {}) },
    response: { format: rs.format ?? "json", ...(rs.contentType ? { contentType: String(rs.contentType) } : {}), ...(rs.xssiPrefix ? { xssiPrefix: String(rs.xssiPrefix) } : {}),
      ...(rs.extract ? { extract: String(rs.extract) } : {}), ...(Array.isArray(rs.pick) && rs.pick.length ? { pick: rs.pick } : {}), ...(isObj(rs.shape) ? { shape: rs.shape } : {}),
      ...(isObj(rs.html) ? { html: rs.html } : {}), ...(isObj(rs.embedded) ? { embedded: rs.embedded } : {}) },
    params, rungs,
    ...(Array.isArray(o.public) && o.public.length ? { public: o.public.map(String) } : {}),
    minTier: [1, 2, 3].includes(o.minTier) ? o.minTier : 1,
    login: o.login === true,
    ...(typeof o.learnedAt === "string" ? { learnedAt: o.learnedAt } : {}),
  } };
}

/** True when the operation only reads: nothing it sends changes anything on the site. @param {{ kind: string }} op */
export const readOnly = op => op.kind === "read";
