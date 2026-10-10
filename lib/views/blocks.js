// @ts-check
// blocks: the design language's one registry (0.3.1, team/0.3.1/DESIGN-design-language-build.md).
//
// A SCREEN is plain data: a layout of block keys and a map of blocks. A BLOCK is one of a closed set of types; each type declares its props, the data it may read, the content it is drawn
// from and how it shrinks for a phone (compact) and for a chat card or Lumen (glance). Nothing here draws. The app, Lumen and the chat card each draw the same resolved screen, and the
// MCPs, the module-sdk check, the gallery and the picture tests all read this file, so there is one place a block exists.
//
//   v1 frames (list, board, summary, detail, form, ...) are one-block screens: wrapFrame.
//   validateScreen   structural + rules check of a declared or resolved screen, naming the path and the fix
//   reduceScreen     the screen as one surface draws it: overrides first, then each block's own compact/glance form, then the layout
//   contentFrom      a tool's answer read into a block's content by dotted paths (no expressions)
//   catalogue        the few-token description agents read

import { getPath, clip, LIMITS } from "./frames.js";
import { iconProblem, checkAction, checkForm, checkTool } from "../../packages/module-sdk/capsule-view.js";

export const SCREEN_LIMITS = { blocks: 24, depth: 4, nodes: 60, panes: 3, glance: 3, bytes: 256 * 1024 };
export const SURFACES = ["app", "phone", "chat", "lumen"];
/** The form each surface draws: the app draws everything, a phone the compact form, chat and Lumen the glance form. */
export const FORM_OF = { app: "full", phone: "compact", chat: "glance", lumen: "glance" };
export const GAPS = ["s1", "s2", "s3", "s4", "s5", "s6"];
export const TONES = ["plain", "ok", "warn", "err", "accent"];
export const LAYOUT_KINDS = ["col", "row", "grid", "split", "tabs", "stack"];
export const DATA_KINDS = ["tool", "operation", "records", "flow", "static"];

/** Prop types. A block's props are closed: a key not listed is refused, and none of them carries a colour, a pixel size, markup or a style. */
const S = (/** @type {number} */ max = 60) => ({ t: "str", max });
const E = (/** @type {string[]} */ ...v) => ({ t: "enum", v });
const BOOL = { t: "bool" };
const NUM = (/** @type {number} */ min, /** @type {number} */ max) => ({ t: "num", min, max });
const ICON = { t: "icon" };
const TONE = E(...TONES);
const ALL = ["tool", "operation", "records", "flow", "static"];

/**
 * @typedef {{ t: "str", max: number } | { t: "enum", v: string[] } | { t: "bool" } | { t: "num", min: number, max: number } | { t: "icon" }} PropType
 * @typedef {{ about: string, tier: 1 | 2, data: string[], props: Record<string, PropType>, content: string[], array?: { key: string, fields: string[], max?: number }, scalars?: string[],
 *   forms: { compact: string, glance: string }, reduce?: { compact?: Rule, glance?: Rule }, sample: any }} BlockSpec
 * @typedef {{ cap?: Record<string, number>, as?: string, drop?: boolean, set?: Record<string, any>, text?: string }} Rule
 */

