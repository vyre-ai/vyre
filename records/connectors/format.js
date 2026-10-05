// @ts-check
// A connector is a declaration (team/0.3/PLAN-platform-gaps-0.2.9.md, item 5): data that says where a service lives, how the vault signs in to it, what can be asked of it and
// which of those asks are outward. A new service is one declaration, plus at most a small mapping for what it answers; nothing here opens a connection or holds a secret.
//
//   {
//     id: "stripe", label: "Stripe", version: 1,
//     base_url: "https://api.stripe.com",                              one exact host, https
//     auth: { type: "bearer" } | { type: "api-key", header } | { type: "oauth", authorize_uri, token_uri, scopes } | { type: "service-account", scopes },
//     rate: { per_minute, retry_after: true },                         the provider's cap, shared by the whole Space; retry_after: honour its Retry-After
//     idempotency: { header: "Idempotency-Key" },                      the provider takes an idempotency key in this header; left out, it does not
//     ops: { "customers.create": { method, path: "/v1/customers/{id}", kind, label, input: { params, query, body, encoding }, output, readback, idempotent } },
//     poll: { "charges.recent": { op, items, id, map, ... } },         a read op a watcher may poll (item 7)
//     inbound: { webhook: { events: [...], emits } },                  what the service pushes to the Space (a webhook the mapping code verifies)
//   }
//
// kind says what an op does to the outside world, and it is the only source of "outward": read (runs at once), draft (prepares something a person sends there: not outward), change
// (writes in the service), send, spend, delete (outward, held for a yes by the one approvals queue). Anything not declared is not callable at all.
//
// `compile` turns a declaration into what the rest of Vyre already reads: the vault's api-credential config (hosts, auth, endpoints, rate, and the `service` rules a Flow's "Call a
// service" step is checked against, carrying the extra fields the step runner needs: ops, idempotency, rate, draft). `buildRequest` and `parseResponse` are the shape checks for one op.

import { mapItem, field as mapField } from "./mapper.js";

export const KINDS = Object.freeze(["read", "draft", "change", "send", "spend", "delete"]);
export const OUTWARD_KINDS = Object.freeze(["change", "send", "spend", "delete"]);
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const OP_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/;
const TYPES = ["string", "number", "boolean", "object", "array", "time", "email"];
const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @typedef {{ type: string, required?: boolean, enum?: any[], max?: number, items?: Shape, fields?: Record<string, Shape> }} Shape */
/** @typedef {{ params?: Record<string, Shape>, query?: Record<string, Shape>, body?: Record<string, Shape>, encoding?: "json" | "form" }} OpInput */
/** @typedef {{ method: string, path: string, kind: string, label?: string, input?: OpInput, output?: Record<string, Shape>, idempotent?: boolean,
 *   readback?: { op: string, args: Record<string, string>, compare?: Record<string, string> }, wrap?: string }} Op */
/** @typedef {{ op: string, items?: string, id: string, at?: string, title?: string, args?: { query?: Record<string, any>, params?: Record<string, string> }, since?: { lookback_days?: number },
 *   expand?: { op: string, args: Record<string, string>, query?: Record<string, any> }, map: Record<string, any>, every_minutes?: number, label?: string }} Poll */
/** @typedef {{ id: string, label: string, version: number, base_url: string, auth: any, rate?: { per_minute: number, retry_after?: boolean }, idempotency?: { header: string },
 *   ops: Record<string, Op>, poll?: Record<string, Poll>, inbound?: { webhook: { events: string[], emits: string } }, deny?: { method?: string, path: string }[] }} Declaration */

/** @param {any} s @param {string} path @param {string[]} out */
function checkShape(s, path, out) {
  if (!isObj(s) || !TYPES.includes(s.type)) { out.push(`${path}: a shape is { type: ${TYPES.join(" | ")} }`); return; }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) out.push(`${path}.enum: a non-empty list`);
  if (s.items !== undefined) checkShape(s.items, `${path}.items`, out);
  if (s.fields !== undefined) { if (!isObj(s.fields)) out.push(`${path}.fields: an object of shapes`); else for (const [k, v] of Object.entries(s.fields)) checkShape(v, `${path}.fields.${k}`, out); }
}

