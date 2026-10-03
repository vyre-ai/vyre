// @vyre/ui/fields/logic: the pure half of the field renderers (ui-primitives.md section 4), ported from deck/ui/fields.js with the DOM taken out. Formatting,
// emptiness, filter ops and tests, sort keys, the rich-text marks, the stage menu a rule narrows and the sealed phrases. No React, no store, no clock unless it is passed in.
// Values are the kernel's FieldValue (kernel/contracts/fields.d.ts): Money { amount, currency }, Address, { urn }, { actor }, { file, name, bytes }, string[] for
// phones and emails, a date as "YYYY-MM-DD", a sealed value as { sealed, ref?, present, valid_format, set_at, hint? }.

/** How long a revealed value stays on screen. Same number as the kernel's reveal result (deck/ui/kernel-view.js REVEAL_MS). */
export const REVEAL_MS = 30_000;
/** What a person sees where a sealed value is: always the same, so the length of the value is not given away. */
export const MASK = "••••••••";
/** The purpose a Reveal passes to the store (seal.reveal records it with the person's proof). */
export const REVEAL_PURPOSE = "Show it on my screen";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The fifteen kinds a person picks from in Add a field, as [kind the kernel stores, label]. phone, email and rich text are the kernel's phones, emails and rich_text. */
export const PICKABLE_KINDS = [
  ["text", "Text"], ["number", "Number"], ["money", "Money"], ["date", "Date"], ["choice", "Choice"], ["stage", "Stage"], ["actor", "Person or assistant"],
  ["link", "Link"], ["file", "File"], ["address", "Address"], ["phones", "Phone"], ["emails", "Email"], ["rich_text", "Rich text"], ["rating", "Rating"], ["sealed", "Sealed"],
];

const ALIAS = { phone: "phones", email: "emails", richText: "rich_text", url: "urls" };
/** The kernel's name for a kind, accepting the short names the prototype used (phone, email, richText). @param {string} kind */
export const normalizeKind = (kind) => ALIAS[kind] || kind;

/** @param {any} v */
export function isEmpty(v) {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    if (typeof v.sealed === "string") return v.present === false;
    if ("amount" in v) return v.amount === null || v.amount === undefined;
    if ("urn" in v) return !v.urn;
    if ("actor" in v) return !v.actor;
    if ("file" in v) return !v.file && !v.name;
    if ("line1" in v || "city" in v || "region" in v || "postal" in v || "country" in v || "line2" in v) return !Object.values(v).some((x) => !!x);
  }
  return false;
}

/** A sealed value, whatever the field's kind: an object with a `sealed` string. @param {any} v */
export const isSealedValue = (v) => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.sealed === "string";
/** A sealed value the person may reveal (it has a ref); a placeholder (no ref) is what an assistant reads. @param {any} v */
export const isRevealable = (v) => isSealedValue(v) && typeof v.ref === "string";

/** @param {any} v */
const str = (v) => (typeof v === "object" && v ? String(v.name ?? v.title ?? "") : String(v ?? ""));

/** The kernel's Address as one line: "18 Larkin St, San Francisco, CA 94109". @param {any} a */
export function addrText(a) {
  if (!a || typeof a !== "object") return String(a ?? "");
  const regionPostal = [a.region, a.postal].filter(Boolean).join(" ");
  return [a.line1, a.line2, a.city, regionPostal, a.country].filter(Boolean).join(", ");
}
/** The values of a multi-value field as an array of strings. @param {any} v @returns {string[]} */
export const listOf = (v) => (Array.isArray(v) ? v.map(String) : isEmpty(v) ? [] : [String(v)]);
/** The target urn of a ref or a link value. @param {any} v */
export const urnOf = (v) => (v && typeof v === "object" ? String(v.urn || "") : String(v || ""));
/** The actor id of an actor value. @param {any} v */
export const actorIdOf = (v) => (v && typeof v === "object" ? String(v.actor?.id || v.id || "") : String(v || ""));