/** @type {Record<string, BlockSpec>} */
export const BLOCKS = {
  list: { about: "Rows with a title, a line under it and one accessory.", tier: 1, data: ALL, props: { title: S(), density: E("default", "tight") }, content: ["rows", "more", "empty"],
    array: { key: "rows", fields: ["id", "title", "subtitle", "accessory", "icon", "group"] }, forms: { compact: "same", glance: "top 5 and a count" }, reduce: { glance: { cap: { rows: 5 } } },
    sample: { rows: [{ id: "1", title: "Smith intake", subtitle: "Dana, today", accessory: "new" }, { id: "2", title: "Lee engagement letter", subtitle: "Waiting for signature", accessory: "sent" }] } },
  board: { about: "Cards in columns by a stage or choice.", tier: 1, data: ALL, props: { title: S() }, content: ["columns", "more", "empty"], forms: { compact: "one column at a time", glance: "a count per column" },
    reduce: { glance: { as: "boardToStats" } }, sample: { columns: [{ id: "todo", title: "To do", rows: [{ id: "1", title: "Write brief" }] }, { id: "doing", title: "Doing", rows: [{ id: "2", title: "Review" }] }] } },
  summary: { about: "Counts as cards and one small chart.", tier: 1, data: ALL, props: { title: S() }, content: ["cards", "chart", "empty"], forms: { compact: "same", glance: "cards only" },
    reduce: { glance: { as: "summaryCards" } }, sample: { cards: [{ label: "Open", value: "12" }, { label: "Done", value: "48" }], chart: { kind: "bar", points: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }] } } },
  detail: { about: "One record: a body, fields and actions.", tier: 1, data: ALL, props: { title: S() }, content: ["title", "body", "fields"], forms: { compact: "same", glance: "four fields" },
    reduce: { glance: { cap: { fields: 4 } } }, sample: { title: "Smith intake", body: "New matter from the website form.", fields: [{ label: "Client", value: "Dana Smith" }, { label: "Stage", value: "Intake" }] } },
  form: { about: "Fields and one submit. An outward submit shows its exact words first.", tier: 1, data: ["tool", "operation", "static"], props: { title: S() }, content: ["id", "title", "fields", "submit"],
    forms: { compact: "same", glance: "a line pointing to the app" }, reduce: { glance: { as: "formToNote" } },
    sample: { id: "note", title: "Add a note", fields: [{ name: "note", label: "Note", type: "multiline", required: true }], submit: { title: "Save" } } },
  stats: { about: "One to four big numbers, each with an optional change.", tier: 1, data: ALL, props: { title: S(), cols: NUM(1, 4) }, content: ["items", "more"], array: { key: "items", fields: ["label", "value", "delta", "tone"], max: 4 },
    forms: { compact: "two columns", glance: "three numbers" }, reduce: { compact: { set: { cols: 2 } }, glance: { cap: { items: 3 } } },
    sample: { items: [{ label: "Open matters", value: "42", delta: "+3" }, { label: "Billed", value: "$18.4k", delta: "+12%" }, { label: "Overdue", value: "5", tone: "warn" }] } },
  keyvalue: { about: "Labels and values, optionally in groups.", tier: 1, data: ALL, props: { title: S() }, content: ["pairs", "more"], array: { key: "pairs", fields: ["label", "value", "group"] },
    forms: { compact: "one column", glance: "four pairs" }, reduce: { glance: { cap: { pairs: 4 } } }, sample: { pairs: [{ label: "Client", value: "Dana Smith" }, { label: "Opened", value: "3 Oct" }, { label: "Owner", value: "Lee" }] } },
  table: { about: "Columns and rows you can sort and open. A cell is text, or typed by a field kind (money, stage, person, link, date, sealed...): the app draws it with that kind's own renderer, and a sealed cell carries no value, only that it is on file.", tier: 1, data: ALL, props: { title: S(), sort: S(40), desc: BOOL, controls: BOOL }, content: ["columns", "rows", "more", "empty", "total"], forms: { compact: "rows of two lines", glance: "a short list" },
    reduce: { compact: { as: "tableToList" }, glance: { as: "tableToList", cap: { rows: 5 } } },
    sample: { columns: [{ id: "name", title: "Name" }, { id: "stage", title: "Stage" }, { id: "fee", title: "Fee" }], rows: [{ id: "1", cells: { name: "Smith", stage: "Intake", fee: "$2,000" } }, { id: "2", cells: { name: "Lee", stage: "Signing", fee: "$4,500" } }] } },
  timeline: { about: "Dated events with who did them.", tier: 1, data: ALL, props: { title: S() }, content: ["events", "more", "empty"], array: { key: "events", fields: ["id", "when", "title", "subtitle", "actor"] },
    forms: { compact: "same", glance: "last three" }, reduce: { glance: { cap: { events: 3 } } },
    sample: { events: [{ id: "1", when: "Today 9:12", title: "Engagement letter sent", actor: "Dana" }, { id: "2", when: "Yesterday", title: "Intake call", actor: "Lee" }] } },
  calendar: { about: "Dated items on a month, week or agenda.", tier: 2, data: ALL, props: { title: S(), view: E("month", "week", "agenda") }, content: ["events", "more", "empty"], array: { key: "events", fields: ["id", "date", "title", "subtitle"] },
    forms: { compact: "agenda", glance: "next three" }, reduce: { compact: { as: "calendarToList" }, glance: { as: "calendarToList", cap: { rows: 3 } } },
    sample: { events: [{ id: "1", date: "2026-10-12", title: "Closing, Smith" }, { id: "2", date: "2026-10-14", title: "Hearing, Lee" }] } },
  chart: { about: "A series as bars, a line, an area or a donut.", tier: 1, data: ALL, props: { title: S(), kind: E("bar", "line", "area", "donut") }, content: ["points", "empty"], array: { key: "points", fields: ["label", "value"], max: 24 },
    forms: { compact: "same, fewer ticks", glance: "the latest number" }, reduce: { glance: { as: "chartToStats" } }, sample: { points: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }, { label: "Wed", value: 4 }, { label: "Thu", value: 8 }] } },
  document: { about: "A preview of a file or an artifact: pages, an image or text.", tier: 1, data: ALL, props: { title: S(), kind: E("page", "image", "text") }, content: ["title", "kind", "text", "url", "pages"],
    forms: { compact: "one page, tap for more", glance: "title and first page" }, reduce: { glance: { cap: { pages: 1 } } }, sample: { title: "Engagement letter", kind: "text", text: "Dear Dana, thank you for choosing us." } },
  text: { about: "A heading, a paragraph or a note. Plain words, no markup.", tier: 1, data: ["static", "tool", "operation", "records", "flow"], props: { style: E("heading", "prose", "note") }, content: ["text"], scalars: ["text"],
    forms: { compact: "same", glance: "first 160 characters" }, reduce: { glance: { text: "text" } }, sample: { text: "Everything the firm needs this week, in one place." } },
  empty: { about: "Nothing here yet, with one next step.", tier: 1, data: ["static"], props: { icon: ICON }, content: ["title", "hint"], scalars: ["title", "hint"], forms: { compact: "same", glance: "same" }, sample: { title: "No matters yet", hint: "Add the first one to see it here." } },
  stages: { about: "Steps of a process and where it is now.", tier: 2, data: ALL, props: { title: S() }, content: ["steps", "current"], array: { key: "steps", fields: ["id", "title"] }, scalars: ["current"],
    forms: { compact: "mini steps", glance: "the current step" }, reduce: { glance: { as: "stagesToStats" } }, sample: { steps: [{ id: "intake", title: "Intake" }, { id: "sign", title: "Signing" }, { id: "done", title: "Done" }], current: "sign" } },
  people: { about: "People or agents with a role.", tier: 2, data: ALL, props: { title: S() }, content: ["people", "more"], array: { key: "people", fields: ["id", "name", "role"] }, forms: { compact: "same", glance: "a stack of faces" },
    reduce: { glance: { cap: { people: 5 } } }, sample: { people: [{ id: "1", name: "Dana Smith", role: "Client" }, { id: "2", name: "Lee Park", role: "Attorney" }] } },
  activity: { about: "What happened on a record or project, newest first.", tier: 2, data: ALL, props: { title: S() }, content: ["events", "more", "empty"], array: { key: "events", fields: ["id", "when", "title", "actor"] },
    forms: { compact: "same", glance: "last three" }, reduce: { glance: { cap: { events: 3 } } }, sample: { events: [{ id: "1", when: "2m", title: "Flow ran: send intake", actor: "Flows" }] } },
  approval: { about: "Something that needs a yes: the exact words and the answer. It never shrinks.", tier: 2, data: ["tool", "operation", "static", "records", "flow"], props: { title: S() }, content: ["title", "words", "from"],
    forms: { compact: "same", glance: "same" }, sample: { title: "Send the engagement letter", words: [{ label: "To", value: "dana@smith.example" }, { label: "Subject", value: "Your engagement letter" }] } },
  gallery: { about: "Tiles of images or documents.", tier: 2, data: ALL, props: { title: S(), cols: NUM(2, 4) }, content: ["tiles", "more", "empty"], array: { key: "tiles", fields: ["id", "title", "url"] },
    forms: { compact: "two columns", glance: "three tiles" }, reduce: { compact: { set: { cols: 2 } }, glance: { cap: { tiles: 3 } } }, sample: { tiles: [{ id: "1", title: "Floor plan" }, { id: "2", title: "Photo 1" }] } },
  map: { about: "Pins on a map.", tier: 2, data: ALL, props: { title: S() }, content: ["pins", "more", "empty"], array: { key: "pins", fields: ["id", "title", "lat", "lng"] }, forms: { compact: "a list of places", glance: "a short list" },
    reduce: { compact: { as: "mapToList" }, glance: { as: "mapToList", cap: { rows: 3 } } }, sample: { pins: [{ id: "1", title: "Office", lat: "37.77", lng: "-122.42" }] } },
  banner: { about: "One line that needs attention.", tier: 1, data: ["static", "tool", "operation", "records", "flow"], props: { tone: TONE, icon: ICON }, content: ["text"], scalars: ["text"], forms: { compact: "same", glance: "same" }, sample: { text: "Connect your calendar to see events here." } },
  actions: { about: "A row of buttons; one is the primary.", tier: 1, data: ["static"], props: { primary: S(30) }, content: [], forms: { compact: "a bottom bar", glance: "up to three" }, sample: {} },
  records: { about: "The space's own records of one type as a list, board, calendar or dashboard, with the type's own sorting, filters and stored views. The app draws it from its store.", tier: 2, data: ["records"], props: { page: BOOL }, content: [],
    forms: { compact: "phone rows", glance: "a line pointing to the app" }, reduce: { glance: { as: "recordsToNote" } }, sample: {} },
  filter: { about: "Search and filter pills for the blocks beside it.", tier: 2, data: ["static"], props: { search: BOOL, pills: S(200) }, content: ["fields"], forms: { compact: "a sheet", glance: "left out" }, reduce: { glance: { drop: true } }, sample: { fields: [{ name: "q", label: "Search" }] } },
};