/** @param {any} sh @param {string} path @param {string[]} out */
function checkShapes(sh, path, out) {
  if (sh === undefined) return;
  if (!isObj(sh)) { out.push(`${path}: an object of names and shapes`); return; }
  for (const [k, v] of Object.entries(sh)) { if (!/^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,63}$/.test(k)) out.push(`${path}.${k}: not a usable name`); checkShape(v, `${path}.${k}`, out); }
}

const placeholders = (/** @type {string} */ path) => [...path.matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)].map(m => m[1]);

/**
 * Check a declaration. Returns every problem found, each a plain sentence naming where.
 * @param {any} d @returns {string[]}
 */
export function checkDeclaration(d) {
  /** @type {string[]} */ const out = [];
  if (!isObj(d)) return ["a connector is an object"];
  if (typeof d.id !== "string" || !ID_RE.test(d.id)) out.push("id: lowercase letters, digits, - and _, starting with a letter");
  if (typeof d.label !== "string" || !d.label || d.label.length > 80) out.push("label: a short name");
  if (!Number.isInteger(d.version) || d.version < 1) out.push("version: a whole number from 1");
  let host = "";
  try {
    const u = new URL(String(d.base_url));
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("x");
    host = u.hostname;
    if (host.includes("*") || !host.includes(".")) throw new Error("x");
  } catch { out.push("base_url: one exact https host with no path, such as https://api.example.com"); }
  const a = d.auth;
  if (!isObj(a) || !["bearer", "api-key", "oauth", "service-account"].includes(a.type)) out.push("auth.type: bearer, api-key, oauth or service-account");
  else {
    if (a.type === "oauth" && (typeof a.authorize_uri !== "string" || !a.authorize_uri.startsWith("https://") || typeof a.token_uri !== "string" || !a.token_uri.startsWith("https://"))) out.push("auth: oauth names https authorize_uri and token_uri");
    if ((a.type === "oauth" || a.type === "service-account") && a.scopes !== undefined && !(Array.isArray(a.scopes) && a.scopes.every((/** @type {any} */ x) => typeof x === "string"))) out.push("auth.scopes: a list of strings");
    if ((a.type === "service-account" || (a.also !== undefined && a.type === "oauth")) && !(Array.isArray(a.scopes) && a.scopes.length)) out.push("auth.scopes: a service account names the scopes it acts with");
    if (a.also !== undefined && !(Array.isArray(a.also) && a.also.every((/** @type {any} */ x) => x === "service-account"))) out.push("auth.also: [\"service-account\"], the other way a person may sign in");
    if (a.type === "api-key" && a.header !== undefined && (typeof a.header !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(a.header))) out.push("auth.header: a header name");
  }
  if (d.rate !== undefined && !(isObj(d.rate) && Number.isInteger(d.rate.per_minute) && d.rate.per_minute >= 1 && d.rate.per_minute <= 6000 && (d.rate.retry_after === undefined || typeof d.rate.retry_after === "boolean"))) out.push("rate: { per_minute: 1 to 6000, retry_after?: true }");
  if (d.idempotency !== undefined && !(isObj(d.idempotency) && typeof d.idempotency.header === "string" && /^[A-Za-z0-9-]{1,64}$/.test(d.idempotency.header))) out.push("idempotency: { header: the header the service reads the key from }");
  if (!isObj(d.ops) || !Object.keys(d.ops).length) { out.push("ops: at least one operation"); return out; }
  const seen = new Set();
  for (const [name, op] of Object.entries(/** @type {Record<string, any>} */ (d.ops))) {
    const p = `ops.${name}`;
    if (!OP_RE.test(name)) out.push(`${p}: an op name is words joined by dots, such as customers.create`);
    if (!isObj(op)) { out.push(`${p}: an object`); continue; }
    if (!METHODS.includes(op.method)) out.push(`${p}.method: ${METHODS.join(", ")}`);
    if (typeof op.path !== "string" || !/^\/[A-Za-z0-9._~\/{}:*-]{0,200}$/.test(op.path) || op.path.split("/").includes("..") || /\*/.test(op.path)) out.push(`${p}.path: starts with /, plain segments and {params}, no wildcard`);
    if (!KINDS.includes(op.kind)) out.push(`${p}.kind: ${KINDS.join(", ")}`);
    if (op.kind === "read" && !["GET", "HEAD"].includes(op.method)) out.push(`${p}: a read is a GET or HEAD`);
    if (op.kind !== "read" && ["GET", "HEAD"].includes(op.method)) out.push(`${p}: a ${op.kind} is not a GET or HEAD`);
    const sig = `${op.method} ${String(op.path).replace(/\{[^}]*\}/g, "*")}`;
    if (seen.has(sig)) out.push(`${p}: ${sig} is declared twice, so a request could not tell which op it is`); seen.add(sig);
    const inp = op.input;
    if (inp !== undefined) {
      if (!isObj(inp)) out.push(`${p}.input: an object`);
      else {
        for (const k of Object.keys(inp)) if (!["params", "query", "body", "encoding"].includes(k)) out.push(`${p}.input.${k}: not part of an op's input`);
        checkShapes(inp.params, `${p}.input.params`, out); checkShapes(inp.query, `${p}.input.query`, out); checkShapes(inp.body, `${p}.input.body`, out);
        if (inp.encoding !== undefined && !["json", "form"].includes(inp.encoding)) out.push(`${p}.input.encoding: json or form`);
      }
    }
    for (const ph of typeof op.path === "string" ? placeholders(op.path) : []) if (!(inp && isObj(inp.params) && inp.params[ph])) out.push(`${p}: the path names {${ph}} but input.params does not`);
    checkShapes(op.output, `${p}.output`, out);
    if (op.idempotent !== undefined && typeof op.idempotent !== "boolean") out.push(`${p}.idempotent: true or false`);
    if (op.wrap !== undefined && (op.kind !== "draft" || typeof op.wrap !== "string" || !/^[a-z_]{1,32}$/.test(op.wrap))) out.push(`${p}.wrap: only a draft op wraps its body, in one named field`);
    if (op.readback !== undefined) {
      const rb = op.readback, rop = isObj(rb) && isObj(d.ops) ? d.ops[rb.op] : undefined;
      if (op.kind === "read") out.push(`${p}.readback: a read has nothing to read back`);
      if (!isObj(rb) || !rop || rop.kind !== "read") out.push(`${p}.readback.op: names a read op of this connector`);
      else {
        for (const ph of placeholders(rop.path)) if (typeof rb.args?.[ph] !== "string") out.push(`${p}.readback.args: gives no value for {${ph}}`);
        for (const v of Object.values(/** @type {Record<string, any>} */ (rb.args || {}))) if (typeof v !== "string" || !/^(response\.json|request\.(body|params|query))\./.test(v)) out.push(`${p}.readback.args: a value is response.json.<path> or request.body|params|query.<name>`);
        for (const [k, v] of Object.entries(/** @type {Record<string, any>} */ (rb.compare || {}))) if (typeof v !== "string" || !/^request\.(body|params|query)\./.test(v) || !k) out.push(`${p}.readback.compare.${k}: a read-back path compared with request.body|params|query.<name>`);
      }
    }
  }
  if (isObj(d.ops)) {
    const drafts = Object.entries(d.ops).filter(([, o]) => isObj(o) && o.kind === "draft");
    if (drafts.length > 1) out.push("ops: at most one draft op (the one a Draft only rule uses in place of a send)");
    for (const [n, o] of drafts) if (placeholders(o.path).length) out.push(`ops.${n}: the draft op has a fixed path, with no {params}`);
  }
  if (d.poll !== undefined) {
    if (!isObj(d.poll)) out.push("poll: an object of named polls");
    else for (const [name, poll] of Object.entries(/** @type {Record<string, any>} */ (d.poll))) {
      const p = `poll.${name}`;
      if (!OP_RE.test(name)) out.push(`${p}: a poll name is words joined by dots`);
      const op = d.ops[poll && poll.op];
      if (!op || op.kind !== "read") out.push(`${p}.op: names a read op of this connector`);
      else for (const ph of placeholders(op.path)) if (typeof poll.args?.params?.[ph] !== "string") out.push(`${p}.args.params: gives no value for {${ph}}`);
      if (!isObj(poll) || !(typeof poll.id === "string" ? poll.id : isObj(poll.id) && typeof poll.id.template === "string")) out.push(`${p}.id: the path (or template) of an item's own id`);
      if (poll.items !== undefined && typeof poll.items !== "string") out.push(`${p}.items: the path of the list in the answer`);
      if (!isObj(poll.map)) out.push(`${p}.map: how an item is filed (field -> path)`);
      else { try { mapItem({}, poll.map, {}); } catch (e) { out.push(`${p}.map: ${/** @type {Error} */ (e).message}`); } }
      if (poll.expand !== undefined) { const eo = d.ops[poll.expand && poll.expand.op]; if (!eo || eo.kind !== "read") out.push(`${p}.expand.op: names a read op of this connector`); else for (const ph of placeholders(eo.path)) if (typeof poll.expand.args?.[ph] !== "string") out.push(`${p}.expand.args: gives no value for {${ph}}`); }
      if (poll.every_minutes !== undefined && !(Number.isInteger(poll.every_minutes) && poll.every_minutes >= 5 && poll.every_minutes <= 1440)) out.push(`${p}.every_minutes: 5 to 1440`);
    }
  }
  if (d.inbound !== undefined) {
    const w = isObj(d.inbound) ? d.inbound.webhook : undefined;
    if (!isObj(w) || !Array.isArray(w.events) || !w.events.length || !w.events.every((/** @type {any} */ e) => typeof e === "string") || typeof w.emits !== "string" || !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(w.emits)) out.push("inbound.webhook: { events: [the service's event names], emits: noun.past-verb }");
  }
  if (d.deny !== undefined && !(Array.isArray(d.deny) && d.deny.every((/** @type {any} */ r) => isObj(r) && typeof r.path === "string" && /^\/[A-Za-z0-9._~\/*{}-]{0,200}$/.test(r.path)))) out.push("deny: a list of { method?, path } the connector never reaches");
  return out;
}

/** The declaration itself, or an Error naming every problem. @param {any} d @returns {Declaration} */
export function defineConnector(d) {
  const problems = checkDeclaration(d);
  if (problems.length) throw Object.assign(new Error(`connector ${isObj(d) && d.id ? d.id : ""}: ${problems.join("; ")}`), { code: "bad_input", problems });
  return /** @type {Declaration} */ (d);
}

/** @param {Op} op */
export const isOutward = op => OUTWARD_KINDS.includes(op.kind);
/** The path pattern the vault's rules read: each {param} one whole segment. @param {string} path */
/** @param {any} spec @param {any} raw @param {Record<string, any>} [vars] one field of a poll's mapping, evaluated (for the poll's id) */
export const mapped = (spec, raw, vars = {}) => mapField(raw, spec, vars);
export const patternOf = path => path.replace(/\{[^}]*\}/g, "*");

/**
 * What the declaration becomes in the vault: an api-credential's config. The host is the declaration's; `subject` is the address a service account acts as and `client` the vault item that
 * holds an oauth app's client id and secret, both chosen by the person at install and never by a request.
 * @param {Declaration} d @param {{ as?: "service-account", subject?: string, client?: string | { item: string, field?: string }, item?: string, field?: string }} [o]
 */
export function toCredentialConfig(d, o = {}) {
  const a = d.auth, host = new URL(d.base_url).hostname;
  /** @type {any} */ let auth;
  if (o.as === "service-account" && !(a.type === "service-account" || (Array.isArray(a.also) && a.also.includes("service-account")))) throw Object.assign(new Error(`${d.id} does not sign in as a service account`), { code: "bad_input" });
  if (a.type === "service-account" || o.as === "service-account") {
    if (!o.subject) throw Object.assign(new Error(`${d.id} acts as a person: say which address (subject)`), { code: "bad_input" });
    auth = { type: "service-account", ...(o.item ? { item: o.item, ...(o.field ? { field: o.field } : {}) } : {}), subject: o.subject, scopes: a.scopes };
  } else if (a.type === "oauth") {
    if (!o.client) throw Object.assign(new Error(`${d.id} signs in with an app of the person's own: name the vault item holding its client id and secret (client)`), { code: "bad_input" });
    auth = { type: "oauth", client: typeof o.client === "string" ? { item: o.client } : o.client, authorize_uri: a.authorize_uri, token_uri: a.token_uri, scopes: a.scopes || [] };
  } else {
    auth = { type: a.type, ...(o.item ? { item: o.item, ...(o.field ? { field: o.field } : {}) } : {}), ...(a.header ? { header: a.header } : {}), ...(a.format ? { format: a.format } : {}) };
  }
  // The vault's classes are read, send, spend and delete; a change in the service is held like a send, and a draft is the one non-read thing that is not held.
  const cls = (/** @type {Op} */ op) => (op.kind === "read" || op.kind === "draft" ? "read" : op.kind === "change" ? "send" : op.kind);
  const ops = Object.values(d.ops);
  return {
    auth, hosts: [host],
    endpoints: ops.map(op => ({ method: op.method, path: patternOf(op.path), kind: cls(op) })),
    ...(d.rate ? { rate: { per_minute: d.rate.per_minute } } : {}),
    service: serviceOf(d),
  };
}

/**
 * What a Flow's "Call a service" step is checked against, and what the step runner reads beside it: the allow and deny rules, the draft op, and the declaration's own words about
 * idempotency, rate and each op (whether it is outward or a read, its read-back pairing).
 * @param {Declaration} d
 */
export function serviceOf(d) {
  const ops = Object.entries(d.ops);
  const draft = ops.find(([, op]) => op.kind === "draft");
  return {
    allow: ops.map(([, op]) => ({ method: op.method, path: patternOf(op.path) })),
    deny: (d.deny || []).map(r => ({ ...(r.method ? { method: r.method } : {}), path: r.path })),
    ...(draft ? { draft: { method: draft[1].method, path: draft[1].path, ...(draft[1].wrap ? { wrap: draft[1].wrap } : {}) } } : {}),
    ...(d.idempotency ? { idempotency: { header: d.idempotency.header } } : {}),
    ...(d.rate ? { rate: { per_minute: d.rate.per_minute, retry_after: d.rate.retry_after !== false } } : {}),
    ops: ops.map(([name, op]) => ({
      name, method: op.method, path: patternOf(op.path), read: op.kind === "read", outward: isOutward(op),
      ...(op.idempotent === false ? { idempotent: false } : {}),
      ...(op.readback ? { readback: readbackOf(d, op) } : {}),
    })),
  };
}

/** @param {Declaration} d @param {Op} op */
function readbackOf(d, op) {
  const rb = /** @type {NonNullable<Op["readback"]>} */ (op.readback), rop = d.ops[rb.op];
  return { method: rop.method, path: rop.path, vars: { ...rb.args }, ...(rb.compare ? { compare: { ...rb.compare } } : {}) };
}

/** @param {any} v @param {Shape} s @param {string} path @param {string[]} out */
function checkValue(v, s, path, out) {
  const t = s.type;
  const bad = (/** @type {string} */ m) => { out.push(`${path}: ${m}`); };
  if (t === "string" || t === "email") { if (typeof v !== "string") return bad("text"); if (s.max !== undefined && v.length > s.max) bad(`at most ${s.max} characters`); if (t === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad("an email address"); }
  else if (t === "number") { if (typeof v !== "number" || !Number.isFinite(v)) return bad("a number"); }
  else if (t === "boolean") { if (typeof v !== "boolean") return bad("true or false"); }
  else if (t === "time") { if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return bad("a date and time"); }
  else if (t === "array") { if (!Array.isArray(v)) return bad("a list"); if (s.items) v.forEach((x, i) => checkValue(x, s.items, `${path}[${i}]`, out)); }
  else if (t === "object") { if (!isObj(v)) return bad("an object"); if (s.fields) checkFields(v, s.fields, path, out, true); }
  if (s.enum && !s.enum.includes(v)) bad(`one of ${s.enum.join(", ")}`);
}

/** @param {any} obj @param {Record<string, Shape>} shapes @param {string} path @param {string[]} out @param {boolean} strict an unnamed field is a problem */
function checkFields(obj, shapes, path, out, strict) {
  for (const [k, s] of Object.entries(shapes)) {
    const v = obj ? obj[k] : undefined;
    if (v === undefined || v === null) { if (s.required) out.push(`${path}.${k}: needed`); continue; }
    checkValue(v, s, `${path}.${k}`, out);
  }
  if (strict && obj) for (const k of Object.keys(obj)) if (!Object.hasOwn(shapes, k)) out.push(`${path}.${k}: not part of this`);
}

/**
 * The request for one op, from what a person or Flow supplies: the path filled in, the query and body checked against the op's declared shapes. An input the op does not declare is
 * refused, never passed along. @param {Declaration} d @param {string} name @param {{ params?: any, query?: any, body?: any }} [input]
 * @returns {{ method: string, path: string, query?: Record<string, any>, body?: any, headers?: Record<string, string> }}
 */
export function buildRequest(d, name, input = {}) {
  const op = d.ops[name];
  if (!op) throw Object.assign(new Error(`${d.id} has no op ${name}`), { code: "not_found" });
  const sh = op.input || {}, problems = /** @type {string[]} */ ([]);
  checkFields(input.params || {}, sh.params || {}, "params", problems, true);
  checkFields(input.query || {}, sh.query || {}, "query", problems, true);
  if (sh.body) checkFields(input.body || {}, sh.body, "body", problems, true); else if (input.body !== undefined) problems.push("body: this op takes none");
  if (problems.length) throw Object.assign(new Error(`${d.id} ${name}: ${problems.join("; ")}`), { code: "bad_input", problems });
  const path = op.path.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_m, k) => encodeURIComponent(String(input.params[k])));
  return {
    method: op.method, path,
    ...(input.query && Object.keys(input.query).length ? { query: input.query } : {}),
    ...(sh.body && input.body !== undefined ? { body: op.wrap ? { [op.wrap]: input.body } : input.body } : {}),
    ...(sh.body && sh.encoding === "form" ? { headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
  };
}

/** The op a method and path belong to (the first whose pattern fits), or null. @param {Declaration} d @param {string} method @param {string} path */
export function opFor(d, method, path) {
  for (const [name, op] of Object.entries(d.ops)) {
    if (op.method !== method.toUpperCase()) continue;
    const re = new RegExp("^" + op.path.split(/\{[^}]*\}/).map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$");
    if (re.test(path)) return { name, op };
  }
  return null;
}

/**
 * Check an answer against the op's declared output shape. Fields the shape does not name are allowed (a service adds fields); a named one that is missing or the wrong type is a problem.
 * @param {Declaration} d @param {string} name @param {{ status: number, json?: any }} res
 */
export function parseResponse(d, name, res) {
  const op = d.ops[name];
  if (!op) throw Object.assign(new Error(`${d.id} has no op ${name}`), { code: "not_found" });
  /** @type {string[]} */ const problems = [];
  if (!(res.status >= 200 && res.status < 300)) return { ok: false, status: res.status, problems: [`the service answered ${res.status}`] };
  if (op.output) checkFields(res.json, op.output, "response", problems, false);
  return { ok: problems.length === 0, status: res.status, json: res.json, problems };
}

/** The value a read-back reference names. @param {string} ref @param {{ request: any, response: any }} ctx */
function refValue(ref, ctx) {
  const m = /^(response\.json|request\.(?:body|params|query))\.(.+)$/.exec(ref);
  if (!m) return undefined;
  const root = m[1] === "response.json" ? ctx.response && ctx.response.json : ctx.request && ctx.request[m[1].split(".")[1]];
  let cur = root;
  for (const k of m[2].split(".")) { if (cur === null || typeof cur !== "object" || k === "__proto__" || k === "constructor") return undefined; cur = cur[k]; }
  return cur;
}

/**
 * The read that checks a write: the paired read op's request, with its {params} filled from the write's request and answer. Null when the op declares no pairing.
 * @param {Declaration} d @param {string} name @param {{ request: { params?: any, query?: any, body?: any }, response: { json?: any } }} done
 */
export function readbackRequest(d, name, done) {
  const rb = d.ops[name] && d.ops[name].readback;
  if (!rb) return null;
  const params = Object.fromEntries(Object.entries(rb.args).map(([k, ref]) => [k, refValue(ref, done)]));
  return { op: rb.op, request: buildRequest(d, rb.op, { params }) };
}

/**
 * Whether what the service now says matches what was written: each `compare` path of the read-back answer must equal the value the write sent. A mismatch names the field.
 * @param {Declaration} d @param {string} name @param {{ request: any, response: any }} done @param {{ json?: any }} read
 * @returns {{ ok: boolean, mismatches: { field: string, wrote: any, read: any }[] }}
 */
export function compareReadback(d, name, done, read) {
  const rb = d.ops[name] && d.ops[name].readback;
  /** @type {{ field: string, wrote: any, read: any }[]} */ const mismatches = [];
  if (!rb) return { ok: true, mismatches };
  for (const [field, ref] of Object.entries(rb.compare || {})) {
    // a value the write did not send is not checked: the service may fill it in
    if (refValue(ref, { request: done.request, response: done.response }) === undefined) continue;
    let cur = read && read.json;
    for (const k of field.split(".")) { if (cur === null || typeof cur !== "object" || k === "__proto__" || k === "constructor") { cur = undefined; break; } cur = cur[k]; }
    const wrote = refValue(ref, { request: done.request, response: done.response });
    if (JSON.stringify(cur) !== JSON.stringify(wrote)) mismatches.push({ field, wrote, read: cur });
  }
  return { ok: mismatches.length === 0, mismatches };
}
