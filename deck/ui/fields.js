// @ts-check
// deck/ui/fields: the field renderers (ui-primitives.md section 4). One component per FieldKind of the kernel (kernel/contracts/fields.d.ts, FIELD_KINDS), each with a
// view, an edit and a compact form, plus filter ops and a sort key. No screen draws a field any other way: list, board, calendar, dashboard, record page, the Add a
// field panel and the lab all go through renderField().
//
//   renderField(props, env) -> { el, get() }
//     props = FieldRendererProps, exactly: { kind, definition, value, mode: "view"|"edit"|"compact", read_only, error?, source?, onChange?, reveal?, onFocus?, onBlur? }
//     env   = what the kernel's props leave out and a screen knows: { actors, links, now, open, timers, allowed, space }   (UI-side; see below)
//     get() is the value to save (FieldValue); for a sealed field it is undefined until the person types, so a save leaves the held value alone.
//   display(kind, value, ctx) / edit(kind, value, ctx)   the same two calls for a screen that has a FieldDefinition and a value, not a props object
//   filterOps(kind)           -> [{ id, label, operand }]   matches(kind, op, operand, value, ctx) -> boolean
//   sortKey(kind, value, ctx) -> string | number | null     null sorts last
//
// Values are the kernel's FieldValue: Money { amount, currency }, Address { line1 ... country }, { urn } for a ref or a link, { actor } for an actor, { file, name, bytes }
// for a file, string[] for phones, emails, urls and multi_choice, a date as "YYYY-MM-DD", a datetime as an ISO time. A sealed field's value is a SealedRefValue
// ({ sealed, ref, present, valid_format, set_at, hint? }) for a person, or a SealedPlaceholder (no ref) wherever a model reads: the renderer never receives a secret,
// and never asks for one except through props.reveal(purpose), which the screen binds to the person's fresh presence (ui/presence.js).
//
// What the kernel's props leave out, so `env` carries it: a ref's target title and an actor's display name (the studs have no directory), the clock for "in 3 days",
// the clock the 30 seconds of a revealed value run on (a test injects its own), the stage menu a rule narrows, and the Space a picked actor belongs to.
//
// Sealed: view mode shows a fixed mask (the hint only when definition.seal is set and the value carries one) and a Reveal button; Reveal calls props.reveal(purpose),
// shows the value for 30 seconds, then masks it again. A SealedPlaceholder renders "<Label> on file, sealed" and has no Reveal.
import { h, add, put } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { avatar, agentAvatar } from "../js/avatars.js";
import { FIELD_KINDS } from "../../kernel/contracts/index.js";
import { REVEAL_MS } from "./kernel-view.js";
import { chip, field as inputField, button } from "./components/index.js";

/** @typedef {import("./contracts.js").FieldDefinition} FieldDefinition */
/** @typedef {import("./contracts.js").FieldKind} FieldKind */
/** @typedef {import("./contracts.js").FieldValue} FieldValue */
/** @typedef {import("./contracts.js").FieldRendererProps} FieldRendererProps */
/** @typedef {import("./contracts.js").Who} Who */
/** @typedef {import("./contracts.js").Money} Money */
/** @typedef {import("./contracts.js").Address} Address */
/** @typedef {{ actors?: Who[], links?: Record<string, { title: string, type?: string }>, now?: number, open?: (urn: string) => void, space?: string, allowed?: string[],
 *   timers?: { set: (fn: () => void, ms: number) => any, clear: (id: any) => void } }} Env */
/** What a screen hands display() and edit(): the definition, the env, and the hooks the kernel's props name. @typedef {Env & { def?: FieldDefinition, onchange?: (v: any) => void, reveal?: (purpose: string) => Promise<string>, error?: string, source?: FieldRendererProps["source"], read_only?: boolean }} Ctx */