/**
 * The kinds a typed table cell may take: the kernel's field kinds (the ones ui/fields/registry draws) and `title` (a row's name, with a tile of initials for a person-like type). A cell is a plain
 * string or number, or { k, v?, f?, s? }: `v` the display-safe value, `f` the little of the field's definition its renderer needs (label, options), `s` a precomputed sort key.
 * A `sealed` cell is { k: "sealed", on: boolean }: it never carries the value or a reference to it, only whether one is on file.
 */
export const CELL_KINDS = ["text", "url", "rich_text", "number", "money", "boolean", "date", "datetime", "choice", "multi_choice", "rating", "link", "ref", "actor", "file", "address", "phones", "emails", "urls", "stage", "sealed", "title"];
const CELL_KEYS = ["k", "v", "f", "s", "link", "who", "on", "initials", "id"];

/** A cell as plain words: for a surface that cannot draw the typed form (a phone list, a chat card). A sealed cell says only that it is sealed. @param {any} c */
export function cellText(c) {
  if (c === null || c === undefined) return "";
  if (typeof c !== "object") return String(c);
  if (c.k === "sealed") return c.on ? "Sealed" : "";
  if (c.link && c.link.title) return String(c.link.title);
  if (c.who && c.who.name) return String(c.who.name);
  const v = c.v;
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(x => (x && typeof x === "object" ? String(x.name || x.title || x.value || "") : String(x))).filter(Boolean).join(", ");
  if (typeof v === "object") return String(v.name || v.title || v.label || v.amount || "");
  return String(v);
}

/** Keys a block may never carry: the language holds data, never style. @type {Record<string, string>} */
const FORBIDDEN = { style: "use props from the catalogue", className: "use props from the catalogue", class: "use props from the catalogue", color: "use tone", colour: "use tone", background: "use tone", width: "use layout weight", height: "use layout weight",
  html: "use a text block", css: "custom styling goes through the Engineer", font: "fonts come from the brand profile", size: "sizes come from tokens" };

/** @param {any} v */
const arr = (/** @type {any} */ x) => (Array.isArray(x) ? x : []);
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const ID = /^[a-z][a-z0-9-]{0,30}$/;
const KEY = /^[a-z][a-zA-Z0-9]{0,23}$/;
/** A table column id: a field's own name (snake case allowed), or `_title`. */
const COL_ID = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- validation

/** Is this string a literal the language never takes in a prop: a colour, a pixel size, markup? @param {string} s */
const literalIn = s => /^#[0-9a-f]{3,8}$/i.test(s.trim()) ? "a colour" : /^(rgb|hsl)a?\(/i.test(s.trim()) ? "a colour" : /\b\d+(\.\d+)?\s*(px|pt|rem|em|vh|vw)\b/i.test(s) ? "a size" : /<\/?[a-z][^>]*>/i.test(s) ? "markup" : /^\s*url\(/i.test(s) ? "a url()" : "";

/**
 * @param {string} at @param {any} v @param {PropType} t @param {string[]} out
 */
function checkProp(at, v, t, out) {
  if (t.t === "str") { if (typeof v !== "string" || v.length > t.max) out.push(`${at} must be text up to ${t.max} characters`); else { const l = literalIn(v); if (l) out.push(`${at} is ${l}; the language takes names (tone, token steps), not values`); } }
  else if (t.t === "enum") { if (!t.v.includes(v)) out.push(`${at} must be one of ${t.v.join(", ")}`); }
  else if (t.t === "bool") { if (typeof v !== "boolean") out.push(`${at} must be true or false`); }
  else if (t.t === "num") { if (typeof v !== "number" || !Number.isFinite(v) || v < t.min || v > t.max) out.push(`${at} must be a number from ${t.min} to ${t.max}`); }
  else if (t.t === "icon") { const p = iconProblem(v); if (p) out.push(`${at}: ${p}`); }
}

/**
 * Check one layout node. Collects the block keys it uses.
 * @param {string} at @param {any} n @param {number} depth @param {Set<string>} used @param {string[]} out @param {{ nodes: number }} count
 */
function checkNode(at, n, depth, used, out, count) {
  if (!isObj(n)) { out.push(`${at} must be an object like { block: "key" } or { col: [...] }`); return; }
  if (++count.nodes > SCREEN_LIMITS.nodes) { if (count.nodes === SCREEN_LIMITS.nodes + 1) out.push(`${at}: a layout holds up to ${SCREEN_LIMITS.nodes} nodes`); return; }
  if (depth > SCREEN_LIMITS.depth) { out.push(`${at}: layouts nest up to ${SCREEN_LIMITS.depth} deep`); return; }
  const kinds = ["block", ...LAYOUT_KINDS].filter(k => n[k] !== undefined);
  if (kinds.length !== 1) { out.push(`${at} needs exactly one of block, ${LAYOUT_KINDS.join(", ")}`); return; }
  for (const k of Object.keys(n)) if (!["block", ...LAYOUT_KINDS, "gap", "weight", "label"].includes(k)) out.push(`${at}.${k} is not a layout key${FORBIDDEN[k] ? `; ${FORBIDDEN[k]}` : ""}`);
  if (n.gap !== undefined && !GAPS.includes(n.gap)) out.push(`${at}.gap must be one of ${GAPS.join(", ")}`);
  if (n.weight !== undefined && !(Number.isInteger(n.weight) && n.weight >= 1 && n.weight <= 4)) out.push(`${at}.weight must be 1 to 4`);
  if (n.label !== undefined && (typeof n.label !== "string" || n.label.length > 30)) out.push(`${at}.label must be up to 30 characters`);
  const kind = kinds[0];
  if (kind === "block") { if (typeof n.block !== "string") out.push(`${at}.block must be a block key`); else used.add(n.block); return; }
  const kids = n[kind];
  if (!Array.isArray(kids) || !kids.length || kids.length > 12) { out.push(`${at}.${kind} needs 1 to 12 children`); return; }
  if (kind === "split" && (kids.length < 2 || kids.length > SCREEN_LIMITS.panes)) out.push(`${at}.split needs 2 or ${SCREEN_LIMITS.panes} panes`);
  if (kind === "tabs") for (const [i, k] of kids.entries()) if (!isObj(k) || typeof k.label !== "string" || !k.label) out.push(`${at}.tabs[${i}] needs a label`);
  kids.forEach((k, i) => checkNode(`${at}.${kind}[${i}]`, k, depth + 1, used, out, count));
}

const PATH = /^[A-Za-z0-9_.$-]{1,120}$/;
/** The keys a block's `map` may hold. @param {string} type */
function mapShape(type) {
  const spec = BLOCKS[type];
  const keys = new Set([...(spec.array ? [spec.array.key, ...spec.array.fields] : []), ...(spec.scalars || [])]);
  if (type === "list" || type === "board") for (const k of ["rows", "id", "title", "subtitle", "accessory", "icon", "group", "url", "column", "tone"]) keys.add(k);
  if (type === "table") for (const k of ["rows", "id", "columns"]) keys.add(k);
  if (type === "detail") for (const k of ["title", "body", "fields"]) keys.add(k);
  if (type === "summary") for (const k of ["cards", "chart"]) keys.add(k);
  return keys;
}

