// GENERATED from lib/site-knowledge.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// site-knowledge: what Vyre for Chrome learns about a website, as a record that holds structure and
// never a value (team/0.2/chrome-learning-plan.md). PURE: no fs, no vyred, no chrome.* API, so the
// extension, standalone Vyre for Chrome and core/memory use the same code and a record means the
// same thing in each.
//
// Two rules hold everything else:
//   1. Allowlist. Only the fields below survive, with types and length limits; anything else is
//      dropped. A string that looks like a credential, a pairing code or a key (lib/credential-shapes.js,
//      the recall redaction and the Vault's named shapes) or carries an email makes the WHOLE patch
//      refused (fail closed); the refusal names the field and never the text.
//   0. Who builds a patch: only the extension's own observation code and the shipped-file loader. `nameVisits`
//      and the other evidence fields are claims this code cannot prove, so a patch must never be built from a
//      model-supplied tool argument.
//   2. A control's label is stored only when it is stable and cannot be a person's data: seen in two
//      separate visits, not inside a row, cell or list of records, not repeated among siblings, and
//      without an email, phone or long number in it. Otherwise the control is found by identifier or
//      by structure (role, container, nth). Chrome supplies the evidence; this code decides.

import { redact } from "./credential-shapes.js";
import { parseOperation } from "./siteops/spec.js";

export const SITE_V = 1;