export { REVEAL_MS };
/** What a person sees where a sealed value is: always the same, so the length of the value is not given away. */
export const MASK = "••••••••";
/** The purpose a Reveal passes to the kernel (seal.reveal records it with the person's proof). */
export const REVEAL_PURPOSE = "Show it on my screen";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
    if ("line1" in v || "city" in v || "region" in v || "postal" in v || "country" in v || "line2" in v) return !Object.values(v).some(x => !!x);
  }
  return false;
}
const emptyHint = () => h("span", { class: "uv-empty" }, "Empty");
/** @param {any} v */
const str = v => (typeof v === "object" && v ? String(v.name ?? v.title ?? "") : String(v ?? ""));
/** The kernel's Address as one line: "18 Larkin St, San Francisco, CA 94109". @param {any} a */
export function addrText(a) {
  if (!a || typeof a !== "object") return String(a ?? "");
  const regionPostal = [a.region, a.postal].filter(Boolean).join(" ");
  return [a.line1, a.line2, a.city, regionPostal, a.country].filter(Boolean).join(", ");
}
/** The values of a multi-value field as an array. @param {any} v @returns {string[]} */
const listOf = v => (Array.isArray(v) ? v.map(String) : isEmpty(v) ? [] : [String(v)]);
/** The target urn of a ref or a link value. @param {any} v */
const urnOf = v => (v && typeof v === "object" ? String(v.urn || "") : String(v || ""));
/** @param {any} v */
const actorIdOf = v => (v && typeof v === "object" ? String(v.actor?.id || v.id || "") : String(v || ""));
/** @param {Env} env @param {string} id */
const whoOf = (env, id) => (env.actors || []).find(a => a.id === id);
const stagesOf = (/** @type {FieldDefinition} */ d) => [...(d.options || [])];

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
/** "YYYY-MM-DDTHH:MM" for a datetime-local input. @param {any} v */
const isoLocal = v => { const d = toDate(v); if (!d) return ""; const p = (/** @type {number} */ n) => String(n).padStart(2, "0"); return `${isoDay(d)}T${p(d.getHours())}:${p(d.getMinutes())}`; };
/** A Money value as "$4,800". A bare number is read in `currency`. @param {any} v @param {string} [currency] */
export function fmtMoney(v, currency = "USD") {
  const n = typeof v === "object" && v ? Number(v.amount) : Number(v);
  const cur = typeof v === "object" && v && v.currency ? String(v.currency) : currency;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n); }
  catch { return `${cur} ${n}`; }
}
const currencySymbol = (/** @type {string} */ cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).formatToParts(0).find(p => p.type === "currency")?.value || ""; } catch { return ""; } };

/** The basic marks of rich text, as elements: **bold**, *italic*, and line breaks. Nothing is ever parsed as markup. @param {string} s */
function marks(s) {
  const out = [];
  s.split("\n").forEach((line, li) => {
    if (li) out.push(h("br"));
    for (const part of line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/)) {
      if (!part) continue;
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push(h("b", null, part.slice(2, -2)));
      else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) out.push(h("i", null, part.slice(1, -1)));
      else out.push(part);
    }
  });
  return out;
}

/** @param {Who|undefined} a @param {string} id @param {number} size */
function actorAvatar(a, id, size) {
  return !a || a.family === "person" ? avatar("person", a?.seed || id, { size }) : agentAvatar(id, { size });
}

/** A sealed value, whatever the field's kind: an object with a `sealed` string. @param {any} v */
export const isSealedValue = v => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.sealed === "string";

// ---------------------------------------------------------------------------------------------------------------------------------- sealed

/** @param {FieldRendererProps} props @param {Env} env */
function sealedView(props, env) {
  const def = props.definition, v = /** @type {any} */ (props.value);
  if (isEmpty(v)) return emptyHint();
  const isRef = typeof v === "object" && typeof v.ref === "string";
  // A placeholder (no ref) is what a model reads: the phrase, and nothing to reveal.
  if (typeof v === "object" && !isRef) return chip(`${def.label} on file, sealed`, { tone: "sealed", icon: "lock" });
  const hint = isRef && def.seal && typeof v.hint === "string" ? v.hint : "";
  const masked = hint ? `${MASK.slice(0, 4)} ${hint}` : MASK;
  const timers = env.timers || { set: (/** @type {() => void} */ f, /** @type {number} */ ms) => setTimeout(f, ms), clear: (/** @type {any} */ t) => clearTimeout(t) };
  const root = h("span", { class: "uv-sealed" });
  let timer = null, shown = /** @type {string|null} */ (null), busy = false, failed = "";
  const mask = () => { if (timer) timers.clear(timer); timer = null; shown = null; draw(); };
  const reveal = async () => {
    if (busy || !props.reveal) return;
    busy = true; failed = "";
    try {
      const got = await props.reveal(REVEAL_PURPOSE);
      shown = typeof got === "string" ? got : null;
      if (shown === null) return;
      if (timer) timers.clear(timer);
      timer = timers.set(mask, REVEAL_MS);
    } catch (e) { if (/** @type {any} */ (e)?.code !== "cancelled") failed = String(/** @type {any} */ (e)?.message || "Could not reveal it."); }
    finally { busy = false; draw(); }
  };
  const canReveal = isRef && !!props.reveal && props.mode !== "compact";
  function draw() {
    put(root, shown === null
      ? [h("span", { class: "uv-mask", "aria-label": `${def.label}, sealed` }, masked), canReveal ? button({ label: "Reveal", kind: "secondary", size: "sm", icon: "key", onclick: reveal }) : null,
        failed ? h("span", { class: "uv-hint", role: "status" }, failed) : null]
      : [h("span", { class: "uv-mask uv-shown" }, shown), chip("Shown for 30 s", { tone: "ok" }), button({ label: "Hide", kind: "ghost", size: "sm", onclick: mask })]);
  }
  draw();
  return root;
}