/** A block's `map`: dotted paths only, no expressions; `fields`, `cards` and `columns` are lists of paths with a label, `chart` an object of paths. @param {string} at @param {any} map @param {string} type @param {string[]} out */
function checkMapV2(at, map, type, out) {
  if (map === undefined) return;
  if (!isObj(map)) { out.push(`${at}.map must be an object of dotted paths`); return; }
  const keys = mapShape(type);
  for (const [k, v] of Object.entries(map)) {
    if (!keys.has(k)) { out.push(`${at}.map.${k} is not one of ${[...keys].join(", ")}`); continue; }
    if (k === "fields" || k === "cards" || k === "columns") {
      const label = k === "columns" ? "title" : "label";
      if (!Array.isArray(v) || v.length > 12 || v.some(f => !isObj(f) || typeof f[label] !== "string" || typeof f.path !== "string" || !PATH.test(f.path) || (k === "columns" && !KEY.test(String(f.id))))) out.push(`${at}.map.${k} must be a list of up to 12 { ${k === "columns" ? "id, " : ""}${label}, path }`);
    } else if (k === "chart") {
      if (!isObj(v) || !["rows", "label", "value"].every(x => typeof v[x] === "string" && PATH.test(v[x]))) out.push(`${at}.map.chart must be { kind?, rows, label, value } with dotted paths`);
    } else if (typeof v !== "string" || !PATH.test(v)) out.push(`${at}.map.${k} must be a plain dotted path (no expressions)`);
  }
}

/** The extras a list row may carry beyond title, subtitle, icon, group and one accessory: faces (people, assistants and teammates), provider marks, up to three accessories (a chip, or quiet text with `as: "text"`), a dim flag and up to four actions (an action may carry a `confirm` sentence, said in a sheet before it runs; the first drawn as a button, the rest in an overflow menu; `kind` plain, primary or hold). Words only: a name is text, a tone is one of TONES. */
export const LIST_ROW_EXTRAS = ["faces", "providers", "accessories", "dim", "actions"];

/** @param {string} at @param {any} c @param {string[]} out */
function checkListContent(at, c, out) {
  if (!Array.isArray(c.rows)) return;
  for (const [i, r] of c.rows.entries()) {
    if (!isObj(r)) continue;
    const here = `${at}.rows[${i}]`;
    if (r.faces !== undefined && (!Array.isArray(r.faces) || r.faces.length > 5)) out.push(`${here}.faces must be a list of up to 5 { kind, name }`);
    else for (const [j, f] of (r.faces || []).entries()) if (!isObj(f) || !["person", "assistant", "teammate", "agent", "device"].includes(f.kind) || typeof f.name !== "string" || !f.name || f.name.length > 60 || (f.id !== undefined && (typeof f.id !== "string" || f.id.length > 80)) || (f.device !== undefined && !["phone", "computer", "server"].includes(f.device))) out.push(`${here}.faces[${j}] needs { kind: person | assistant | teammate | agent | device, name, id?, device?: phone | computer | server }`);
    if (r.providers !== undefined && (!Array.isArray(r.providers) || r.providers.length > 3 || r.providers.some((/** @type {any} */ p) => typeof p !== "string" || !p || p.length > 30))) out.push(`${here}.providers must be a list of up to 3 names`);
    if (r.accessories !== undefined && (!Array.isArray(r.accessories) || r.accessories.length > 3)) out.push(`${here}.accessories must be a list of up to 3`);
    else for (const [j, a] of (r.accessories || []).entries()) if (!isObj(a) || typeof a.label !== "string" || !a.label || a.label.length > 40 || (a.tone !== undefined && !TONES.includes(a.tone)) || (a.as !== undefined && !["chip", "text"].includes(a.as))) out.push(`${here}.accessories[${j}] needs { label, tone?: ${TONES.join(" | ")}, as?: chip | text }`);
    if (r.dim !== undefined && typeof r.dim !== "boolean") out.push(`${here}.dim must be true or false`);
    if (r.actions !== undefined && (!Array.isArray(r.actions) || r.actions.length > 4)) out.push(`${here}.actions must be a list of up to 4`);
    else for (const [j, a] of (r.actions || []).entries()) if (!isObj(a) || typeof a.id !== "string" || !KEY.test(a.id) || typeof a.title !== "string" || !a.title || a.title.length > 60 || (a.kind !== undefined && !["plain", "primary", "hold"].includes(a.kind)) || (a.confirm !== undefined && (typeof a.confirm !== "string" || a.confirm.length > 400))) out.push(`${here}.actions[${j}] needs { id, title, kind?: plain | primary | hold, confirm?: up to 400 characters }`);
  }
}

/** A table's resolved content: columns { id, title, kind?, options?, role?, sort? } and rows { id, cells }, each cell a string, a number, null or a typed cell. A sealed cell may carry nothing of the value. @param {string} at @param {any} c @param {string[]} out */
function checkTableContent(at, c, out) {
  if (c.columns !== undefined && (!Array.isArray(c.columns) || c.columns.length > 16 || c.columns.some((/** @type {any} */ x) => !isObj(x) || !COL_ID.test(String(x.id)) || typeof x.title !== "string" || (x.kind !== undefined && !CELL_KINDS.includes(x.kind))))) out.push(`${at}.columns must be up to 16 { id, title, kind? } with a kind from ${CELL_KINDS.join(", ")}`);
  if (c.rows === undefined) return;
  if (!Array.isArray(c.rows) || c.rows.length > 1000) { out.push(`${at}.rows must be a list of up to 1000 rows`); return; }
  for (const [i, r] of c.rows.entries()) {
    if (!isObj(r) || !isObj(r.cells)) { out.push(`${at}.rows[${i}] needs { id, cells }`); continue; }
    for (const [col, cell] of Object.entries(r.cells)) {
      if (cell === null || typeof cell === "string" || typeof cell === "number") continue;
      if (!isObj(cell) || !CELL_KINDS.includes(/** @type {any} */ (cell).k)) { out.push(`${at}.rows[${i}].cells.${col} is text, a number, or { k } with k one of ${CELL_KINDS.join(", ")}`); continue; }
      const bad = Object.keys(cell).filter(k => !CELL_KEYS.includes(k));
      if (bad.length) out.push(`${at}.rows[${i}].cells.${col}.${bad[0]} is not a cell key (${CELL_KEYS.join(", ")})`);
      // A sealed cell says whether a value is on file and nothing else: no value, no reference, no sort key, no definition.
      if (/** @type {any} */ (cell).k === "sealed" && Object.keys(cell).some(k => !["k", "on"].includes(k))) out.push(`${at}.rows[${i}].cells.${col}: a sealed cell carries only { k: "sealed", on }, never the value`);
    }
  }
}

/**
 * Check a screen, declared (blocks carry `data`) or resolved (blocks carry `content`). Messages name the path and the fix. Tool names and actions are checked as the module contract does when `c` is given.
 * @param {any} screen @param {{ tools: Set<string>, allowed: Set<string>, firstParty: boolean } | null} [c]
 * @returns {string[]}
 */