/** A date value (an ISO day, a full ISO time or milliseconds) as a local Date, or null. @param {any} v */
export function toDate(v) {
  if (isEmpty(v)) return null;
  if (typeof v === "number") return new Date(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
/** "Oct 28", with the year when it is not this one. @param {any} v @param {number} [now] */
export function fmtDate(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return "";
  return `${MON[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date(now).getFullYear() ? ", " + d.getFullYear() : ""}`;
}
/** "in 3 days", "yesterday". @param {any} v @param {number} [now] */
export function relDate(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return "";
  const t = new Date(now); t.setHours(0, 0, 0, 0);
  const n = Math.round((d.getTime() - t.getTime()) / 86400_000);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  const a = Math.abs(n), unit = a >= 60 ? [Math.round(a / 30), "months"] : [a, "days"];
  return n > 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}
/** "YYYY-MM-DD" for a date input. @param {any} v */
export function isoDay(v) {
  const d = toDate(v);
  if (!d) return "";
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** "10:30" for a datetime value. @param {any} v */
export function fmtTime(v) {
  const d = toDate(v);
  if (!d) return "";
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** A date typed as "2026-10-28" (or "10/28/2026"), as the ISO day to save, or null when it is not a date. @param {string} s */
export function parseDay(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
  else return null;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? isoDay(dt) : null;
}
/** A Money value as "$4,800". A bare number is read in `currency`. @param {any} v @param {string} [currency] */
export function fmtMoney(v, currency = "USD") {
  const n = typeof v === "object" && v ? Number(v.amount) : Number(v);
  const cur = typeof v === "object" && v && v.currency ? String(v.currency) : currency;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n); }
  catch { return `${cur} ${n}`; }
}
/** The symbol of a currency ("$"), or "". @param {string} cur */
export function currencySymbol(cur) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).formatToParts(0).find((p) => p.type === "currency")?.value || ""; } catch { return ""; }
}
/** A number typed in a field: "" and non-numbers are null. @param {string} s */
export const parseNum = (s) => (String(s ?? "").trim() === "" || Number.isNaN(Number(String(s).replace(/,/g, ""))) ? null : Number(String(s).replace(/,/g, "")));

/**
 * The basic marks of rich text as runs: **bold**, *italic*, and line breaks. Nothing is ever parsed as markup.
 * @param {string} s @returns {{ text: string, bold?: boolean, italic?: boolean, br?: boolean }[]}
 */
export function marks(s) {
  /** @type {{ text: string, bold?: boolean, italic?: boolean, br?: boolean }[]} */
  const out = [];
  String(s ?? "").split("\n").forEach((line, li) => {
    if (li) out.push({ text: "\n", br: true });
    for (const part of line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/)) {
      if (!part) continue;
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ text: part.slice(2, -2), bold: true });
      else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) out.push({ text: part.slice(1, -1), italic: true });
      else out.push({ text: part });
    }
  });
  return out;
}

/** The phrase an assistant gets for a sealed field. @param {string} label */
export const sealedPhrase = (label) => `${label} on file, sealed`;
/** The masked text for a sealed value: the fixed mask, and the hint only when the field's seal allows it and the value carries one. @param {any} def @param {any} v */
export function maskText(def, v) {
  const hint = isRevealable(v) && def?.seal?.hint_allowed && typeof v.hint === "string" ? v.hint : "";
  return hint ? `${MASK.slice(0, 4)} ${hint}` : MASK;
}

/** The stages a person may move this stage field to: the one it is in and its neighbours, unless a rule narrows it (env.allowed). @param {any} def @param {any} cur @param {string[]} [allowed] */
export function allowedStages(def, cur, allowed) {
  const st = [...(def?.options || [])];
  if (allowed) return allowed;
  const at = st.indexOf(cur);
  return at < 0 ? st.slice(0, 1) : st.filter((_, i) => Math.abs(i - at) <= 1);
}

// ------------------------------------------------------------------------------------------------------------------------ filter and sort

/** A comparable string for any value: what a text filter reads. A sealed value reads as nothing. @param {any} v @returns {string} */
export function plain(v) {
  if (isEmpty(v)) return "";
  if (Array.isArray(v)) return v.map(plain).join(", ");
  if (typeof v === "object") {
    if (isSealedValue(v)) return "";
    if ("amount" in v) return String(v.amount);
    if ("urn" in v) return String(v.urn);
    if ("actor" in v) return String(v.actor?.id || "");
    if ("file" in v) return String(v.name || v.file || "");
    if ("line1" in v || "city" in v) return addrText(v);
    return str(v);
  }
  return String(v);
}
const lower = (/** @type {any} */ v) => plain(v).toLowerCase();
const numOf = (/** @type {any} */ v) => (isEmpty(v) ? null : typeof v === "object" ? Number(v.amount) : Number(v));