// -------------------------------------------------------------------------------------------------------------------------- the components

/** @typedef {{ el: Node, get: () => any }} Rendered */
/** @typedef {(props: FieldRendererProps, env: Env) => Node} View */
/** @typedef {(props: FieldRendererProps, env: Env, emit: (v: any) => void) => Rendered} Editor */
/** @type {Record<string, { label: string, view: View, edit: Editor, ops: { id: string, label: string, operand: string }[], test: (op: string, a: any, v: any, env: Env, def?: FieldDefinition) => boolean, sort: (v: any, env: Env, def?: FieldDefinition) => string|number|null }>} */
export const registry = {};

const lower = (/** @type {any} */ v) => plain(v).toLowerCase();
/** A comparable string for any value: what a text filter reads. @param {any} v @returns {string} */
function plain(v) {
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
const containsOps = [{ id: "contains", label: "contains", operand: "text" }];
const textOps = [{ id: "contains", label: "contains", operand: "text" }, { id: "starts", label: "starts with", operand: "text" }];
const textTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => op === "starts" ? lower(v).startsWith(String(a).toLowerCase()) : lower(v).includes(String(a).toLowerCase());
const numOps = [{ id: "gte", label: "at least", operand: "number" }, { id: "lte", label: "at most", operand: "number" }, { id: "between", label: "between", operand: "two" }];
/** The number inside a number, a money or a rating. @param {any} v */
const numOf = v => (isEmpty(v) ? null : typeof v === "object" ? Number(v.amount) : Number(v));
const numTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => {
  const n = numOf(v); if (n === null) return false;
  return op === "gte" ? n >= Number(a) : op === "lte" ? n <= Number(a) : n >= Number(a?.[0]) && n <= Number(a?.[1]);
};
const isOps = [{ id: "is", label: "is", operand: "option" }, { id: "isnot", label: "is not", operand: "option" }];
const isTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => (op === "isnot" ? plain(v) !== plain(a) : plain(v) === plain(a));
const hasOps = [{ id: "has", label: "has a value", operand: "none" }, { id: "hasnot", label: "has no value", operand: "none" }];
const hasTest = (/** @type {string} */ op, /** @type {any} */ _a, /** @type {any} */ v) => (op === "hasnot" ? isEmpty(v) : !isEmpty(v));

/** A one-line input: text, number, date, email, phone, url. @param {string} inputKind @param {(s: string) => any} out @param {(v: any) => string} [show] */
function lineEdit(inputKind, out, show = v => String(v ?? "")) {
  return (/** @type {FieldRendererProps} */ props, /** @type {Env} */ _env, /** @type {(v: any) => void} */ emit) => {
    const f = inputField({ kind: inputKind, value: show(props.value), onchange: () => emit(get()) });
    const get = () => out(/** @type {any} */ (f).input.value);
    return { el: f, get };
  };
}
const num = (/** @type {string} */ s) => (s === "" || Number.isNaN(Number(s)) ? null : Number(s));
const keep = (/** @type {string} */ s) => s;

/** A select over strings. @param {string[]} options @param {string} current @param {(v: string) => void} onchange @param {boolean} [blank] */
function selectOf(options, current, onchange, blank = true) {
  const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ui-input uv-select" },
    blank ? h("option", { value: "" }, "None") : null,
    options.map(o => h("option", { value: o, selected: o === current }, o))));
  sel.addEventListener("change", () => onchange(sel.value));
  if (current) sel.value = current;
  return sel;
}