export function validateScreen(screen, c = null) {
  /** @type {string[]} */ const out = [];
  if (!isObj(screen)) return ["screen must be an object"];
  for (const k of Object.keys(screen)) if (!["v", "id", "kind", "title", "layout", "blocks", "surfaces", "forms", "from", "surface"].includes(k)) out.push(`screen.${k} is not a screen key${FORBIDDEN[k] ? `; ${FORBIDDEN[k]}` : ""}`);
  if (screen.v !== 2) out.push("screen.v must be 2");
  if (screen.title !== undefined && (typeof screen.title !== "string" || !screen.title || screen.title.length > 60)) out.push("screen.title needs up to 60 characters");
  if (!isObj(screen.blocks)) { out.push("screen.blocks must be an object of blocks"); return out; }
  const keys = Object.keys(screen.blocks);
  if (!keys.length) out.push("screen.blocks needs at least one block");
  if (keys.length > SCREEN_LIMITS.blocks) out.push(`screen.blocks holds up to ${SCREEN_LIMITS.blocks} blocks`);
  const forms = isObj(screen.forms) ? screen.forms : {};
  const fc = c ? { ...c, forms: new Set(Object.keys(forms)) } : null;
  for (const [name, f] of Object.entries(forms)) { if (!ID.test(name)) out.push(`screen.forms "${name}" must be lowercase letters, digits and dashes`); if (c) checkForm(`screen.forms.${name}`, f, c, out); }
  for (const [key, b] of Object.entries(screen.blocks)) {
    const at = `blocks.${key}`;
    if (!KEY.test(key)) { out.push(`${at}: a block key is a word like "stats1" (letters and digits)`); continue; }
    if (!isObj(b)) { out.push(`${at} must be an object`); continue; }
    const spec = BLOCKS[b.type];
    if (!spec) { out.push(`${at}.type "${b.type}" is not a block; the types are ${Object.keys(BLOCKS).join(", ")}`); continue; }
    for (const k of Object.keys(b)) if (!["type", "data", "props", "actions", "content", "empty", "detail", "need"].includes(k)) out.push(`${at}.${k} is not a block key${FORBIDDEN[k] ? `; ${FORBIDDEN[k]}` : ""}`);
    if (b.props !== undefined) {
      if (!isObj(b.props)) out.push(`${at}.props must be an object`);
      else for (const [pk, pv] of Object.entries(b.props)) {
        if (!spec.props[pk]) out.push(`${at}.props.${pk} is not a prop of ${b.type}${FORBIDDEN[pk] ? `; ${FORBIDDEN[pk]}` : `; its props are ${Object.keys(spec.props).join(", ") || "none"}`}`);
        else checkProp(`${at}.props.${pk}`, pv, spec.props[pk], out);
      }
    }
    if (b.empty !== undefined && (typeof b.empty !== "string" || b.empty.length > 200)) out.push(`${at}.empty must be a short sentence`);
    if (b.data !== undefined) {
      if (!isObj(b.data)) out.push(`${at}.data must be an object`);
      else {
        for (const k of Object.keys(b.data)) if (![...DATA_KINDS, "input", "map", "columns", "tones"].includes(k)) out.push(`${at}.data.${k} is not a data key (${DATA_KINDS.join(", ")}, input, map${b.type === "board" ? ", columns" : ""}${b.type === "list" || b.type === "board" ? ", tones" : ""})`);
        if (b.data.tones !== undefined && (!["list", "board"].includes(b.type) || !isObj(b.data.tones) || Object.keys(b.data.tones).length > 20 || Object.values(b.data.tones).some(v => !TONES.includes(/** @type {string} */ (v))))) out.push(`${at}.data.tones is for a list or board: up to 20 values mapped to ${TONES.join(", ")}`);
        if (b.data.columns !== undefined && (b.type !== "board" || !Array.isArray(b.data.columns) || b.data.columns.length > 8)) out.push(`${at}.data.columns is for a board: up to 8 columns`);
        const kinds = DATA_KINDS.filter(k => b.data[k] !== undefined);
        if (kinds.length !== 1) out.push(`${at}.data needs exactly one of ${DATA_KINDS.join(", ")}`);
        else if (!spec.data.includes(kinds[0])) out.push(`${at}.data.${kinds[0]}: a ${b.type} reads ${spec.data.join(", ")}`);
        else {
          const dk = kinds[0], d = b.data;
          if (dk === "tool" || dk === "operation") {
            if (dk === "tool" && c) checkTool(`${at}.data.tool`, d.tool, c, out);
            else if (dk === "tool" && (typeof d.tool !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/.test(d.tool))) out.push(`${at}.data.tool must name a tool like module.verb`);
            if (dk === "operation" && (!isObj(d.operation) || typeof d.operation.connection !== "string" || typeof d.operation.operation !== "string")) out.push(`${at}.data.operation needs { connection, operation }`);
            if (d.input !== undefined && !isObj(d.input)) out.push(`${at}.data.input must be an object`);
            checkMapV2(`${at}.data`, d.map, b.type, out);
          } else if (dk === "static" && !isObj(d.static)) out.push(`${at}.data.static must be an object`);
          else if (dk === "static" && b.type === "form" && !forms[d.static.form]) out.push(`${at}.data.static.form "${d.static.form}" is not one of screen.forms`);
          else if (dk === "records" && (!isObj(d.records) || typeof d.records.type !== "string")) out.push(`${at}.data.records needs { type }`);
          else if (dk === "flow" && (!isObj(d.flow) || typeof d.flow.id !== "string")) out.push(`${at}.data.flow needs { id }`);
        }
      }
    }
    if (b.type === "table" && isObj(b.content)) checkTableContent(`${at}.content`, b.content, out);
    if (b.type === "list" && isObj(b.content)) checkListContent(`${at}.content`, b.content, out);
    if (b.type === "records" && !(b.data && b.data.records)) out.push(`${at}.data.records needs { type }: a records block reads the space's own records`);
    if (b.content !== undefined) {
      if (!isObj(b.content)) out.push(`${at}.content must be an object`);
      else for (const k of Object.keys(b.content)) if (!spec.content.includes(k)) out.push(`${at}.content.${k} is not content of ${b.type}; it holds ${spec.content.join(", ") || "none"}`);
    }
    if (b.detail !== undefined) {
      if (!["list", "table", "board"].includes(b.type)) out.push(`${at}.detail is for a list, table or board`);
      else if (!isObj(b.detail)) out.push(`${at}.detail must be { tool, map }`);
      else { if (c) checkTool(`${at}.detail.tool`, b.detail.tool, c, out); checkMapV2(`${at}.detail`, b.detail.map, "detail", out); }
    }
    if (b.actions !== undefined) {
      if (!Array.isArray(b.actions) || b.actions.length > LIMITS.actions) out.push(`${at}.actions must be a list of up to ${LIMITS.actions} actions`);
      else if (c && fc) { const ids = new Set(); for (const [i, a] of b.actions.entries()) { checkAction(`${at}.actions[${i}]`, a, fc, out); if (a && ids.has(a.id)) out.push(`${at}.actions "${a.id}" is declared twice`); ids.add(a && a.id); } }
      else for (const [i, a] of b.actions.entries()) if (!isObj(a) || typeof a.id !== "string" || !ID.test(a.id) || typeof a.title !== "string") out.push(`${at}.actions[${i}] needs { id, title }`);
    }
  }
  const used = new Set();
  if (screen.layout === undefined) out.push("screen.layout is required");
  else checkNode("layout", screen.layout, 1, used, out, { nodes: 0 });
  for (const u of used) if (!screen.blocks[u]) out.push(`layout names block "${u}", which screen.blocks does not have`);
  for (const k of keys) if (!used.has(k)) out.push(`blocks.${k} is not in the layout; add it or remove it`);
  if (screen.surfaces !== undefined) {
    if (!isObj(screen.surfaces)) out.push("screen.surfaces must be an object");
    else for (const [s, o] of Object.entries(screen.surfaces)) {
      if (!SURFACES.includes(s) || s === "app") { out.push(`screen.surfaces.${s}: overrides are for ${SURFACES.filter(x => x !== "app").join(", ")}`); continue; }
      if (!isObj(o)) { out.push(`screen.surfaces.${s} must be an object`); continue; }
      for (const k of Object.keys(o)) if (!["layout", "blocks"].includes(k)) out.push(`screen.surfaces.${s}.${k} is not an override key (layout, blocks)`);
      const merged = applyOverride(screen, s);
      // An override may leave a block out of its own layout on purpose, so "not in the layout" is not a fault there.
      if (merged) for (const p of validateScreen({ ...merged, surfaces: undefined }, c)) if (!/is not in the layout/.test(p)) out.push(`surfaces.${s}: ${p}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(screen)) > SCREEN_LIMITS.bytes) out.push(`screen is larger than ${SCREEN_LIMITS.bytes / 1024} KB`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- reduction

/** @param {any} b @returns {any[]} */
const arrOf = (b, /** @type {string} */ k) => (b && b.content && Array.isArray(b.content[k]) ? b.content[k] : []);
const withContent = (/** @type {any} */ b, /** @type {string} */ type, /** @type {any} */ content, /** @type {any} */ props) => {
  const { data: _data, ...rest } = b;
  return { ...rest, type, content, props: Object.fromEntries(Object.entries(props || {}).filter(([, v]) => v !== undefined)) };
};
/** @param {any[]} a @param {number} n */
const capped = (a, n) => ({ items: a.slice(0, n), more: a.length > n ? a.length - n : 0 });

/** Named shrinks that change a block's type. Each returns a block in the same language, or null to leave the block out. @type {Record<string, (b: any, r: Rule) => any>} */
const TRANSFORMS = {
  boardToStats: b => withContent(b, "stats", { items: (b.content && Array.isArray(b.content.columns) ? b.content.columns : []).slice(0, 3).map((/** @type {any} */ c) => ({ label: String(c.title || c.id), value: String((c.rows || []).length) })) }, { title: b.props && b.props.title }),
  summaryCards: b => withContent(b, "stats", { items: arrOf(b, "cards").slice(0, 3).map((/** @type {any} */ c) => ({ label: c.label, value: c.value })) }, { title: b.props && b.props.title }),
  recordsToNote: b => withContent(b, "text", { text: `${(b.data && b.data.records && b.data.records.type) || "These"} records are in the app.` }, { style: "note" }),
  formToNote: b => withContent(b, "text", { text: `${(b.content && b.content.title) || "This form"}: open it in the app to fill it in.` }, { style: "note" }),
  tableToList: (b, r) => {
    const cols = arrOf(b, "columns").map((/** @type {any} */ c) => c.id), { items, more } = capped(arrOf(b, "rows"), (r.cap && r.cap.rows) || 1000);
    return withContent(b, "list", { rows: items.map((/** @type {any} */ x) => ({ id: x.id, title: cellText((x.cells || {})[cols[0]]), subtitle: cols.slice(1, 3).map((/** @type {string} */ c) => cellText((x.cells || {})[c])).filter(Boolean).join(" · ") })), ...(more ? { more } : {}) }, { title: b.props && b.props.title });
  },
  calendarToList: (b, r) => {
    const { items, more } = capped([...arrOf(b, "events")].sort((x, y) => String(x.date).localeCompare(String(y.date))), (r.cap && r.cap.rows) || 1000);
    return withContent(b, "list", { rows: items.map((/** @type {any} */ x) => ({ id: x.id, title: x.title, subtitle: x.date, ...(x.subtitle ? { accessory: x.subtitle } : {}) })), ...(more ? { more } : {}) }, { title: b.props && b.props.title });
  },
  mapToList: (b, r) => {
    const { items, more } = capped(arrOf(b, "pins"), (r.cap && r.cap.rows) || 1000);
    return withContent(b, "list", { rows: items.map((/** @type {any} */ x) => ({ id: x.id, title: x.title })), ...(more ? { more } : {}) }, { title: b.props && b.props.title });
  },
  chartToStats: b => {
    const pts = arrOf(b, "points"), last = pts[pts.length - 1];
    return withContent(b, "stats", { items: last ? [{ label: String(last.label), value: String(last.value), spark: pts.slice(-12).map((/** @type {any} */ p) => Number(p.value)) }] : [] }, { title: b.props && b.props.title });
  },
  stagesToStats: b => {
    const cur = arrOf(b, "steps").find((/** @type {any} */ s) => s.id === (b.content && b.content.current));
    return withContent(b, "stats", { items: [{ label: "Stage", value: String((cur && cur.title) || (b.content && b.content.current) || "") }] }, { title: b.props && b.props.title });
  },
};

/**
 * One block as a surface's form draws it. `full` is the block as is. Same language in, same language out; a shrink never invents data.
 * @param {any} block @param {"full" | "compact" | "glance"} form @returns {any | null}
 */
export function reduceBlock(block, form) {
  if (form === "full" || !isObj(block)) return block;
  const spec = BLOCKS[block.type], rule = spec && spec.reduce && spec.reduce[form];
  if (!rule) return block;
  if (rule.drop) return null;
  let b = rule.as ? TRANSFORMS[rule.as](block, rule) : block;
  if (!b) return null;
  if (rule.cap && b.content) {
    const content = { ...b.content };
    for (const [k, n] of Object.entries(rule.cap)) if (Array.isArray(content[k]) && content[k].length > n) { content.more = (content.more || 0) + (content[k].length - n); content[k] = content[k].slice(0, n); }
    b = { ...b, content };
  }
  if (rule.set) b = { ...b, props: { ...(b.props || {}), ...rule.set } };
  if (rule.text && b.content && typeof b.content[rule.text] === "string") b = { ...b, content: { ...b.content, [rule.text]: clip(b.content[rule.text], 160) } };
  return b;
}

/**
 * The screen with a surface's override laid on: its layout replaces the base layout, and each of its blocks patches the block of the same key (props and content merge; null removes the block).
 * Returns null when the surface has no override.
 * @param {any} screen @param {string} surface
 */
export function applyOverride(screen, surface) {
  const o = screen && screen.surfaces && screen.surfaces[surface];
  if (!isObj(o)) return null;
  /** @type {Record<string, any>} */ const blocks = { ...screen.blocks };
  for (const [k, patch] of Object.entries(isObj(o.blocks) ? o.blocks : {})) {
    if (patch === null) delete blocks[k];
    else if (isObj(patch)) blocks[k] = blocks[k] ? { ...blocks[k], ...patch, props: { ...(blocks[k].props || {}), ...(patch.props || {}) }, content: patch.content ? { ...(blocks[k].content || {}), ...patch.content } : blocks[k].content } : patch;
  }
  return { ...screen, blocks, layout: o.layout || pruneLayout(screen.layout, blocks) };
}

/** A layout without the leaves whose block is gone. @param {any} n @param {Record<string, any>} blocks @returns {any} */
function pruneLayout(n, blocks) {
  if (!isObj(n)) return n;
  if (n.block !== undefined) return blocks[n.block] ? n : null;
  const kind = LAYOUT_KINDS.find(k => n[k] !== undefined);
  if (!kind) return n;
  const kids = n[kind].map((/** @type {any} */ k) => pruneLayout(k, blocks)).filter(Boolean);
  return kids.length ? { ...n, [kind]: kids } : null;
}

/** The block keys of a layout in reading order. @param {any} n @param {string[]} [acc] @returns {string[]} */
function leaves(n, acc = []) {
  if (!isObj(n)) return acc;
  if (n.block !== undefined) { acc.push(n.block); return acc; }
  const kind = LAYOUT_KINDS.find(k => n[k] !== undefined);
  if (kind) for (const k of n[kind]) leaves(k, acc);
  return acc;
}

/** A layout as a phone draws it: rows and grids stack, a split becomes push navigation. Tabs stay (a segmented control). @param {any} n @returns {any} */
function compactLayout(n) {
  if (!isObj(n) || n.block !== undefined) return n;
  const kind = LAYOUT_KINDS.find(k => n[k] !== undefined);
  if (!kind) return n;
  const kids = n[kind].map(compactLayout), to = kind === "row" || kind === "grid" ? "col" : kind === "split" ? "stack" : kind;
  const { [kind]: _drop, ...rest } = n;
  return { ...rest, [to]: kids };
}

/**
 * The screen as one surface draws it. Order: the surface's override is laid on; every block shrinks to the surface's form; then the layout shrinks, unless the override gave its own layout (the designer's
 * layout for that surface is final). A glance keeps up to three blocks in reading order, and an approval is never left out.
 * @param {any} screen a resolved screen @param {"app" | "phone" | "chat" | "lumen"} surface
 */
export function reduceScreen(screen, surface) {
  if (!isObj(screen) || screen.v !== 2) return screen;
  const form = /** @type {"full" | "compact" | "glance"} */ (FORM_OF[surface] || "full");
  const over = surface !== "app" ? applyOverride(screen, surface) : null;
  const base = over || screen;
  const ownLayout = Boolean(over && screen.surfaces[surface].layout);
  /** @type {Record<string, any>} */ const blocks = {};
  for (const [k, b] of Object.entries(base.blocks)) { const r = reduceBlock(b, form); if (r) blocks[k] = r; }
  let layout = pruneLayout(base.layout, blocks);
  if (!layout) layout = { col: [] };
  if (form !== "full" && !ownLayout) {
    if (form === "compact") layout = compactLayout(layout);
    else {
      // A glance keeps up to three blocks in reading order, and every approval, whatever the count.
      const order = leaves(layout), isAsk = (/** @type {string} */ k) => blocks[k].type === "approval";
      let room = Math.max(0, SCREEN_LIMITS.glance - order.filter(isAsk).length);
      const picked = order.filter(k => isAsk(k) || room-- > 0);
      layout = { col: picked.map(k => ({ block: k })) };
      for (const k of Object.keys(blocks)) if (!picked.includes(k)) delete blocks[k];
    }
  }
  // Everything shrank away (a screen of one filter, say): say so in one line, so a surface never draws nothing.
  if (!Object.keys(blocks).length) { blocks.note = { type: "text", props: { style: "note" }, content: { text: "Open this in the app." } }; layout = { block: "note" }; }
  const { surfaces: _s, ...rest } = base;
  return { ...rest, layout, blocks, surface };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- v1 frames

const FRAME_BLOCK = { list: "list", board: "board", summary: "summary", detail: "detail", form: "form" };

/**
 * A v1 frame as a one-block screen, so the engine has one shape. needs, held and error frames become a banner. Returns the frame unchanged when it is not a v1 frame.
 * @param {any} frame
 */
export function wrapFrame(frame) {
  if (!isObj(frame) || frame.v !== 1) return frame;
  const title = typeof frame.title === "string" ? frame.title : undefined;
  const screen = (/** @type {any} */ block) => ({ v: 2, kind: "screen", id: "frame", ...(title ? { title } : {}), ...(frame.from ? { from: frame.from } : {}), layout: { block: "main" }, blocks: { main: block } });
  if (FRAME_BLOCK[/** @type {keyof typeof FRAME_BLOCK} */ (frame.kind)]) {
    const spec = BLOCKS[frame.kind];
    /** @type {Record<string, any>} */ const content = {};
    for (const k of spec.content) if (frame[k] !== undefined) content[k] = frame[k];
    return screen({ type: frame.kind, props: title ? { title } : {}, content, ...(frame.actions ? { actions: frame.actions } : {}) });
  }
  if (frame.kind === "needs" || frame.kind === "held" || frame.kind === "error") {
    return screen({ type: "banner", props: { tone: frame.kind === "error" ? "err" : frame.kind === "needs" ? "warn" : "plain" }, content: { text: String(frame.message || "That did not work.") }, ...(frame.need ? { need: frame.need } : {}) });
  }
  return frame;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- data to content

/** A number or text as a short string. @param {any} v */
const text = v => (typeof v === "number" && Number.isFinite(v) ? String(v) : clip(v, 200));

/**
 * Read a tool's answer into a block's content by dotted paths. For a block with an array: map[<array key>] is the path to the array (the answer itself when absent), and map[<field>] the path inside each item
 * (the field's own name when absent). For a block with scalars: map[<scalar>] is the path. No expressions. Blocks with their own builders (list, board, summary, detail, form) use frames.js instead.
 * @param {string} type @param {any} map @param {any} answer
 * @returns {Record<string, any>}
 */
export function contentFrom(type, map, answer) {
  const spec = BLOCKS[type], m = isObj(map) ? map : {};
  /** @type {Record<string, any>} */ const out = {};
  if (!spec) return out;
  if (type === "table") {
    const cols = (Array.isArray(m.columns) ? m.columns : []).slice(0, 8);
    const raw = m.rows !== undefined ? getPath(answer, m.rows) : Array.isArray(answer) ? answer : getPath(answer, "rows");
    const src = Array.isArray(raw) ? raw : [];
    out.columns = cols.map((/** @type {any} */ c) => ({ id: String(c.id), title: clip(c.title, 40) }));
    out.rows = src.slice(0, LIMITS.rows).map((r, i) => ({ id: text(getPath(r, m.id || "id")) || String(i + 1), cells: Object.fromEntries(cols.map((/** @type {any} */ c) => [String(c.id), text(getPath(r, c.path))])) }));
    if (src.length > LIMITS.rows) out.more = src.length - LIMITS.rows;
    if (!src.length) out.empty = "Nothing here.";
    return out;
  }
  if (spec.array) {
    const raw = m[spec.array.key] !== undefined ? getPath(answer, m[spec.array.key]) : Array.isArray(answer) ? answer : getPath(answer, spec.array.key);
    const src = Array.isArray(raw) ? raw : [];
    const max = spec.array.max || LIMITS.rows;
    out[spec.array.key] = src.slice(0, max).map((r, i) => {
      /** @type {Record<string, any>} */ const item = {};
      for (const f of spec.array ? spec.array.fields : []) { const v = getPath(r, m[f] || f); const s = text(v); if (s !== "") item[f] = s; }
      if (spec.array && spec.array.fields.includes("id") && !item.id) item.id = String(i + 1);
      return item;
    });
    if (src.length > max) out.more = src.length - max;
    if (!src.length && spec.content.includes("empty")) out.empty = "Nothing here.";
  }
  for (const s of spec.scalars || []) { const v = m[s] !== undefined ? getPath(answer, m[s]) : getPath(answer, s); if (v !== undefined && v !== null) out[s] = clip(v, LIMITS.body); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- catalogue

/** @param {PropType} t */
const propText = t => (t.t === "enum" ? t.v.join("|") : t.t === "str" ? "text" : t.t === "num" ? `${t.min}-${t.max}` : t.t);

/**
 * What agents and the gallery read, generated from the registry. `index` is one line per block; `block` is one block in full with its sample; `layouts` the layout words.
 * @param {"index" | "block" | "layouts"} [level] @param {string} [type]
 */
export function catalogue(level = "index", type) {
  if (level === "layouts") return `layouts: ${LAYOUT_KINDS.join(", ")}. A node is { block: "key" } or { <layout>: [nodes], gap?: ${GAPS[0]}..${GAPS[GAPS.length - 1]}, weight?: 1-4, label? }. split = list and pane (a phone pushes), tabs need a label each, depth up to ${SCREEN_LIMITS.depth}, ${SCREEN_LIMITS.blocks} blocks. Overrides: screen.surfaces.{phone,chat,lumen}.{layout,blocks}.`;
  if (level === "block") {
    const s = type && BLOCKS[type];
    if (!s) return `unknown block "${type}"; the types are ${Object.keys(BLOCKS).join(", ")}`;
    return JSON.stringify({ type, about: s.about, data: s.data, props: Object.fromEntries(Object.entries(s.props).map(([k, t]) => [k, propText(t)])), content: s.content, ...(s.array ? { array: s.array } : {}), ...(s.scalars ? { scalars: s.scalars } : {}), compact: s.forms.compact, glance: s.forms.glance, sample: s.sample });
  }
  return Object.entries(BLOCKS).map(([t, s]) => `${t}: ${s.about} props ${Object.entries(s.props).map(([k, p]) => `${k}(${propText(p)})`).join(" ") || "-"}; data ${s.data.length === ALL.length ? "any" : s.data.join(",")}; phone ${s.forms.compact}; chat ${s.forms.glance}`).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- Lumen

/**
 * A screen's glance (what reduceScreen gives chat and Lumen) written as one of the v1 frames Lumen already draws, so every Lumen draws it with no new code and the same description serves it:
 * the first block that is rows (a list, the events of a timeline or activity, people) makes a `list` frame with the numbers and facts above it as rows; with no rows, a `detail` frame whose body is
 * the text and whose fields are the numbers and pairs. Read-only: no action is carried, because an action here would need the block it belongs to, so the frame says to open Vyre.
 * @param {any} screen a resolved glance screen @returns {any}
 */
export function glanceFrame(screen) {
  if (!isObj(screen) || screen.v !== 2) return screen;
  const order = leaves(screen.layout).map(k => screen.blocks[k]).filter(Boolean);
  const title = typeof screen.title === "string" ? screen.title : "";
  const from = screen.from ? { from: screen.from } : {};
  /** @type {{ label: string, value: string }[]} */ const facts = [];
  /** @type {string[]} */ const words = [];
  let rows = /** @type {any[] | null} */ (null), more = false, empty = "";
  let asks = false;
  for (const b of order) {
    const c = b.content || {};
    if (b.type === "stats") for (const it of arr(c.items)) facts.push({ label: String(it.label ?? ""), value: [it.value, it.delta].filter(x => x !== undefined && x !== "").join("  ") });
    else if (b.type === "keyvalue") for (const p of arr(c.pairs)) facts.push({ label: String(p.label ?? ""), value: String(p.value ?? "") });
    else if (b.type === "text" || b.type === "banner") words.push(String(c.text ?? ""));
    else if (b.type === "empty") words.push([c.title, c.hint].filter(Boolean).join(". "));
    else if (b.type === "approval") { asks = true; words.push(String(c.title ?? "Needs your yes")); for (const w of arr(c.words)) facts.push({ label: String(w.label ?? ""), value: String(w.value ?? "") }); }
    else if (!rows && (b.type === "list" || b.type === "timeline" || b.type === "activity" || b.type === "people")) {
      const src = b.type === "list" ? arr(c.rows) : b.type === "people" ? arr(c.people) : arr(c.events);
      rows = src.map((r, i) => b.type === "list" ? { id: String(r.id ?? i), title: String(r.title ?? ""), ...(r.subtitle ? { subtitle: String(r.subtitle) } : {}), ...(r.accessory ? { accessory: String(r.accessory) } : {}), actions: [] }
        : b.type === "people" ? { id: String(r.id ?? i), title: String(r.name ?? ""), ...(r.role ? { subtitle: String(r.role) } : {}), actions: [] }
        : { id: String(r.id ?? i), title: String(r.title ?? ""), subtitle: [r.actor, r.when].filter(Boolean).join(", "), actions: [] });
      more = Boolean(c.more); empty = String(c.empty || "");
    } else if (b.type === "table") { const r2 = reduceBlock(b, "glance"); if (r2 && r2.type === "list" && !rows) rows = arr(r2.content && r2.content.rows).map((r, i) => ({ id: String(r.id ?? i), title: String(r.title ?? ""), ...(r.subtitle ? { subtitle: String(r.subtitle) } : {}), actions: [] })); }
  }
  const hint = asks || order.some(b => arr(b.actions).length) ? "Open Vyre to answer." : "";
  if (rows) {
    const lead = facts.slice(0, 4).map((f, i) => ({ id: `fact${i}`, title: f.value || f.label, subtitle: f.value ? f.label : undefined, actions: [] })).map(r => (r.subtitle ? r : { id: r.id, title: r.title, actions: [] }));
    return { v: 1, kind: "list", title, rows: [...lead, ...rows].slice(0, 50), ...(more ? { more: true } : {}), ...(rows.length || lead.length ? {} : { empty: empty || "Nothing here." }), ...from };
  }
  return { v: 1, kind: "detail", title, body: [...words, hint].filter(Boolean).join("\n\n"), fields: facts.slice(0, 12), actions: [], ...from };
}