const containsOps = [{ id: "contains", label: "contains", operand: "text" }];
const textOps = [{ id: "contains", label: "contains", operand: "text" }, { id: "starts", label: "starts with", operand: "text" }];
const numOps = [{ id: "gte", label: "at least", operand: "number" }, { id: "lte", label: "at most", operand: "number" }, { id: "between", label: "between", operand: "two" }];
const isOps = [{ id: "is", label: "is", operand: "option" }, { id: "isnot", label: "is not", operand: "option" }];
const dateOps = [{ id: "before", label: "before", operand: "date" }, { id: "after", label: "after", operand: "date" }, { id: "between", label: "between", operand: "two" }];
const hasOps = (/** @type {string} */ w) => [{ id: "has", label: `has ${w}`, operand: "none" }, { id: "hasnot", label: `has no ${w}`, operand: "none" }];

const textTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => (op === "starts" ? lower(v).startsWith(String(a).toLowerCase()) : lower(v).includes(String(a).toLowerCase()));
const numTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => {
  const n = numOf(v);
  if (n === null) return false;
  return op === "gte" ? n >= Number(a) : op === "lte" ? n <= Number(a) : n >= Number(a?.[0]) && n <= Number(a?.[1]);
};
const isTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => (op === "isnot" ? plain(v) !== plain(a) : plain(v) === plain(a));
const hasTest = (/** @type {string} */ op, /** @type {any} */ _a, /** @type {any} */ v) => (op === "hasnot" || op === "unset" ? isEmpty(v) : !isEmpty(v));
const dateTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => {
  const t = toDate(v)?.getTime();
  if (t === undefined) return false;
  return op === "before" ? t < (toDate(a)?.getTime() ?? Infinity) : op === "after" ? t > (toDate(a)?.getTime() ?? -Infinity) : t >= (toDate(a?.[0])?.getTime() ?? -Infinity) && t <= (toDate(a?.[1])?.getTime() ?? Infinity);
};
const refTest = (/** @type {string} */ _op, /** @type {any} */ a, /** @type {any} */ v) => urnOf(v) === urnOf(a);
const refSort = (/** @type {any} */ v, /** @type {any} */ ctx) => (isEmpty(v) ? null : (ctx.links?.[urnOf(v)]?.title || urnOf(v)).toLowerCase());

/** @type {Record<string, { label: string, ops: { id: string, label: string, operand: string }[], test: (op: string, a: any, v: any, ctx?: any) => boolean, sort: (v: any, ctx?: any) => string | number | null }>} */
export const KIND_LOGIC = {
  text: { label: "Text", ops: textOps, test: textTest, sort: lower },
  url: { label: "Web address", ops: containsOps, test: textTest, sort: lower },
  rich_text: { label: "Rich text", ops: containsOps, test: textTest, sort: lower },
  number: { label: "Number", ops: numOps, test: numTest, sort: numOf },
  money: { label: "Money", ops: numOps, test: numTest, sort: numOf },
  boolean: { label: "Yes or no", ops: [{ id: "is", label: "is", operand: "option" }], test: (_op, a, v) => (v === true) === (a === true || a === "Yes"), sort: (v) => (v === null || v === undefined ? null : v ? 1 : 0) },
  date: { label: "Date", ops: dateOps, test: dateTest, sort: (v) => toDate(v)?.getTime() ?? null },
  datetime: { label: "Date and time", ops: dateOps.slice(0, 2), test: dateTest, sort: (v) => toDate(v)?.getTime() ?? null },
  choice: { label: "Choice", ops: isOps, test: isTest, sort: lower },
  multi_choice: { label: "Choices", ops: [{ id: "contains", label: "includes", operand: "option" }], test: (_op, a, v) => listOf(v).includes(String(a)), sort: lower },
  rating: { label: "Rating", ops: [{ id: "gte", label: "at least", operand: "number" }], test: (_op, a, v) => Number(v) >= Number(a), sort: numOf },
  link: { label: "Link", ops: [{ id: "is", label: "is", operand: "option" }], test: refTest, sort: refSort },
  ref: { label: "Reference", ops: [{ id: "is", label: "is", operand: "option" }], test: refTest, sort: refSort },
  actor: { label: "Person or assistant", ops: isOps, test: (_op, a, v) => actorIdOf(v) === actorIdOf(a), sort: (v, ctx) => (isEmpty(v) ? null : (((ctx?.actors || []).find((/** @type {any} */ x) => x.id === actorIdOf(v))?.name) || actorIdOf(v)).toLowerCase()) },
  file: { label: "File", ops: hasOps("a file"), test: hasTest, sort: lower },
  address: { label: "Address", ops: containsOps, test: textTest, sort: lower },
  phones: { label: "Phone", ops: containsOps, test: textTest, sort: lower },
  emails: { label: "Email", ops: containsOps, test: textTest, sort: lower },
  urls: { label: "Web address", ops: containsOps, test: textTest, sort: lower },
  stage: { label: "Stage", ops: isOps, test: isTest, sort: (v, ctx) => { const i = ctx?.def ? [...(ctx.def.options || [])].indexOf(v) : -1; return i < 0 ? null : i; } },
  // The sort key of a sealed field never carries the value: set or not set, nothing else.
  sealed: { label: "Sealed", ops: [{ id: "set", label: "is set", operand: "none" }, { id: "unset", label: "is not set", operand: "none" }], test: hasTest, sort: (v) => (isEmpty(v) ? 0 : 1) },
};