registry.text = { label: "Text", view: v => isEmpty(v.value) ? emptyHint() : h("span", { class: "uv-text" }, str(v.value)), edit: lineEdit("text", keep, v => String(v ?? "")),
  ops: textOps, test: textTest, sort: lower };
registry.rich_text = {
  label: "Rich text",
  view: p => isEmpty(p.value) ? emptyHint() : h("span", { class: `uv-rich${p.mode === "compact" ? " uv-compact" : ""}` }, marks(str(p.value))),
  edit: (p, _e, emit) => { const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "ui-input uv-textarea", rows: "3" })); ta.value = str(p.value); ta.addEventListener("change", () => emit(ta.value)); return { el: ta, get: () => ta.value }; },
  ops: containsOps, test: textTest, sort: lower,
};
registry.number = { label: "Number", view: p => isEmpty(p.value) ? emptyHint() : h("span", { class: "uv-num" }, String(p.value)), edit: lineEdit("number", num), ops: numOps, test: numTest, sort: v => numOf(v) };
registry.money = {
  label: "Money",
  view: p => isEmpty(p.value) ? emptyHint() : h("span", { class: "uv-num" }, fmtMoney(p.value)),
  edit: (p, _e, emit) => {
    const cur = /** @type {any} */ (p.value)?.currency || "USD";
    const f = inputField({ kind: "number", value: numOf(p.value) ?? "", onchange: () => emit(get()) });
    const get = () => { const n = num(/** @type {any} */ (f).input.value); return n === null ? null : /** @type {Money} */ ({ amount: n, currency: cur }); };
    return { el: h("span", { class: "uv-money-edit" }, h("span", { class: "uv-cur" }, currencySymbol(cur)), f), get };
  },
  ops: numOps, test: numTest, sort: v => numOf(v),
};
registry.boolean = {
  label: "Yes or no",
  view: p => (p.value === null || p.value === undefined ? emptyHint() : chip(p.value ? "Yes" : "No", { tone: p.value ? "ok" : "plain" })),
  edit: (p, _e, emit) => {
    let on = p.value === true;
    const b = h("button", { type: "button", class: "ui-switch", role: "switch", "aria-checked": String(on), "aria-label": p.definition.label,
      onclick: () => { on = !on; b.setAttribute("aria-checked", String(on)); emit(on); } });
    return { el: b, get: () => on };
  },
  ops: [{ id: "is", label: "is", operand: "option" }], test: (_op, a, v) => (v === true) === (a === true || a === "Yes"), sort: v => (v === null || v === undefined ? null : v ? 1 : 0),
};
registry.date = {
  label: "Date",
  view: (p, env) => { const d = fmtDate(p.value, env.now); return d ? h("span", { class: "uv-date", title: relDate(p.value, env.now) }, d) : emptyHint(); },
  edit: lineEdit("date", keep, isoDay),
  ops: [{ id: "before", label: "before", operand: "date" }, { id: "after", label: "after", operand: "date" }, { id: "between", label: "between", operand: "two" }],
  test: (op, a, v) => { const t = toDate(v)?.getTime(); if (t === undefined) return false;
    return op === "before" ? t < (toDate(a)?.getTime() ?? Infinity) : op === "after" ? t > (toDate(a)?.getTime() ?? -Infinity) : t >= (toDate(a?.[0])?.getTime() ?? -Infinity) && t <= (toDate(a?.[1])?.getTime() ?? Infinity); },
  sort: v => toDate(v)?.getTime() ?? null,
};
registry.datetime = {
  label: "Date and time",
  view: (p, env) => {
    const d = toDate(p.value);
    if (!d) return emptyHint();
    const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
    return h("span", { class: "uv-date", title: relDate(p.value, env.now) }, `${fmtDate(p.value, env.now)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`);
  },
  edit: (p, _e, emit) => {
    const f = inputField({ kind: "text", value: isoLocal(p.value), onchange: () => emit(get()) });
    /** @type {any} */ (f).input.type = "datetime-local";
    const get = () => { const d = toDate(/** @type {any} */ (f).input.value); return d ? d.toISOString() : null; };
    return { el: f, get };
  },
  ops: [{ id: "before", label: "before", operand: "date" }, { id: "after", label: "after", operand: "date" }],
  test: (op, a, v) => { const t = toDate(v)?.getTime(); if (t === undefined) return false; return op === "before" ? t < (toDate(a)?.getTime() ?? Infinity) : t > (toDate(a)?.getTime() ?? -Infinity); },
  sort: v => toDate(v)?.getTime() ?? null,
};
registry.choice = {
  label: "Choice",
  view: p => isEmpty(p.value) ? emptyHint() : chip(str(p.value), { tone: "plain" }),
  edit: (p, _e, emit) => { const sel = selectOf(p.definition.options || [], /** @type {any} */ (p.value) ?? "", () => emit(sel.value || null)); return { el: sel, get: () => sel.value || null }; },
  ops: isOps, test: isTest, sort: lower,
};
registry.multi_choice = {
  label: "Choices",
  view: p => isEmpty(p.value) ? emptyHint() : h("span", { class: "uv-multi" }, listOf(p.value).map(x => chip(x, { tone: "plain" }))),
  edit: (p, _e, emit) => {
    const on = new Set(listOf(p.value));
    const boxes = (p.definition.options || []).map(o => h("button", { type: "button", class: "uv-fchip", "aria-pressed": String(on.has(o)),
      onclick: (/** @type {any} */ e) => { if (on.has(o)) on.delete(o); else on.add(o); e.currentTarget.setAttribute("aria-pressed", String(on.has(o))); emit([...on]); } }, o));
    return { el: h("span", { class: "uv-chips", role: "group", "aria-label": p.definition.label }, boxes), get: () => [...on] };
  },
  ops: [{ id: "contains", label: "includes", operand: "option" }], test: (_op, a, v) => listOf(v).includes(String(a)), sort: lower,
};
registry.rating = {
  label: "Rating",
  view: p => { const n = Math.max(0, Math.min(5, Math.round(Number(p.value)))); return !n ? emptyHint() : h("span", { class: "uv-rating", role: "img", "aria-label": `${n} of 5` }, [1, 2, 3, 4, 5].map(i => h("span", { class: i <= n ? "on" : "off" }, "★"))); },
  edit: (p, _e, emit) => {
    let n = Number(p.value) || 0;
    const root = h("span", { class: "uv-rating uv-rating-edit", role: "group", "aria-label": "Rating" });
    const draw = () => put(root, [1, 2, 3, 4, 5].map(i => h("button", { type: "button", class: i <= n ? "on" : "off", "aria-label": `${i} of 5`, "aria-pressed": String(i <= n), onclick: () => { n = n === i ? 0 : i; draw(); emit(n || null); } }, "★")));
    draw();
    return { el: root, get: () => n || null };
  },
  ops: [{ id: "gte", label: "at least", operand: "number" }], test: (_op, a, v) => Number(v) >= Number(a), sort: v => numOf(v),
};