export const LIMITS = Object.freeze({
  str: 120, text: 600, names: 4, related: 8, signals: 8, authHosts: 8, frames: 16, controls: 200, api: 300,
  flows: 40, notes: 20, steps: 60, params: 12, expects: 8, tombstones: 200, recordBytes: 1024 * 1024, cardBytes: 8 * 1024,
  ops: 40, opBytes: 12 * 1024, opPrev: 2, opStr: 4000,
  shapeDepth: 6, shapeKeys: 60, perPageCard: 10, rungs: 40,
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
/** The length of a visit: a second miss of the same item inside it does not count. */
const MISS_GAP = 30 * 60_000;

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

/**
 * The words a web app's own routes are made of. A path segment is kept only when it is one of these (or a
 * hyphen or underscore join of them, or a version like v2); every other segment is a slug or a name and
 * becomes {id}, because "jane-doe" in /clients/jane-doe/notes is a person. Chrome applies canonTemplate
 * before it looks a page up, so both sides see the same template.
 */
export const ROUTE_WORDS = new Set(`about account accounts action actions activity add admin agency agencies alerts all analytics api app apps appointments approvals
archive article articles assets attachments audit audiences auth automation automations availability backups billing blocks blog board boards booking bookings
branding builder builders calendar calendars call calls campaign campaigns cart carts categories category channel channels chat chats checkout clients code
collections comments communication companies company compliance config configuration connect connections contact contacts content conversation conversations
courses create credits crm custom dashboard dashboards data database default delete deliverability design details developer directory discover display
documents domains draft drafts edit editor email emails embed engagement entries events exports facebook feed fields files filters finance flow flows folders
form forms forum funnel funnels general generate goals google group groups help history home hooks hub images import imports inbox index info insights
integrations internal invoice invoices items jobs journey journeys knowledge labels landing launch leads learn library links list lists live location locations
log login logout logs mail manage management map marketing media members memberships menu message messages metrics mobile modules monitor my new news
notes notifications number numbers oauth objects offers onboarding opportunities opportunity options orders organizations overview page pages partners
password payments people permissions phone phones pipeline pipelines plans platform plugins policies portal posts preferences preview pricing privacy
products profile profiles projects proposals public publish queue quotes rankings reactivation recent records referrals registration reminders reports
reputation requests resources reviews roles rules sales save saved schedule scheduler search sections security segments send sent sequences services
settings setup share sign signin signup sites sms smart snapshots social source sources stats status store stores subscriptions support surveys tags tasks
team teams templates terms text theme tickets tiers time timeline tools tracking transactions triggers trial unsubscribe update updates upload users
variables versions videos view views voice webhook webhooks website websites welcome widgets workflow workflows workspace workspaces`.split(/\s+/));

/** One path segment's canonical form: a placeholder, a route word (or a join of them), a version, or {id}. @param {string} seg */
function canonSegment(seg) {
  if (/^\{[a-z0-9]{1,8}\}$/i.test(seg)) return seg;
  const low = seg.toLowerCase();
  if (/^v\d{1,2}$/.test(low)) return low;
  return low.split(/[-_]/).every(w => w && ROUTE_WORDS.has(w)) ? low : "{id}";
}

/**
 * A path template in canonical form: slashes, route words and {id} placeholders, nothing else. Every
 * segment that is not a known route word (a slug, a name, an id, an email) becomes {id}. Returns null
 * when it is not a path at all (no leading slash, a query or fragment, spaces, too long).
 * @param {string} p
 */
export function canonTemplate(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > LIMITS.str * 2 || /[?#\s]/.test(p)) return null;
  let n = 0;
  const segs = p.split("/").map(seg => {
    if (!seg) return seg;
    const c = canonSegment(seg);
    if (c !== "{id}" && !/^\{[a-z0-9]{1,8}\}$/i.test(c)) return c;
    return n++ === 0 ? "{id}" : `{id${n}}`;
  });
  return segs.join("/") || "/";
}

/** Whether a path is already canonical. @param {string} p */
export const templateOk = p => canonTemplate(p) === p;

/** @param {string} s */
const piiShape = s => EMAIL.test(s) || PHONE.test(s) || LONG_NUMBER.test(s);
/** An identifier with a record id inside it (contact-row-3f2b8c1e) is not stable and is itself data. @param {string} s */
const identifierHasId = s => s.split(/[-_:.]/).some(t => /^[0-9a-f]{8,}$/i.test(t) || /^\d{5,}$/.test(t) || looksLikeId(t));

// ---------------------------------------------------------------------------------------------
// The allowlist: each cleaner returns the cleaned value or null (dropped), and files problems.

/**
 * @typedef {{ refused: Problem[], dropped: Problem[], now: number, trusted: boolean, notes: boolean, ids: Set<string>, replica: boolean, key?: string }} Ctx
 */

/** A word that is an opaque token: long and mixing letters and digits (or hex). Never text a person would write. @param {string} w */
const opaque = w => w.length >= 20 && ((/[A-Za-z]/.test(w) && /\d/.test(w)) || /^[0-9a-f]{20,}$/i.test(w) || looksLikeId(w));

/**
 * One string. Too long is dropped; a secret shape, an email or an opaque token refuses the whole patch. A field that
 * legitimately holds an id passes `ids: true` (the shape check for ids is its own).
 * @param {any} v @param {number} max @param {string} path @param {Ctx} c @param {boolean} [ids] @returns {string|null}
 */
function str(v, max, path, c, ids = false) {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > max) { c.dropped.push({ path, why: "too long" }); return null; }
  if (redact(t) !== t) { c.refused.push({ path, why: "secret shape" }); return null; }
  if (EMAIL.test(t)) { c.refused.push({ path, why: "email" }); return null; }
  if (!ids && t.split(/[\s,;:=/()[\]{}"'<>|]+/).some(opaque)) { c.refused.push({ path, why: "opaque token" }); return null; }
  return t;
}
/** A key of an object: its text is never put in a path. @param {string} k @param {string} path @param {number} max @param {Ctx} c */
const keyOf = (k, path, max, c) => (UNSAFE_KEYS.has(k) ? null : str(k, max, `${path}.<key>`, c));
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** A path template from a patch: an email or a secret refuses the patch, then every unknown segment becomes {id}. @param {any} v @param {string} path @param {Ctx} c */
function pathClean(v, path, c) {
  if (typeof v !== "string") return null;
  const t = str(v, LIMITS.str * 2, path, c, true);
  if (t == null) return null;
  if (t.includes("@")) { c.refused.push({ path, why: "an @ in a path" }); return null; }
  const canon = canonTemplate(t);
  if (canon == null) c.dropped.push({ path, why: "not a path template" });
  return canon;
}
/** An id is a generated shape (c12, e_44, e_a1b2c3d, shell, builder2), never a word: a word there would be a name in a step. */
const ID_SHAPE = /^(?:[a-z]{1,4}[_-]?\d{1,8}|[a-z]{1,4}_(?=[a-z0-9]*\d)[a-z0-9]{6,10}|(?:shell|app|builder|auth|ad|other)\d{0,3})$/;
const token = (/** @type {any} */ v, path, c) => { const t = str(v, 64, path, c, true); return t && ID_SHAPE.test(t) ? t : (t && c.dropped.push({ path, why: "not a generated id" }), null); };
const word = (/** @type {any} */ v, path, c, max = 30) => { const t = str(v, max, path, c); return t && /^[a-z][a-z0-9+_-]*$/i.test(t) ? t.toLowerCase() : null; };
const oneOf = (/** @type {any} */ v, /** @type {readonly string[]} */ set, dflt) => (typeof v === "string" && set.includes(v) ? v : dflt);
const iso = (/** @type {any} */ v) => (typeof v === "string" && ISO.test(v) ? v : null);

/** @param {any} f @param {string} path @param {Ctx} c */
function fact(f, path, c) {
  // "shipped" is the shipped-file loader's word: a patch that claims it becomes learned unless the caller is trusted.
  const src = c.trusted ? oneOf(f && f.src, SRCS, "learned") : oneOf(f && f.src, ["learned", "taught"], "learned");
  const at = iso(f && f.verified);
  return {
    conf: Math.round(num(f && f.conf, 0, 1, 0.5) * 1000) / 1000,
    // A date in the future is a claim of trust we cannot give: never later than now.
    verified: at ? (Date.parse(at) > c.now ? new Date(c.now).toISOString() : at) : null, seen: int(f && f.seen, 0, 1e9, 1), misses: int(f && f.misses, 0, 1e6, 0), src,
    // The miss bookkeeping is the store's own. Only a replica's record (the person's own other device, through sync) carries it.
    ...(c.replica && iso(f && f.missAt) ? { missAt: iso(f && f.missAt) } : {}), ...(c.replica && iso(f && f.lastMissAt) ? { lastMissAt: iso(f && f.lastMissAt) } : {}), ...(c.replica && iso(f && f.qAt) ? { qAt: iso(f && f.qAt) } : {}),
    ...(f && f.outcome === "ok" || f && f.outcome === "miss" ? { outcome: f.outcome } : {}),
  };
}

/** @param {any} f @param {string} path @param {Ctx} c */
function frameRef(f, path, c) { return f == null ? undefined : token(f, path, c) || undefined; }

/** What a landmark may name: an ARIA landmark or widget role, never page text. */
/** A hyphen or underscore join of route, widget and landmark words (save-toast, workflow-builder): a name slug is not one. @param {string} a */
function vocabJoin(a) { const parts = a.toLowerCase().split(/[-_]/); return parts.length > 1 && parts.every(w => ROUTE_WORDS.has(w) || UI_WORDS.has(w) || LANDMARK_ROLES.has(w)); }
/** Widget words a selector signal may name besides a hyphenated identifier: what a page shows, never a name. */
const UI_WORDS = new Set(["toast", "modal", "dialog", "spinner", "loader", "alert", "banner", "snackbar", "drawer", "popover", "tooltip", "overlay", "menu", "nav", "sidebar", "header", "footer", "toolbar", "tab", "tabs", "table", "list", "form"]);
const LANDMARK_ROLES = new Set(["banner", "navigation", "nav", "main", "complementary", "contentinfo", "search", "form", "region", "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist", "tabpanel", "tree", "grid", "table", "list", "status", "alert", "footer", "header", "sidebar", "aside", "section", "article"]);

/**
 * A signal keeps a kind and, at most, a role, an identifier, a duration or a path template: never text from the page
 * and never a css string. landmark: an ARIA role or an identifier. selector: an identifier only. dom-quiet and net-idle:
 * a duration in ms. url and auth-path: a canonical path. auth-host: a host. password-field and otp-field: nothing.
 * @param {any} s @param {string} path @param {Ctx} c
 */
function signal(s, path, c) {
  const o = obj(s); if (!o) return null;
  const kind = oneOf(o.kind, SIGNAL_KINDS, null); if (!kind) { c.dropped.push({ path: path + ".kind", why: "unknown kind" }); return null; }
  let arg;
  if (o.arg != null && kind !== "password-field" && kind !== "otp-field") {
    if (kind === "url" || kind === "auth-path") arg = pathClean(o.arg, path + ".arg", c) || undefined;
    else if (kind === "auth-host") { const a = str(o.arg, LIMITS.str, path + ".arg", c, true); if (a && HOST.test(a.toLowerCase())) arg = a.toLowerCase(); else if (a) c.dropped.push({ path: path + ".arg", why: "not a host" }); }
    else if (kind === "dom-quiet" || kind === "net-idle") { const n = Number(o.arg); if (Number.isInteger(n) && n >= 0 && n <= 600000) arg = String(n); }
    else {
      const a = str(o.arg, 60, path + ".arg", c);
      if (a && /^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(a) && !identifierHasId(a) && (UI_WORDS.has(a.toLowerCase()) || LANDMARK_ROLES.has(a.toLowerCase()) || vocabJoin(a))) arg = a;
      else if (a) c.dropped.push({ path: path + ".arg", why: "not a role or an identifier" });
    }
    if (c.refused.length) return null;
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
  const pathTemplate = m.pathTemplate != null ? pathClean(m.pathTemplate, path + ".match.pathTemplate", c) : null;
  const name = m.name != null ? str(m.name, LIMITS.str, path + ".match.name", c) : null;
  return { ...fact(o, path, c), id, match: { ...(originPart && HOST.test(originPart.toLowerCase().replace(/^\./, "")) ? { originPart: originPart.toLowerCase() } : {}), ...(pathTemplate ? { pathTemplate } : {}),
    ...(name && /^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name) && !identifierHasId(name) ? { name } : {}), ...(Number.isInteger(m.ordinal) ? { ordinal: int(m.ordinal, 0, 99, 0) } : {}) },
    role: oneOf(o.role, FRAME_ROLES, "other"), ...(o.parent != null && token(o.parent, path + ".parent", c) ? { parent: token(o.parent, path + ".parent", c) } : {}), readable: o.readable !== false };
}

/** A selector: never a css string or a DOM path. @param {any} s @param {string} path @param {Ctx} c */
function selector(s, path, c) {
  const o = obj(s); if (!o) return null;
  const strategy = oneOf(o.strategy, STRATEGIES, null); if (!strategy) { c.dropped.push({ path: path + ".strategy", why: "unknown strategy" }); return null; }
  const out = /** @type {Record<string, any>} */ ({ strategy });
  if (o.identifier != null) {
    const id = str(o.identifier, LIMITS.str, path + ".identifier", c, true);
    // An identifier (a data-testid, an id attribute) can be a person's name in a row (row-jane-doe): like a label, it is kept only
    // when two separate visits saw it (`identifierVisits`).
    const seen = Array.isArray(o.identifierVisits) ? new Set(o.identifierVisits.map(String).filter(Boolean)) : new Set();
    if (id && identifierHasId(id)) c.dropped.push({ path: path + ".identifier", why: "carries a record id" });
    else if (id && seen.size < 2) c.dropped.push({ path: path + ".identifier", why: "identifier not seen in two visits" });
    else if (id) out.identifier = id;
  }
  if (o.role != null) { const r = word(o.role, path + ".role", c); if (r) out.role = r; }
  if (o.container != null) { const r = word(o.container, path + ".container", c); if (r) out.container = r; }
  if (o.nth != null) out.nth = int(o.nth, 0, 999, 0);
  if (o.name != null) { const n = labelOk(o.name, o, path + ".name", c); if (n) out.name = n; }
  const f = frameRef(o.frame, path + ".frame", c); if (f) out.frame = f;
  if (strategy === "identifier" && !out.identifier) return null;
  if (strategy === "structure" && !out.role) return null;
  return out;
}

/**
 * A label is kept only when it cannot be a person's data. The evidence comes with the observation and MUST all be
 * present (a missing field is a dropped label, never a kept one): `nameVisits` (ids of two separate visits that saw the
 * same text), `siblings` (a number: how many controls of the same role share this container, 1 when it is alone),
 * `container` (a string: its container's role, "none" when it has none).
 * @param {any} v @param {Record<string, any>} ev @param {string} path @param {Ctx} c @returns {string|null}
 */
function labelOk(v, ev, path, c) {
  const t = str(v, 80, path, c);
  if (!t) return null;
  const role = typeof ev.role === "string" ? ev.role.toLowerCase() : "";
  const haveEvidence = typeof ev.container === "string" && ev.container !== "" && typeof ev.siblings === "number" && Number.isFinite(ev.siblings) && role !== "" && Array.isArray(ev.nameVisits);
  const container = haveEvidence ? ev.container.toLowerCase() : "";
  const visits = haveEvidence ? new Set(ev.nameVisits.map(String).filter(Boolean)) : new Set();
  let why = "";
  if (!haveEvidence) why = "no evidence sent";
  else if (piiShape(t)) why = "looks like a person's data";
  else if (DATA_ROLES.has(role)) why = "role holds data";
  else if (DATA_CONTAINERS.has(container)) why = "inside a record list";
  else if (ev.siblings > 1) why = "repeated among siblings";
  else if (visits.size < 2) why = "not seen in two visits";
  if (why) { c.dropped.push({ path, why: `label dropped: ${why}` }); return null; }
  return t;
}

/** @param {any} x @param {string} path @param {Ctx} c */
function control(x, path, c) {
  const o = obj(x); if (!o) return null;
  const id = token(o.id, path + ".id", c); if (!id) return null;
  const page = pathClean(o.page, path + ".page", c);
  if (!page) { c.dropped.push({ path: path + ".page", why: "not a path template" }); return null; }
  const role = word(o.role, path + ".role", c); if (!role) return null;
  const so = obj(o.selector) || {};
  // A selector that names a role (role+name, structure) takes the control's role when it gives none; identifierVisits is evidence.
  const needsRole = so.strategy === "structure" || so.strategy === "role+name";
  const ev = { role, container: so.container ?? o.container, nameVisits: o.nameVisits, siblings: o.siblings };
  const sel = selector({ ...so, ...(needsRole ? { role: so.role ?? role } : {}), container: so.container ?? (so.strategy === "structure" ? o.container : undefined), nameVisits: o.nameVisits, siblings: o.siblings, identifierVisits: so.identifierVisits ?? o.identifierVisits }, path + ".selector", c);
  if (!sel) { c.dropped.push({ path: path + ".selector", why: "no usable selector" }); return null; }
  const prev = o.prev != null ? selector(o.prev, path + ".prev", c) : null;
  const name = o.name != null ? labelOk(o.name, ev, path + ".name", c) : null;
  return { ...fact(o, path, c), id, page, role, ...(name ? { name } : {}), selector: sel, ...(prev ? { prev } : {}) };
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
  const out = Object.create(null);
  for (const [k, x] of Object.entries(o).slice(0, LIMITS.shapeKeys)) {
    if (k !== "{key}" && looksLikeId(k)) continue;
    const key = k === "{key}" ? k : keyOf(k, path, 60, c);
    if (!key) continue;
    out[key] = shape(x, d + 1, `${path}.<key>`, c);
  }
  return { ...out };
}

/** @param {any} x @param {string} path @param {Ctx} c */
function apiEntry(x, path, c) {
  const o = obj(x); if (!o) return null;
  const id = token(o.id, path + ".id", c); if (!id) return null;
  const method = String(o.method || "GET").toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) return null;
  const origin = String(o.origin || "");
  if (!ORIGIN.test(origin)) { c.dropped.push({ path: path + ".origin", why: "not an origin" }); return null; }
  const pathTemplate = pathClean(o.pathTemplate, path + ".pathTemplate", c);
  if (!pathTemplate) { c.dropped.push({ path: path + ".pathTemplate", why: "not a path template" }); return null; }
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, t] of Object.entries(obj(o.query) || {}).slice(0, LIMITS.shapeKeys)) {
    if (looksLikeId(k)) continue;
    const key = keyOf(k, path + ".query", 60, c);
    if (key && typeof t === "string" && SHAPE_TYPES.has(t.split("|")[0])) query[key] = t;
  }
  const authKind = typeof o.authKind === "string" && /^(none|cookie|bearer|header:[a-z0-9-]{1,40}|header:authorization)$/i.test(o.authKind) ? o.authKind : "none";
  return { ...fact(o, path, c), id, method, origin, pathTemplate, query, ...(o.bodyShape !== undefined ? { bodyShape: shape(o.bodyShape, 0, path + ".bodyShape", c) } : {}),
    authKind, statuses: (Array.isArray(o.statuses) ? o.statuses : []).filter(n => Number.isInteger(n) && n >= 100 && n < 600).slice(0, 12), count: int(o.count, 0, 1e9, 1) };
}

/** The classes a call's answer can have (lib/siteops/classify.js); the last one is kept on the entry so a Connection can show its health. */
const OP_CLASSES = ["ok", "drift", "auth", "rate", "blocked", "input", "error"];

/**
 * One learned website operation (lib/siteops): a named, typed call the site's own page makes, as a TEMPLATE. It holds structure and constants, never a login and never a value a person
 * typed: a secret shape or an email anywhere in it refuses the whole patch; a header value that looks like a credential is refused unless the operation lists the header as public.
 * The version history is the store's own (foldItem), so a patch cannot set it; only a replica's record carries it.
 * @param {any} x @param {string} path @param {Ctx} c
 */
function opEntry(x, path, c) {
  const o = obj(x); if (!o) return null;
  const parsed = parseOperation({ ...(obj(o.op) || {}), name: o.name ?? (obj(o.op) || {}).name });
  if (!parsed.ok) { c.dropped.push({ path, why: `not a valid operation: ${parsed.problems[0]}` }); return null; }
  const op = parsed.op;
  const clean = (/** @type {any} */ opx, /** @type {string} */ p) => {
    let ok = true;
    /** @param {any} v @param {string} at @param {boolean} [header] */
    const walk = (v, at, header = false) => {
      if (!ok) return;
      if (typeof v === "string") {
        if (v.length > LIMITS.opStr) { c.dropped.push({ path: at, why: "too long" }); ok = false; return; }
        if (redact(v) !== v) { c.refused.push({ path: at, why: "secret shape" }); ok = false; return; }
        if (EMAIL.test(v)) { c.refused.push({ path: at, why: "email" }); ok = false; return; }
        if (header && v.split(/[\s,;:=]+/).some(opaque) && !(opx.public || []).includes(at.split(".").pop())) { c.refused.push({ path: at, why: "a header value that looks like a credential" }); ok = false; }
      } else if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${at}[${i}]`, header));
      else if (v && typeof v === "object") for (const [k, e] of Object.entries(v)) { if (UNSAFE_KEYS.has(k)) { ok = false; return; } walk(e, `${at}.${k}`, header || at.endsWith(".headers")); }
    };
    walk(opx, p);
    if (!ok) return null;
    // an example value must not be a person's data
    for (const prm of opx.params) if (prm.example !== undefined && piiShape(String(typeof prm.example === "object" ? JSON.stringify(prm.example) : prm.example))) delete prm.example;
    let origin = ""; try { origin = new URL(opx.request.url).origin; } catch { /* checked below */ }
    if (c.key && !FAMILY_KEY.test(c.key) && origin !== c.key) { c.dropped.push({ path: p, why: "the operation's host is not this site" }); return null; }
    if (JSON.stringify(opx).length > LIMITS.opBytes) { c.dropped.push({ path: p, why: "too large" }); return null; }
    return opx;
  };
  const cur = clean(op, path + ".op"); if (!cur) return null;
  /** @type {any[]} */ const prev = [];
  if (c.replica) for (const pv of (Array.isArray(o.prev) ? o.prev : []).slice(0, LIMITS.opPrev)) {
    const pp = obj(pv); const po = pp && parseOperation({ ...(obj(pp.op) || {}), name: op.name });
    const cleaned = po && po.ok ? clean(po.op, path + ".prev") : null;
    if (cleaned && Number.isInteger(pp && pp.version) && iso(pp && pp.at)) prev.push({ version: pp.version, at: pp.at, op: cleaned });
  }
  if (c.refused.length) return null;
  return { ...fact(o, path, c), name: op.name, kind: op.kind, version: c.replica && Number.isInteger(o.version) && o.version > 0 ? o.version : 1, op: cur, ...(prev.length ? { prev } : {}),
    ...(OP_CLASSES.includes(o.lastClass) ? { lastClass: o.lastClass, lastAt: iso(o.lastAt) || new Date(c.now).toISOString() } : {}) };
}

/** What a step argument may be besides a placeholder or a small integer: a reference to a stored item, by its exact id (an id in this patch or in the record) or a digits-only ref like c12. */
const REF_DIGITS = /^(?:c|f|s|e|ctl|ctrl|frame|step|entry)[_-]?\d{1,6}$/;
/** Keys whose number is a duration or a position, never a value. */
const STRUCT_KEYS = new Set(["nth", "index", "timeoutms", "waitms", "delayms", "durationms", "retries", "limit", "count", "depth"]);
/** The one syntax of a placeholder: `{name}`, lower case. */
const PLACEHOLDER = /^\{[a-z_][a-z0-9_]{0,30}\}$/;
/** Key names and UI words a step may carry as a literal; a flow's own declared choices are added. */
const STEP_VOCAB = new Set(["enter", "tab", "escape", "space", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown",
  "click", "dblclick", "hover", "focus", "blur", "press", "type", "select", "check", "uncheck", "toggle", "submit", "true", "false", "ui", "api", "nav", "url", "already", "draft",
  "published", "left", "right", "middle", "visible", "hidden", "enabled", "disabled", "stable", "settled", "gone", "load", "idle", "auto"]);

/**
 * A step argument. A stored step holds structure only: a {placeholder}, a reference to a stored control, frame, step or
 * API entry, a word from a small vocabulary (keys, verbs, states) or one the flow itself declared as a choice, and small
 * integers. Any other literal (a typed name, a street, a message, a large number) refuses the whole patch: what a person
 * typed must reach a flow as a parameter, never as stored text.
 * @param {any} v @param {number} d @param {string} path @param {Ctx} c @param {Set<string>} vocab @returns {any}
 */
function jsonSafe(v, d, path, c, vocab, key = "") {
  if (v == null || typeof v === "boolean") return v ?? null;
  if (typeof v === "number") {
    // A number a person could have typed (a ZIP, a street number, an amount) is data; only small counts, or a number under a structural key, are kept.
    if (Number.isInteger(v) && (Math.abs(v) < 1000 || (STRUCT_KEYS.has(key) && Math.abs(v) < 600000))) return v;
    c.refused.push({ path, why: "a literal number in a step" }); return null;
  }
  if (typeof v === "string") {
    const t = str(v, LIMITS.str, path, c);
    if (t == null) return null;
    if (PLACEHOLDER.test(t) || REF_DIGITS.test(t) || c.ids.has(t) || STEP_VOCAB.has(t.toLowerCase()) || vocab.has(t.toLowerCase())) return t;
    c.refused.push({ path, why: "a literal value in a step" });
    return null;
  }
  if (d >= 5) return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x, i) => jsonSafe(x, d + 1, `${path}[${i}]`, c, vocab, key));
  const o = obj(v); if (!o) return null;
  /** @type {Record<string, any>} */
  const out = Object.create(null);
  for (const [k, x] of Object.entries(o).slice(0, 40)) { const key = keyOf(k, path, 60, c); if (key && /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(key)) out[key] = jsonSafe(x, d + 1, `${path}.<key>`, c, vocab, key.toLowerCase()); }
  return { ...out };
}

/** @param {any} s @param {string} path @param {Ctx} c @param {Set<string>} vocab */
function step(s, path, c, vocab) {
  const o = obj(s); if (!o) return null;
  const id = token(o.id, path + ".id", c); const op = str(o.op, 40, path + ".op", c);
  if (!id || !op || !/^[a-z][a-z0-9._-]*$/i.test(op)) return null;
  const args = jsonSafe(o.args, 0, path + ".args", c, vocab);
  // A step's display label is free text and is not stored: the id says which step it is.
  const expect = obj(o.expect) ? signal(o.expect, path + ".expect", c) : null;
  return { id, op, args,
    ...(o.via === "api" || o.via === "ui" ? { via: o.via } : {}), ...(o.fallback != null && token(o.fallback, path + ".fallback", c) ? { fallback: token(o.fallback, path + ".fallback", c) } : {}),
    ...(expect ? { expect } : {}), ...(WRITE_KINDS.includes(o.write) ? { write: o.write } : {}), ...(Number.isInteger(o.fails) ? { fails: int(o.fails, 0, 1e6, 0) } : {}) };
}

/** @param {any} x @param {string} path @param {Ctx} c */
function flow(x, path, c) {
  const o = obj(x); if (!o) return null;
  const name = str(o.name, 60, path + ".name", c); if (!name || !/^[a-z][a-z0-9._-]*$/i.test(name)) return null;
  const f = fact(o, path, c);
  const src = f.src;
  const vocab = new Set();
  const params = (Array.isArray(o.params) ? o.params : []).slice(0, LIMITS.params).map((p, i) => {
    const po = obj(p); const n = po && str(po.name, 40, `${path}.params[${i}].name`, c);
    if (!po || !n) return null;
    // Choices are UI vocabulary (an option's name): short plain words, no data in them, and they are what a step may name.
    // They must come with their evidence, like a label: seen as options in two separate visits, never a typed value.
    const seen = Array.isArray(po.choicesVisits) ? new Set(po.choicesVisits.map(String).filter(Boolean)) : new Set();
    // A list that holds data (an "Assigned to" select of people) is a listbox or a combobox: only menus, radio groups and tab lists count, and few options.
    const widget = typeof po.choicesContainer === "string" && ["menu", "menubar", "radiogroup", "tablist", "toolbar"].includes(po.choicesContainer.toLowerCase());
    const choices = Array.isArray(po.choices) && seen.size >= 2 && widget && po.choices.length <= 8 ? po.choices.slice(0, 20).map((x, j) => { const t = str(x, 40, `${path}.params[${i}].choices[${j}]`, c); return t && !piiShape(t) && t.split(" ").length <= 3 && /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(t) ? t : null; }).filter(Boolean) : undefined;
    if (choices) for (const ch of choices) vocab.add(ch.toLowerCase());
    return { name: n, type: oneOf(po.type, PARAM_TYPES, "string"), ...(choices ? { choices } : {}) };
  }).filter(Boolean);
  const steps = src === "shipped" ? undefined : (Array.isArray(o.steps) ? o.steps : []).slice(0, LIMITS.steps).map((s, i) => step(s, `${path}.steps[${i}]`, c, vocab)).filter(Boolean);
  const expects = (Array.isArray(o.expects) ? o.expects : []).slice(0, LIMITS.expects).map((s, i) => signal(s, `${path}.expects[${i}]`, c)).filter(Boolean);
  // Nothing proved a flow without `expects` worked: its trust is capped.
  if (!expects.length && f.conf > 0.5) f.conf = 0.5;
  return { ...f, src, name, title: str(o.title, LIMITS.str, path + ".title", c) || name, params, ...(steps ? { steps } : {}), expects, runs: int(o.runs, 0, 1e9, 0), fails: int(o.fails, 0, 1e9, 0),
    p50ms: int(o.p50ms, 0, 3_600_000, 0), ...(o.failedStep != null && token(o.failedStep, path + ".failedStep", c) ? { failedStep: token(o.failedStep, path + ".failedStep", c) } : {}) };
}

/** Notes are the person's own words, kept only from a trusted caller; they go through the same checks as every string. @param {any} x @param {string} path @param {Ctx} c */
function note(x, path, c) {
  const o = obj(x); if (!o) return null;
  if (!c.notes) { c.dropped.push({ path, why: "notes come from the person, not from Chrome" }); return null; }
  const name = str(o.name, 60, path + ".name", c); const text = str(o.text, LIMITS.text, path + ".text", c);
  if (!name || !text) return null;
  if (piiShape(text)) { c.refused.push({ path: path + ".text", why: "looks like a person's data" }); return null; }
  const about = o.about != null ? pathClean(o.about, path + ".about", c) : null;
  return { ...fact({ ...o, src: "taught" }, path, c), src: "taught", name, text, ...(about ? { about } : {}) };
}

const list = (/** @type {any} */ v, max, fn, path, /** @type {Ctx} */ c) => (Array.isArray(v) ? v : []).slice(0, max).map((x, i) => fn(x, `${path}[${i}]`, c)).filter(Boolean);

// ---------------------------------------------------------------------------------------------
// Public: sanitize, empty, merge

/** @param {string} key an origin or "family:<id>" */
export function emptyRecord(key) {
  return { v: SITE_V, key, rev: 0, updated: null, names: [], family: null, related: [], ready: [], login: { wall: [], signedIn: [], authHosts: [] },
    frames: [], controls: [], api: [], flows: [], ops: [], notes: [], tombstones: [], rungs: {} };
}

/** @param {string} key */
export const keyOk = key => typeof key === "string" && (ORIGIN.test(key) || FAMILY_KEY.test(key));
export const isFamilyKey = (/** @type {string} */ k) => FAMILY_KEY.test(k);

/**
 * Clean a record or a patch through the allowlist. `ok: false` means something secret-shaped was in
 * it and nothing is kept (fail closed); `refused` names the fields, never their text. `dropped` lists
 * what the allowlist removed without refusing the rest.
 * @param {any} input
 * @param {{ now?: number, trusted?: boolean, notes?: boolean, known?: Iterable<string>, replica?: boolean }} [opts] replica: the person's own other device, through sync, whose miss state is kept (a patch from Chrome never carries it); known: ids of the items the record already holds (a step may name them); trusted: the shipped-file loader only (src "shipped" is honoured); notes: the person's own surfaces only
 * @returns {{ ok: boolean, record: any, refused: Problem[], dropped: Problem[] }}
 */
export function sanitize(input, { now = Date.now(), trusted = false, notes = false, known = [], replica = false } = {}) {
  /** @type {Ctx} */
  const c = { refused: [], dropped: [], now, trusted, notes, ids: new Set(known), replica, key: undefined };
  const o = obj(input);
  if (!o) return { ok: false, record: null, refused: [{ path: "", why: "not an object" }], dropped: [] };
  // The ids this patch itself defines: a step may refer to them by their exact id and to nothing else.
  for (const part of ["controls", "frames", "api"]) for (const x of Array.isArray(o[part]) ? o[part] : []) if (x && typeof x.id === "string") c.ids.add(x.id);
  for (const f of Array.isArray(o.flows) ? o.flows : []) for (const st of Array.isArray(f && f.steps) ? f.steps : []) if (st && typeof st.id === "string") c.ids.add(st.id);
  const key = typeof o.key === "string" ? o.key : typeof o.origin === "string" ? o.origin : "";
  if (!keyOk(key)) return { ok: false, record: null, refused: [{ path: "key", why: "not an origin or a family key" }], dropped: [] };
  c.key = key;
  const names = (Array.isArray(o.names) ? o.names : []).slice(0, LIMITS.names).map((n, i) => str(n, 40, `names[${i}]`, c)).filter(Boolean);
  const family = o.family != null && /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(o.family)) ? String(o.family) : null;
  const related = (Array.isArray(o.related) ? o.related : []).filter(x => typeof x === "string" && ORIGIN.test(x)).slice(0, LIMITS.related);
  const login = obj(o.login) || {};
  const tombstones = (Array.isArray(o.tombstones) ? o.tombstones : []).slice(0, LIMITS.tombstones).map(t => { const to = obj(t); return to && ["controls", "api", "flows", "notes", "frames", "ready", "wall", "signedIn", "ops"].includes(to.part) && iso(to.at) && typeof to.id === "string" && /^[A-Za-z0-9_:.|~-]{1,200}$/.test(to.id) && !opaque(to.id) ? { part: to.part, id: to.id, at: Date.parse(to.at) > now ? new Date(now).toISOString() : to.at } : null; }).filter(Boolean);
  const record = { v: SITE_V, key, rev: int(o.rev, 0, 1e12, 0), updated: iso(o.updated), names, family, related,
    ready: list(o.ready, LIMITS.signals, signal, "ready", c), login: { wall: list(login.wall, LIMITS.signals, signal, "login.wall", c), signedIn: list(login.signedIn, LIMITS.signals, signal, "login.signedIn", c),
      authHosts: (Array.isArray(login.authHosts) ? login.authHosts : []).map(h => String(h).toLowerCase()).filter(h => HOST.test(h)).slice(0, LIMITS.authHosts) },
    frames: list(o.frames, LIMITS.frames, frame, "frames", c), controls: list(o.controls, LIMITS.controls, control, "controls", c), api: list(o.api, LIMITS.api, apiEntry, "api", c),
    flows: list(o.flows, LIMITS.flows, flow, "flows", c), ops: list(o.ops, LIMITS.ops, opEntry, "ops", c), notes: list(o.notes, LIMITS.notes, note, "notes", c), tombstones,
    // Rungs are the store's own count of which way of acting worked on a page (applyRung); a patch from Chrome never carries them.
    rungs: c.replica ? cleanRungs(o.rungs, c.now) : {},
    ...(Array.isArray(o.remove) ? { remove: o.remove.slice(0, 100).map(r => { const ro = obj(r); return ro && typeof ro.part === "string" && typeof ro.id === "string" && ro.id.length <= 200 ? { part: ro.part, id: ro.id } : null; }).filter(Boolean) } : {}) };
  if (c.refused.length) return { ok: false, record: null, refused: c.refused, dropped: c.dropped };
  return { ok: true, record, refused: [], dropped: c.dropped };
}

/** The rung ladder's bounds: a rung is 1 to 5, counted at most 255 times. */
export const RUNG_MAX = 5;
/** A different rung replaces the held one at most once a minute per template. */
const RUNG_CHANGE_GAP = 60_000;

/** Rungs from a replica: canonical page templates to { r, n, d, at }, integers only, at most LIMITS.rungs. @param {any} v @param {number} now */
function cleanRungs(v, now) {
  const o = obj(v); if (!o) return {};
  /** @type {Record<string, { r: number, n: number, d: number, at: string }>} */
  const out = {};
  for (const [k, x] of Object.entries(o).slice(0, LIMITS.rungs * 2)) {
    const xo = obj(x);
    if (!xo || k === "__proto__" || canonTemplate(k) !== k) continue;
    if (!Number.isInteger(xo.r) || xo.r < 1 || xo.r > RUNG_MAX) continue;
    // A time in the future would win every merge and keep the template from ever counting again: never later than now.
    const at = iso(xo.at);
    out[k] = { r: xo.r, n: int(xo.n, 0, 255, 0), d: int(xo.d, 0, 99999, 0), at: at ? (Date.parse(at) > now ? new Date(now).toISOString() : at) : "1970-01-01T00:00:00Z" };
  }
  return capRungs(out);
}
/** At most LIMITS.rungs templates: the least counted and oldest go first. @param {Record<string, any>} r */
function capRungs(r) {
  const keys = Object.keys(r);
  if (keys.length <= LIMITS.rungs) return r;
  const keep = keys.sort((a, b) => r[b].n - r[a].n || r[b].d - r[a].d).slice(0, LIMITS.rungs);
  return Object.fromEntries(keep.map(k => [k, r[k]]));
}

/**
 * Record that a rung of the page ladder worked on a page template (a way of acting found the control: 1 the lightest, 5 the
 * heaviest). The count is the store's own: one count per template per 30-minute visit window, capped at 255, so a client cannot
 * inflate it; a different rung than the one held starts over (at 1, or at 2 when the lower rungs were seen to fail this visit).
 * The day is the store's clock. The count is a hint for where to start (a first-party module reporting lowerFailed can set it to two
 * in one call), never a grant of trust. A change of rung is also throttled, to one per template per minute, so alternating rungs cannot
 * write on every call. Pure: returns a copy.
 * @param {any} rec @param {{ template: string, rung: number, lowerFailed?: boolean }} o @param {number} [now]
 */
export function applyRung(rec, { template, rung, lowerFailed = false }, now = Date.now()) {
  const t = canonTemplate(String(template || ""));
  if (!t || !Number.isInteger(rung) || rung < 1 || rung > RUNG_MAX) return rec;
  const out = JSON.parse(JSON.stringify(rec));
  const rungs = out.rungs || (out.rungs = {});
  const at = new Date(now).toISOString();
  const cur = rungs[t];
  if (cur && cur.r !== rung && now - Date.parse(cur.at) < RUNG_CHANGE_GAP) return rec;
  if (cur && cur.r === rung) {
    if (now - Date.parse(cur.at) < MISS_GAP) return rec;
    rungs[t] = { r: rung, n: Math.min(255, cur.n + 1), d: Math.floor(now / DAY), at };
  } else {
    rungs[t] = { r: rung, n: lowerFailed ? 2 : 1, d: Math.floor(now / DAY), at };
  }
  out.rungs = capRungs(rungs);
  out.rev = (rec.rev || 0) + 1; out.updated = at;
  return out;
}

export const itemId = (/** @type {string} */ part, /** @type {any} */ it) => (part === "ready" || part === "wall" || part === "signedIn" ? signalId(it) : part === "flows" || part === "notes" || part === "ops" ? it.name : it.id);

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
    out.conf = Math.round(Math.min(1, (f.conf ?? 0.5) + 0.1) * 1000) / 1000; out.verified = at; out.misses = 0; delete out.missAt; delete out.lastMissAt; delete out.qAt;
  } else {
    // One miss per item per visit: a slow load or a hidden control that fails three times in a row is one miss, however fast the client
    // flushes, so no client can quarantine an item in seconds.
    if (f.lastMissAt && now - Date.parse(f.lastMissAt) < MISS_GAP) return out;
    out.misses = (f.misses || 0) + 1; out.conf = Math.round((f.conf ?? 0.5) * 0.6 * 1000) / 1000; out.missAt = f.missAt || at; out.lastMissAt = at;
    // Set aside only when the misses span two days (conf alone never does it: a low conf is "stale", tried last).
    if (out.misses >= 3 && now - Date.parse(out.missAt) >= 2 * DAY) out.qAt = f.qAt || at;
  }
  return out;
}

const PARTS = /** @type {const} */ (["frames", "controls", "api", "flows", "ops", "notes"]);
const SIG_PARTS = [["ready", r => r.ready, (r, v) => { r.ready = v; }], ["wall", r => r.login.wall, (r, v) => { r.login.wall = v; }], ["signedIn", r => r.login.signedIn, (r, v) => { r.login.signedIn = v; }]];
const CAP = { frames: LIMITS.frames, controls: LIMITS.controls, api: LIMITS.api, flows: LIMITS.flows, ops: LIMITS.ops, notes: LIMITS.notes, ready: LIMITS.signals, wall: LIMITS.signals, signedIn: LIMITS.signals };

/** One item of a patch into the stored list. New items start no higher than 0.5. */
/** What makes an item the thing it is: when it changes under the same id, what was learned about the old one does not carry over. */
const targetOf = (part, it) => JSON.stringify(part === "flows" ? [it.steps || null, it.params] : part === "api" ? [it.origin, it.method, it.pathTemplate] : part === "frames" ? [it.match, it.role] : part === "ops" ? [it.op && it.op.match, it.kind] : part === "controls" ? [it.page, it.role] : null);

function foldItem(part, old, inc, now) {
  // The same id with a different target is a new item: it starts at 0.5 at most, unverified.
  if (old && targetOf(part, old) !== targetOf(part, inc)) { old = null; inc = { ...inc, verified: null, misses: 0 }; }
  if (!old) {
    const f = { ...inc }; delete f.outcome;
    f.conf = Math.min(f.conf ?? 0.5, f.src === "shipped" ? 1 : 0.5);
    return inc.outcome ? heal(f, inc.outcome, now) : f;
  }
  let out = { ...old, ...inc, conf: old.conf, verified: old.verified, seen: (old.seen || 0) + (inc.seen || 1), misses: old.misses || 0 };
  // The miss bookkeeping is the store's own: a patch cannot set or clear it.
  delete out.missAt; delete out.lastMissAt; delete out.qAt;
  if (old.missAt) out.missAt = old.missAt; if (old.lastMissAt) out.lastMissAt = old.lastMissAt; if (old.qAt) out.qAt = old.qAt;
  if (part === "api") { out.count = (old.count || 0) + (inc.count || 0); out.statuses = [...new Set([...(old.statuses || []), ...(inc.statuses || [])])].sort((a, b) => a - b).slice(0, 12); out.query = { ...old.query, ...inc.query }; }
  if (part === "ops") {
    // A new version of the same operation (a verified heal) keeps the old one for a rollback; the history is the store's own, never a patch's.
    const same = JSON.stringify(old.op) === JSON.stringify(inc.op);
    out.version = old.version || 1;
    out.prev = old.prev || [];
    if (!same) { out.version = (old.version || 1) + 1; out.prev = [{ version: old.version || 1, at: new Date(now).toISOString(), op: old.op }, ...(old.prev || [])].slice(0, LIMITS.opPrev); }
    if (!out.prev.length) delete out.prev;
    if (inc.lastClass) { out.lastClass = inc.lastClass; out.lastAt = inc.lastAt; } else if (old.lastClass) { out.lastClass = old.lastClass; out.lastAt = old.lastAt; }
  }
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
    for (const part of [...PARTS, "ready"]) for (const x of (part === "ready" ? rec.ready : rec[part] || [])) { const s = score(x, now); if (!worst || s < worst.s) worst = { part, x, s }; }
    if (!worst) break;
    const list = worst.part === "ready" ? rec.ready : rec[worst.part] || []; list.splice(list.indexOf(worst.x), 1);
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
  // a is what this side holds. The replica is the person's own other device, so its miss state comes with its copy. A replica's copy (b) can refresh when an item was last verified and add counts, but it can
  // never raise the trust of an item a holds, change what it is without starting it over, or arrive above 0.5.
  const pick = (part, x, y) => {
    const vx = x.verified || "", vy = y.verified || ""; const w = vy > vx ? y : x;
    if (targetOf(part, x) !== targetOf(part, y)) return w === x ? x : { ...y, conf: Math.min(y.conf ?? 0.5, 0.5), verified: null, misses: 0 };
    return { ...w, conf: x.conf, seen: Math.max(x.seen || 0, y.seen || 0), ...(w.count !== undefined ? { count: Math.max(x.count || 0, y.count || 0) } : {}), ...(w.runs !== undefined ? { runs: Math.max(x.runs || 0, y.runs || 0) } : {}) };
  };
  const fold = (part, la, lb) => {
    const by = new Map(la.map(x => [itemId(part, x), x]));
    for (const y of lb) { const id = itemId(part, y); by.set(id, by.has(id) ? pick(part, by.get(id), y) : { ...y, conf: Math.min(y.conf ?? 0.5, 0.5) }); }
    return [...by.values()].filter(x => { const t = tomb.get(`${part}|${itemId(part, x)}`); return !t || (x.verified && x.verified >= t.at); });
  };
  for (const part of PARTS) out[part] = cap(fold(part, a[part] || [], b[part] || []), CAP[part], new Set(), now);
  for (const [part, get, set] of SIG_PARTS) set(out, cap(fold(part, get(a) || [], get(b) || []), CAP[part], new Set(), now));
  // Rungs: per template the later use wins, and the count is the larger (a replica is the person's own device).
  const rungs = { ...(a.rungs || {}) };
  for (const [k, y] of Object.entries(b.rungs || {})) { const x = rungs[k]; rungs[k] = !x ? y : (y.at > x.at ? { ...y, n: y.r === x.r ? Math.max(x.n, y.n) : y.n } : { ...x, n: x.r === y.r ? Math.max(x.n, y.n) : x.n }); }
  out.rungs = capRungs(rungs);
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
  view.rungs = { ...(family.rungs || {}), ...(origin.rungs || {}) };
  view.names = [...new Set([...(origin.names || []), ...(family.names || [])])].slice(0, LIMITS.names);
  view.family = origin.family || family.key.replace(/^family:/, "");
  return view;
}

/**
 * Roll an operation back to an earlier version it still holds: the current one becomes the newest entry of the history, so a rollback can itself be undone. Returns the new record, or null
 * when the operation or that version is not held.
 * @param {any} rec @param {string} name @param {number} version @param {number} [now]
 */
export function rollbackOp(rec, name, version, now = Date.now()) {
  const i = (rec.ops || []).findIndex((/** @type {any} */ x) => x.name === name);
  if (i < 0) return null;
  const cur = rec.ops[i];
  const at = (cur.prev || []).findIndex((/** @type {any} */ p) => p.version === version);
  if (at < 0) return null;
  const out = JSON.parse(JSON.stringify(rec));
  const target = out.ops[i].prev[at];
  const rest = out.ops[i].prev.filter((/** @type {any} */ _p, /** @type {number} */ k) => k !== at);
  out.ops[i] = { ...out.ops[i], op: target.op, version: Math.max(cur.version || 1, ...rest.map((/** @type {any} */ p) => p.version)) + 1, prev: [{ version: cur.version || 1, at: new Date(now).toISOString(), op: cur.op }, ...rest].slice(0, LIMITS.opPrev), misses: 0 };
  delete out.ops[i].qAt;
  out.rev = (rec.rev || 0) + 1; out.updated = new Date(now).toISOString();
  return out;
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
    // Where to start on each page: the rung that worked, once it has worked twice (the heavier rungs are what a fresh page falls back to).
    startRungs: Object.fromEntries(Object.entries(rec.rungs || {}).filter(([, x]) => x.n >= 2).map(([k, x]) => [k, x.r])),
    flows: rec.flows.map(f => ({ name: f.name, title: f.title, src: f.src, conf: f.conf, verified: f.verified, params: f.params })),
    api: rec.api.map(e => ({ id: e.id, method: e.method, pathTemplate: e.pathTemplate, conf: e.conf, verified: e.verified })),
    ops: (rec.ops || []).map(e => ({ name: e.name, kind: e.kind, version: e.version, conf: e.conf, verified: e.verified, ...(e.lastClass ? { lastClass: e.lastClass } : {}), inputs: e.op.params.map((/** @type {any} */ p) => p.name) })),
  });
  let n = LIMITS.perPageCard, card = build(n);
  while (JSON.stringify(card).length > LIMITS.cardBytes && n > 1) card = build(--n);
  // Still too big: thin the name index, weakest API entries first.
  while (JSON.stringify(card).length > LIMITS.cardBytes && card.api.length) card.api.pop();
  while (JSON.stringify(card).length > LIMITS.cardBytes && card.flows.length) card.flows.pop();
  while (JSON.stringify(card).length > LIMITS.cardBytes && card.ops.length) card.ops.pop();
  return card;
}
export const cardBytes = (/** @type {any} */ c) => JSON.stringify(c).length;

/**
 * A clock for tests only. Under a test flag (NODE_ENV=test or VYRE_CHROME_TEST) and with VYRE_SITE_TEST_CLOCK naming a file that holds
 * an ISO time, that time is "now", so a harness can put misses on two different days without waiting. Never a person's setting, never
 * read without a test flag, and honoured only when the store's home is under the OS temp directory, so a forged clock can never move a
 * real home's purge or undo windows. `read` returns a file's text (injected so this file stays pure).
 * @param {Record<string, string | undefined>} env @param {(path: string) => string} read
 * @param {{ home?: string | null, tmp?: string | null }} [where] the store's home and the OS temp directory, both real paths
 * @returns {number | null}
 */
export function testNow(env, read, { home = null, tmp = null } = {}) {
  if (!(env.NODE_ENV === "test" || env.VYRE_CHROME_TEST) || !env.VYRE_SITE_TEST_CLOCK) return null;
  const norm = (/** @type {string} */ p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!home || !tmp || !(norm(home) + "/").startsWith(norm(tmp) + "/")) return null;
  try { const t = Date.parse(String(read(env.VYRE_SITE_TEST_CLOCK)).trim()); return Number.isFinite(t) ? t : null; } catch { return null; }
}