const logicOf = (/** @type {string} */ kind) => KIND_LOGIC[normalizeKind(kind)] || KIND_LOGIC.text;
/** @param {string} kind */ export const filterOps = (kind) => logicOf(kind).ops;
/** @param {string} kind @param {string} op @param {any} operand @param {any} value @param {any} [ctx] */ export const matches = (kind, op, operand, value, ctx = {}) => logicOf(kind).test(op, operand, value, ctx);
/** @param {string} kind @param {any} value @param {any} [ctx] */ export const sortKey = (kind, value, ctx = {}) => logicOf(kind).sort(value, ctx);
/** @param {string} kind */ export const kindLabel = (kind) => logicOf(kind).label;

/** Sort rows by one field: empties last, ties keep their order. @template T @param {T[]} rows @param {(r: T) => any} valueOf @param {string} kind @param {any} ctx @param {boolean} [desc] */
export function sortRows(rows, valueOf, kind, ctx, desc = false) {
  const keyed = rows.map((r, i) => ({ r, i, k: sortKey(kind, valueOf(r), ctx) }));
  keyed.sort((a, b) => {
    if (a.k === null && b.k === null) return a.i - b.i;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k));
    return (desc ? -c : c) || a.i - b.i;
  });
  return keyed.map((x) => x.r);
}

/** One sample value per kind, for the Add a field panel's two previews. @param {any} f the draft definition @param {{ actors?: any[], links?: Record<string, any>, now?: number }} env */
export function sampleFor(f, env = {}) {
  const k = normalizeKind(f.kind);
  const samples = {
    text: "Sample text", number: 42, money: { amount: 1250, currency: "USD" }, date: isoDay(env.now ?? Date.now()), choice: (f.options || [])[0], stage: (f.options || [])[0],
    actor: (env.actors || [])[0] ? { actor: { kind: "person", id: env.actors[0].id } } : null, link: Object.keys(env.links || {})[0] ? { urn: Object.keys(env.links || {})[0] } : null,
    file: { file: "local:Notes.pdf", name: "Notes.pdf", bytes: 20480 }, address: { line1: "18 Larkin St", city: "San Francisco", region: "CA", postal: "94109" },
    phones: ["+1 415 555 0142"], emails: ["name@example.com"], rich_text: "A short note with **emphasis**.", rating: 4,
    sealed: { sealed: "free", ref: "preview", present: true, valid_format: true, set_at: 0 },
    boolean: true, datetime: new Date(env.now ?? Date.now()).toISOString(), multi_choice: (f.options || []).slice(0, 1), urls: ["https://example.com"], ref: null,
  };
  return /** @type {any} */ (samples)[k] ?? null;
}