/** A link or a reference to another record: { urn }. */
const refKind = {
  view: (/** @type {FieldRendererProps} */ p, /** @type {Env} */ env) => {
    if (isEmpty(p.value)) return emptyHint();
    const urn = urnOf(p.value), t = env.links?.[urn];
    const open = (/** @type {Event} */ e) => { if (env.open) { e.preventDefault(); env.open(urn); } };
    return h("a", { class: "ui-chip ui-chip-accent uv-link", href: `/u/record/${encodeURIComponent(urn)}`, onclick: open, title: t?.type && t.type !== p.definition.to ? t.type : null }, t ? t.title : urn.split("/").pop() || urn);
  },
  edit: (/** @type {FieldRendererProps} */ p, /** @type {Env} */ env, /** @type {(v: any) => void} */ emit) => {
    const cur = urnOf(p.value), to = p.definition.to;
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ui-input uv-select" }, h("option", { value: "" }, "None")));
    const known = Object.entries(env.links || {}).filter(([, t]) => !to || !t.type || t.type === to).map(([urn, t]) => ({ urn, title: t.title }));
    if (cur && !known.some(k => k.urn === cur)) known.push({ urn: cur, title: env.links?.[cur]?.title || cur.split("/").pop() || cur });
    put(sel, h("option", { value: "" }, "None"), known.map(r => h("option", { value: r.urn, selected: r.urn === cur }, r.title)));
    if (cur) sel.value = cur;
    const get = () => (sel.value ? { urn: sel.value } : null);
    sel.addEventListener("change", () => emit(get()));
    return { el: sel, get };
  },
  ops: [{ id: "is", label: "is", operand: "option" }], test: (/** @type {string} */ _op, /** @type {any} */ a, /** @type {any} */ v) => urnOf(v) === urnOf(a),
  sort: (/** @type {any} */ v, /** @type {Env} */ env) => (isEmpty(v) ? null : (env.links?.[urnOf(v)]?.title || urnOf(v)).toLowerCase()),
};
registry.link = { label: "Link", ...refKind };
registry.ref = { label: "Reference", ...refKind };

registry.actor = {
  label: "Person or assistant",
  view: (p, env) => {
    if (isEmpty(p.value)) return emptyHint();
    const id = actorIdOf(p.value), a = whoOf(env, id);
    return h("span", { class: "uv-actor" }, actorAvatar(a, id, 22), h("span", null, a ? a.name : /** @type {any} */ (p.value)?.actor?.name || id));
  },
  edit: (p, env, emit) => {
    const actors = env.actors || [], cur = actorIdOf(p.value);
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ui-input uv-select" }, h("option", { value: "" }, "None"),
      actors.map(a => h("option", { value: a.id, selected: a.id === cur }, a.name + (a.family === "person" ? "" : a.family === "service" ? " (service)" : " (assistant)")))));
    if (cur) sel.value = cur;
    const kernelKind = (/** @type {Who} */ a) => (a.family === "person" ? "person" : a.family === "service" ? "service" : "agent");
    const space = env.space || /** @type {any} */ (p.value)?.actor?.space || "";
    const get = () => { const a = actors.find(x => x.id === sel.value); return a ? { actor: { kind: kernelKind(a), id: a.id, space, ...(a.family === "person" ? { name: undefined } : {}) } } : null; };
    sel.addEventListener("change", () => emit(get()));
    return { el: sel, get };
  },
  ops: isOps, test: (_op, a, v) => actorIdOf(v) === actorIdOf(a), sort: (v, env) => (isEmpty(v) ? null : (whoOf(env, actorIdOf(v))?.name || actorIdOf(v)).toLowerCase()),
};
registry.file = {
  label: "File",
  view: p => { const f = /** @type {any} */ (p.value); return isEmpty(f) ? emptyHint() : h("span", { class: "ui-chip ui-chip-plain uv-file", title: f.bytes ? `${f.bytes} bytes` : null }, icon("file", 14), String(f.name || f.file)); },
  edit: (p, _e, emit) => {
    /** @type {any} */
    let cur = isEmpty(p.value) ? null : p.value;
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", class: "uv-file-in", hidden: true }));
    const label = h("span", { class: "uv-file-n" }, cur?.name || "No file");
    input.addEventListener("change", () => { const f = input.files?.[0]; if (f) { cur = { file: `local:${f.name}`, name: f.name, bytes: f.size }; put(label, f.name); emit(cur); } });
    return { el: h("span", { class: "uv-file-edit" }, button({ label: "Attach a file", kind: "secondary", size: "sm", icon: "file", onclick: () => input.click() }), label, input), get: () => cur };
  },
  ops: [{ id: "has", label: "has a file", operand: "none" }, { id: "hasnot", label: "has no file", operand: "none" }], test: (op, _a, v) => (op === "hasnot" ? isEmpty(v) : !isEmpty(v)), sort: lower,
};
registry.address = {
  label: "Address",
  view: p => isEmpty(p.value) ? emptyHint() : h("span", { class: "uv-text" }, addrText(p.value)),
  edit: (p, _e, emit) => {
    const a = /** @type {any} */ (p.value && typeof p.value === "object" ? p.value : {});
    const parts = /** @type {[keyof Address, string][]} */ ([["line1", "Street"], ["line2", "Apartment or suite"], ["city", "City"], ["region", "State or region"], ["postal", "Postal code"], ["country", "Country"]]);
    const inputs = parts.map(([k, label]) => /** @type {[string, any]} */ ([k, inputField({ kind: "text", value: a[k] ?? "", label, onchange: () => emit(get()) })]));
    const get = () => { const out = /** @type {Record<string, string>} */ ({}); for (const [k, f] of inputs) { const v = f.input.value.trim(); if (v) out[k] = v; } return Object.keys(out).length ? /** @type {Address} */ (out) : null; };
    return { el: h("span", { class: "uv-address-edit" }, inputs.map(([, f]) => f)), get };
  },
  ops: containsOps, test: textTest, sort: lower,
};

/** phones, emails, urls: a list of strings, one input each. @param {string} inputKind @param {string} word */
function listKind(inputKind, word) {
  return {
    view: (/** @type {FieldRendererProps} */ p, /** @type {Env} */ _env) => isEmpty(p.value) ? emptyHint() : h("span", { class: `uv-${word}` }, listOf(p.value).join(", ")),
    edit: (/** @type {FieldRendererProps} */ p, /** @type {Env} */ _env, /** @type {(v: any) => void} */ emit) => {
      const vals = listOf(p.value);
      const root = h("span", { class: "uv-list-edit" });
      const draw = () => put(root, vals.map((v, i) => inputField({ kind: inputKind, value: v, label: `${p.definition.label} ${i + 1}`, onchange: (/** @type {string} */ s) => { vals[i] = s.trim(); emit(get()); } })),
        button({ label: "Add another", kind: "ghost", size: "sm", icon: "plus", onclick: () => { vals.push(""); draw(); } }));
      if (!vals.length) vals.push("");
      draw();
      const get = () => vals.filter(Boolean);
      return { el: root, get };
    },
    ops: containsOps, test: textTest, sort: lower,
  };
}
registry.phones = { label: "Phone numbers", ...listKind("phone", "phone") };
registry.emails = { label: "Email addresses", ...listKind("email", "email") };
registry.urls = { label: "Web addresses", ...listKind("url", "url") };

registry.stage = {
  label: "Stage",
  view: p => {
    if (isEmpty(p.value)) return emptyHint();
    const st = stagesOf(p.definition), at = st.indexOf(/** @type {string} */ (p.value));
    return h("span", { class: "uv-stage", title: str(p.value) }, h("span", { class: "uv-stagebar", "aria-hidden": "true" }, st.map((_, j) => h("i", { class: j <= at ? "on" : "" }))), h("span", { class: "uv-stage-n" }, str(p.value)));
  },
  edit: (p, env, emit) => {
    const st = stagesOf(p.definition), cur = /** @type {string} */ (p.value ?? ""), at = st.indexOf(cur);
    // The menu offers the stage it is in and its neighbours; the gateway's rule for a move runs before the change (env.allowed replaces the default).
    const allowed = env.allowed || (at < 0 ? st.slice(0, 1) : st.filter((_, i) => Math.abs(i - at) <= 1));
    const sel = selectOf(allowed, cur || allowed[0] || "", () => emit(sel.value), false);
    return { el: sel, get: () => sel.value };
  },
  ops: isOps, test: isTest, sort: (v, _env, def) => { const i = def ? stagesOf(def).indexOf(v) : -1; return i < 0 ? null : i; },
};
registry.sealed = {
  label: "Sealed",
  view: sealedView,
  // Password style, and never prefilled: the value is not on this screen. get() is undefined until the person types, so saving leaves a held value alone. What they type
  // is not a record value: the screen hands it to seal.put (store.putSealed) and the record keeps only the reference.
  edit: (_p, _e, emit) => { const f = inputField({ kind: "password", value: "", placeholder: "Enter a new value", onchange: () => emit(get()) }); const get = () => /** @type {any} */ (f).input.value || undefined; return { el: f, get }; },
  ops: [{ id: "set", label: "is set", operand: "none" }, { id: "unset", label: "is not set", operand: "none" }], test: (op, _a, v) => (op === "unset" ? isEmpty(v) : !isEmpty(v)),
  // The sort key of a sealed field never carries the value: set or not set, nothing else.
  sort: v => (isEmpty(v) ? 0 : 1),
};

/** Every kind and its label, in the kernel's order. */
export const KINDS = /** @type {[FieldKind, string][]} */ (FIELD_KINDS.map(k => [k, registry[k].label]));

// ------------------------------------------------------------------------------------------------------------------------------ the one entry

/** @param {Node} el @param {FieldRendererProps["source"]} source */
function withSource(el, source) {
  if (!source || !(/** @type {any} */ (el)).setAttribute) return el;
  const bits = [source.actor ? `Set by ${source.actor}` : "", source.trust ? `${source.trust}` : "", source.at ? new Date(source.at).toISOString().slice(0, 16).replace("T", " ") : ""].filter(Boolean);
  const own = /** @type {any} */ (el).getAttribute?.("title");
  if (bits.length) /** @type {any} */ (el).setAttribute("title", [own, bits.join(" · ")].filter(Boolean).join(". "));
  return el;
}

/**
 * The one component for a field: pick the kind's renderer, then its view, edit or compact form. A sealed value is drawn by the sealed renderer whatever the kind of the field.
 * @param {FieldRendererProps} props @param {Env} [env] @returns {Rendered}
 */
export function renderField(props, env = {}) {
  const k = registry[props.kind] || registry.text;
  const sealedValue = isSealedValue(props.value);
  const editing = props.mode === "edit" && !props.read_only;
  /** @type {Rendered} */
  let out;
  if (editing) {
    const emit = (/** @type {any} */ v) => props.onChange?.(v);
    out = (sealedValue && props.kind !== "sealed" ? registry.sealed : k).edit(props, env, emit);
    const el = /** @type {any} */ (out.el);
    if (props.onFocus) el.addEventListener?.("focusin", () => props.onFocus?.());
    if (props.onBlur) el.addEventListener?.("focusout", () => props.onBlur?.());
  } else {
    const el = (sealedValue && props.kind !== "sealed" ? registry.sealed : k).view(props, env);
    out = { el, get: () => props.value };
  }
  if (props.source) withSource(out.el, props.source);
  if (props.error) {
    const wrap = h("span", { class: "uv-fw" }, out.el, h("span", { class: "ui-field-e", role: "alert" }, props.error));
    out = { el: wrap, get: out.get };
  }
  return out;
}

/** A definition for a call that names only a kind. @param {Ctx} ctx @param {FieldKind} kind @returns {FieldDefinition} */
const defOf = (ctx, kind) => ctx.def || { name: "field", label: "Field", kind };

/** @param {FieldKind} kind @param {any} value @param {Ctx} ctx @param {FieldRendererProps["mode"]} mode @returns {FieldRendererProps} */
const propsOf = (kind, value, ctx, mode) => ({ kind, definition: defOf(ctx, kind), value, mode, read_only: mode !== "edit" || !!ctx.read_only, error: ctx.error, source: ctx.source,
  onChange: ctx.onchange, reveal: ctx.reveal });

/**
 * The view of a field for a screen that has a value and its definition: `renderField` in view mode (or compact, with ctx.compact).
 * @param {FieldKind} kind @param {any} value @param {Ctx & { compact?: boolean }} [ctx] @returns {Node}
 */
export function display(kind, value, ctx = {}) { return renderField(propsOf(kind, value, ctx, ctx.compact ? "compact" : "view"), ctx).el; }

/**
 * The edit form of a field: `renderField` in edit mode. @param {FieldKind} kind @param {any} value @param {Ctx} [ctx] @returns {{ el: HTMLElement, get: () => any }}
 */
export function edit(kind, value, ctx = {}) { return /** @type {any} */ (renderField(propsOf(kind, value, ctx, "edit"), ctx)); }

/** @param {FieldKind} kind */
export const filterOps = kind => (registry[kind] || registry.text).ops;
/** @param {FieldKind} kind @param {string} op @param {any} operand @param {any} value @param {Ctx} [ctx] */
export const matches = (kind, op, operand, value, ctx = {}) => (registry[kind] || registry.text).test(op, operand, value, ctx, ctx.def);
/** @param {FieldKind} kind @param {any} value @param {Ctx} [ctx] */
export const sortKey = (kind, value, ctx = {}) => (registry[kind] || registry.text).sort(value, ctx, ctx.def);
/** @param {FieldKind} kind */
export const kindLabel = kind => (registry[kind] || registry.text).label;

/** Sort rows by one field: empties last, ties keep their order. @template T @param {T[]} rows @param {(r: T) => any} valueOf @param {FieldKind} kind @param {Ctx} ctx @param {boolean} [desc] */
export function sortRows(rows, valueOf, kind, ctx, desc = false) {
  const keyed = rows.map((r, i) => ({ r, i, k: sortKey(kind, valueOf(r), ctx) }));
  keyed.sort((a, b) => {
    if (a.k === null && b.k === null) return a.i - b.i;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k));
    return (desc ? -c : c) || a.i - b.i;
  });
  return keyed.map(x => x.r);
}

void add;
