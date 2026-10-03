// @ts-check
// deck/ui/fields: the field renderers (ui-primitives.md section 4). Fifteen kinds, each with ONE display renderer, ONE edit renderer, filter ops and a sort
// key. No screen draws a field any other way: list, board, calendar, dashboard, record page, the Add a field panel and the lab all call display() and edit().
//
//   display(kind, value, ctx) -> Node
//   edit(kind, value, ctx)    -> { el, get() }            get() returns the value to save (a sealed field's get() is undefined until the person types)
//   filterOps(kind)           -> [{ id, label, operand }]  matches(kind, op, operand, value, ctx) -> boolean
//   sortKey(kind, value, ctx) -> string | number | null    null sorts last
//
// ctx = { def: FieldDef, actors: Actor[], store?, who: "person"|"assistant", onchange?, reveal?, links?, now?, timers?, faceId?, open? }
//   links   id -> { title, type } for link fields (a screen reads it once from the store; display() never awaits)
//   reveal  (proof) -> { value } | string | Promise of either: the Reveal call for this one field on this one record (store.reveal bound by the screen)
//   faceId  () -> Promise<{ method } | null>: asks the person for Face ID; the default is a sheet with one button
//   timers  { set, clear }: the clock a sealed value's 30 seconds run on (a test injects its own)
//
// Sealed: the person sees a fixed mask (the last four only when def.showLast4 and the gateway sent them) and a Reveal button; Reveal asks for Face ID, passes the
// proof to ctx.reveal, shows the value for 30 seconds, then masks it again. An assistant never gets a value: the display draws "<Label> on file, sealed" and does
// not read the value at all, so there is nothing to leak. A def with sealed:true on any kind is treated the same way for an assistant.
import { h, add, put } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { avatar, agentAvatar } from "../js/avatars.js";
import { chip, field as inputField, openSheet, button } from "./components/index.js";

/** @typedef {import("./contracts.js").FieldDef} FieldDef */
/** @typedef {import("./contracts.js").FieldKind} FieldKind */
/** @typedef {{ def?: FieldDef, actors?: any[], store?: any, who?: "person"|"assistant", onchange?: (v: any) => void, reveal?: (proof: { method: string }) => any,
 *   links?: Record<string, { title: string, type?: string }>, now?: number, timers?: { set: (fn: () => void, ms: number) => any, clear: (id: any) => void },
 *   faceId?: () => Promise<{ method: string } | null>, open?: (id: string) => void, allowed?: string[] }} Ctx */

/** How long a revealed value stays on screen. */
export const REVEAL_MS = 30_000;
/** What a person sees where a sealed value is: always the same, so the length of the value is not given away. */
export const MASK = "••••••••";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {any} v */
export function isEmpty(v) {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
const emptyHint = () => h("span", { class: "uv-empty" }, "Empty");
/** @param {any} v */
const str = v => (typeof v === "object" && v ? String(v.name ?? v.title ?? "") : String(v ?? ""));
/** @param {Ctx} ctx @returns {FieldDef} */
const defOf = (ctx, kind = "text") => ctx.def || { key: "field", label: "Field", kind: /** @type {any} */ (kind) };
const stagesOf = (/** @type {FieldDef} */ d) => d.stages || d.options || [];

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
/** @param {any} v @param {FieldDef} d */
export function fmtMoney(v, d) {
  const n = Number(v);
  const cur = d.currency || "USD";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n); }
  catch { return `${cur} ${n}`; }
}
const currencySymbol = (/** @type {FieldDef} */ d) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: d.currency || "USD" }).formatToParts(0).find(p => p.type === "currency")?.value || ""; } catch { return ""; } };

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

/** Whoever the id names, from ctx.actors. @param {Ctx} ctx @param {string} id */
const actorOf = (ctx, id) => (ctx.actors || []).find(a => a.id === id);
/** @param {any} a @param {number} size */
function actorAvatar(a, size) {
  if (!a) return null;
  return a.kind === "person" ? avatar("person", a.seed || a.id, { size }) : agentAvatar(a.id, { size });
}

// ---------------------------------------------------------------------------------------------------------------------------------- sealed

/** The Face ID ask: a sheet with one button. Resolves with the proof, or null when the person closes it. @param {FieldDef} def @returns {Promise<{ method: string } | null>} */
function askFaceId(def) {
  return new Promise(resolve => {
    let done = false;
    const finish = (/** @type {any} */ v) => { if (!done) { done = true; resolve(v); } };
    openSheet({ title: `Reveal ${def.label}`, onClose: () => finish(null), build: (body, close, parts) => {
      add(body, h("p", { class: "uv-sheet-p" }, "Confirm with Face ID. It shows for 30 seconds, then hides again."));
      add(parts.actions, button({ label: "Use Face ID", kind: "primary", icon: "key", onclick: () => { finish({ method: "face_id" }); close(); } }),
        button({ label: "Cancel", kind: "ghost", onclick: () => close() }));
    } });
  });
}

/** @param {any} value @param {Ctx} ctx */
function displaySealed(value, ctx) {
  const def = defOf(ctx, "sealed");
  if (ctx.who === "assistant") {
    // Never read `value`: an assistant gets the phrase and nothing else.
    return isEmpty(value) ? emptyHint() : chip(`${def.label} on file, sealed`, { tone: "sealed", icon: "lock" });
  }
  if (isEmpty(value)) return emptyHint();
  const last4 = def.showLast4 ? (typeof value === "object" ? String(value.last4 || "") : String(value).slice(-4)) : "";
  const masked = last4 ? `${MASK.slice(0, 4)} ${last4}` : MASK;
  const timers = ctx.timers || { set: (/** @type {() => void} */ f, /** @type {number} */ ms) => setTimeout(f, ms), clear: (/** @type {any} */ t) => clearTimeout(t) };
  const root = h("span", { class: "uv-sealed" });
  let timer = null, shown = /** @type {string|null} */ (null), busy = false;
  const mask = () => { if (timer) timers.clear(timer); timer = null; shown = null; draw(); };
  const reveal = async () => {
    if (busy || !ctx.reveal) return;
    busy = true;
    try {
      const proof = await (ctx.faceId || (() => askFaceId(def)))();
      if (!proof) return;
      const got = await ctx.reveal(proof);
      shown = typeof got === "string" ? got : got && got.value !== undefined ? String(got.value) : null;
      if (shown === null) return;
      if (timer) timers.clear(timer);
      timer = timers.set(mask, REVEAL_MS);
    } finally { busy = false; draw(); }
  };
  function draw() {
    put(root, shown === null
      ? [h("span", { class: "uv-mask", "aria-label": `${def.label}, sealed` }, masked),
        ctx.reveal ? button({ label: "Reveal", kind: "secondary", size: "sm", icon: "key", onclick: reveal }) : null]
      : [h("span", { class: "uv-mask uv-shown" }, shown), chip("Shown for 30 s", { tone: "ok" }), button({ label: "Hide", kind: "ghost", size: "sm", onclick: mask })]);
  }
  draw();
  return root;
}

// -------------------------------------------------------------------------------------------------------------------------- the registry

/** @param {any} v @param {Ctx} ctx */
const text = (v, ctx) => isEmpty(v) ? emptyHint() : h("span", { class: "uv-text" }, str(v));

/** @type {Record<string, { label: string, display: (v: any, ctx: Ctx) => Node, edit: (v: any, ctx: Ctx) => { el: HTMLElement, get: () => any }, ops: { id: string, label: string, operand: string }[], test: (op: string, a: any, v: any, ctx: Ctx) => boolean, sort: (v: any, ctx: Ctx) => string|number|null }>} */
export const registry = {};

/** A one-line input kind: text, number, date, email, phone, address. @param {string} inputKind @param {(v: string) => any} [out] */
function lineEdit(inputKind, out = v => v) {
  return (/** @type {any} */ v, /** @type {Ctx} */ ctx) => {
    const f = inputField({ kind: inputKind, value: inputKind === "date" ? isoDay(v) : v ?? "", onchange: () => ctx.onchange?.(get()) });
    const get = () => out(/** @type {any} */ (f).input.value);
    return { el: f, get };
  };
}
const num = (/** @type {string} */ s) => (s === "" || Number.isNaN(Number(s)) ? null : Number(s));
const lower = (/** @type {any} */ v) => str(v).toLowerCase();
const containsOps = [{ id: "contains", label: "contains", operand: "text" }];
const textOps = [{ id: "contains", label: "contains", operand: "text" }, { id: "starts", label: "starts with", operand: "text" }];
const textTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => op === "starts" ? lower(v).startsWith(String(a).toLowerCase()) : lower(v).includes(String(a).toLowerCase());
const numOps = [{ id: "gte", label: "at least", operand: "number" }, { id: "lte", label: "at most", operand: "number" }, { id: "between", label: "between", operand: "two" }];
const numTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => {
  if (isEmpty(v)) return false; const n = Number(v);
  return op === "gte" ? n >= Number(a) : op === "lte" ? n <= Number(a) : n >= Number(a?.[0]) && n <= Number(a?.[1]);
};
const isOps = [{ id: "is", label: "is", operand: "option" }, { id: "isnot", label: "is not", operand: "option" }];
const isTest = (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ v) => (op === "isnot" ? v !== a : v === a);

registry.text = { label: "Text", display: text, edit: lineEdit("text"), ops: textOps, test: textTest, sort: lower };
registry.number = { label: "Number", display: (v) => isEmpty(v) ? emptyHint() : h("span", { class: "uv-num" }, String(v)), edit: lineEdit("number", num), ops: numOps, test: numTest, sort: v => (isEmpty(v) ? null : Number(v)) };
registry.money = {
  label: "Money",
  display: (v, ctx) => isEmpty(v) ? emptyHint() : h("span", { class: "uv-num" }, fmtMoney(v, defOf(ctx, "money"))),
  edit: (v, ctx) => { const f = inputField({ kind: "number", value: v ?? "", onchange: () => ctx.onchange?.(get()) }); const get = () => num(/** @type {any} */ (f).input.value);
    return { el: h("span", { class: "uv-money-edit" }, h("span", { class: "uv-cur" }, currencySymbol(defOf(ctx, "money"))), f), get }; },
  ops: numOps, test: numTest, sort: v => (isEmpty(v) ? null : Number(v)),
};
registry.date = {
  label: "Date",
  display: (v, ctx) => { const d = fmtDate(v, ctx.now); return d ? h("span", { class: "uv-date", title: relDate(v, ctx.now) }, d) : emptyHint(); },
  edit: lineEdit("date"),
  ops: [{ id: "before", label: "before", operand: "date" }, { id: "after", label: "after", operand: "date" }, { id: "between", label: "between", operand: "two" }],
  test: (op, a, v) => { const t = toDate(v)?.getTime(); if (t === undefined) return false;
    return op === "before" ? t < (toDate(a)?.getTime() ?? Infinity) : op === "after" ? t > (toDate(a)?.getTime() ?? -Infinity) : t >= (toDate(a?.[0])?.getTime() ?? -Infinity) && t <= (toDate(a?.[1])?.getTime() ?? Infinity); },
  sort: v => toDate(v)?.getTime() ?? null,
};

/** A select over strings. @param {string[]} options @param {string} current @param {(v: string) => void} onchange @param {boolean} [blank] */
function selectOf(options, current, onchange, blank = true) {
  const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ui-input uv-select" },
    blank ? h("option", { value: "" }, "None") : null,
    options.map(o => h("option", { value: o, selected: o === current }, o))));
  sel.addEventListener("change", () => onchange(sel.value));
  if (current) sel.value = current;
  return sel;
}
registry.choice = {
  label: "Choice",
  display: (v) => isEmpty(v) ? emptyHint() : chip(str(v), { tone: "plain" }),
  edit: (v, ctx) => { const sel = selectOf(defOf(ctx, "choice").options || [], v ?? "", () => ctx.onchange?.(sel.value || null)); return { el: sel, get: () => sel.value || null }; },
  ops: isOps, test: isTest, sort: lower,
};
registry.stage = {
  label: "Stage",
  display: (v, ctx) => {
    if (isEmpty(v)) return emptyHint();
    const st = stagesOf(defOf(ctx, "stage")), at = st.indexOf(v);
    return h("span", { class: "uv-stage", title: str(v) }, h("span", { class: "uv-stagebar", "aria-hidden": "true" }, st.map((_, j) => h("i", { class: j <= at ? "on" : "" }))), h("span", { class: "uv-stage-n" }, str(v)));
  },
  edit: (v, ctx) => {
    const st = stagesOf(defOf(ctx, "stage")), at = st.indexOf(v);
    // The menu offers the stage it is in and its neighbours; the gateway's rule for a move runs before the change (ctx.allowed replaces the default).
    const allowed = ctx.allowed || (at < 0 ? st.slice(0, 1) : st.filter((_, i) => Math.abs(i - at) <= 1));
    const sel = selectOf(allowed, v ?? allowed[0] ?? "", () => ctx.onchange?.(sel.value), false);
    return { el: sel, get: () => sel.value };
  },
  ops: isOps, test: isTest, sort: (v, ctx) => { const i = stagesOf(defOf(ctx, "stage")).indexOf(v); return i < 0 ? null : i; },
};
registry.actor = {
  label: "Person or assistant",
  display: (v, ctx) => { const a = actorOf(ctx, v); return !v ? emptyHint() : h("span", { class: "uv-actor" }, actorAvatar(a, 22), h("span", null, a ? a.name : String(v))); },
  edit: (v, ctx) => {
    const actors = ctx.actors || [];
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ui-input uv-select" }, h("option", { value: "" }, "None"),
      actors.map(a => h("option", { value: a.id, selected: a.id === v }, a.name + (a.kind === "person" ? "" : a.kind === "device" ? " (device)" : " (assistant)")))));
    sel.addEventListener("change", () => ctx.onchange?.(sel.value || null));
    if (v) sel.value = v;
    return { el: sel, get: () => sel.value || null };
  },
  ops: isOps, test: isTest, sort: (v, ctx) => (v ? (actorOf(ctx, v)?.name || String(v)).toLowerCase() : null),
};
registry.link = {
  label: "Link",
  display: (v, ctx) => {
    if (isEmpty(v)) return emptyHint();
    const t = ctx.links?.[v], def = defOf(ctx, "link");
    const open = (/** @type {Event} */ e) => { if (ctx.open) { e.preventDefault(); ctx.open(v); } };
    return h("a", { class: "ui-chip ui-chip-accent uv-link", href: `/u/record/${encodeURIComponent(v)}`, onclick: open, title: t?.type && t.type !== def.link ? t.type : null }, t ? t.title : String(v));
  },
  edit: (v, ctx) => {
    const def = defOf(ctx, "link");
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ui-input uv-select" }, h("option", { value: "" }, "None")));
    const fill = (/** @type {{ id: string, title: string }[]} */ rows) => { put(sel, h("option", { value: "" }, "None"), rows.map(r => h("option", { value: r.id, selected: r.id === v }, r.title))); if (v) sel.value = v; };
    const known = Object.entries(ctx.links || {}).filter(([, t]) => !def.link || !t.type || t.type === def.link).map(([id, t]) => ({ id, title: t.title }));
    if (known.length) fill(known);
    else if (ctx.store && def.link) Promise.resolve(ctx.store.list(def.link)).then((/** @type {any[]} */ rs) => fill(rs.map(r => ({ id: r.id, title: String(Object.values(r.values)[0] ?? r.id) })))).catch(() => {});
    else if (v) fill([{ id: v, title: String(v) }]);
    sel.addEventListener("change", () => ctx.onchange?.(sel.value || null));
    return { el: sel, get: () => sel.value || null };
  },
  ops: [{ id: "is", label: "is", operand: "option" }], test: (_op, a, v) => v === a, sort: (v, ctx) => (v ? (ctx.links?.[v]?.title || String(v)).toLowerCase() : null),
};
registry.file = {
  label: "File",
  display: (v) => isEmpty(v) ? emptyHint() : h("span", { class: "ui-chip ui-chip-plain uv-file" }, icon("file", 14), str(v)),
  edit: (v, ctx) => {
    let name = v ?? "";
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", class: "uv-file-in", hidden: true }));
    const label = h("span", { class: "uv-file-n" }, name || "No file");
    input.addEventListener("change", () => { name = input.files?.[0]?.name || name; put(label, name || "No file"); ctx.onchange?.(name); });
    return { el: h("span", { class: "uv-file-edit" }, button({ label: "Attach a file", kind: "secondary", size: "sm", icon: "file", onclick: () => input.click() }), label, input), get: () => name || null };
  },
  ops: [{ id: "has", label: "has a file", operand: "none" }, { id: "hasnot", label: "has no file", operand: "none" }], test: (op, _a, v) => (op === "hasnot" ? isEmpty(v) : !isEmpty(v)), sort: lower,
};
registry.address = { label: "Address", display: text, edit: lineEdit("text"), ops: containsOps, test: textTest, sort: lower };
registry.phone = { label: "Phone", display: (v) => isEmpty(v) ? emptyHint() : h("span", { class: "uv-phone" }, str(v)), edit: lineEdit("phone"), ops: containsOps, test: textTest, sort: lower };
registry.email = { label: "Email", display: (v) => isEmpty(v) ? emptyHint() : h("span", { class: "uv-email" }, str(v)), edit: lineEdit("email"), ops: containsOps, test: textTest, sort: lower };
registry.richText = {
  label: "Rich text",
  display: (v) => isEmpty(v) ? emptyHint() : h("span", { class: "uv-rich" }, marks(str(v))),
  edit: (v, ctx) => { const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "ui-input uv-textarea", rows: "3" })); ta.value = str(v); ta.addEventListener("change", () => ctx.onchange?.(ta.value)); return { el: ta, get: () => ta.value }; },
  ops: containsOps, test: textTest, sort: lower,
};
registry.rating = {
  label: "Rating",
  display: (v) => { const n = Math.max(0, Math.min(5, Math.round(Number(v)))); return !n ? emptyHint() : h("span", { class: "uv-rating", role: "img", "aria-label": `${n} of 5` }, [1, 2, 3, 4, 5].map(i => h("span", { class: i <= n ? "on" : "off" }, "★"))); },
  edit: (v, ctx) => {
    let n = Number(v) || 0;
    const root = h("span", { class: "uv-rating uv-rating-edit", role: "group", "aria-label": "Rating" });
    const draw = () => put(root, [1, 2, 3, 4, 5].map(i => h("button", { type: "button", class: i <= n ? "on" : "off", "aria-label": `${i} of 5`, "aria-pressed": String(i <= n), onclick: () => { n = n === i ? 0 : i; draw(); ctx.onchange?.(n || null); } }, "★")));
    draw();
    return { el: root, get: () => n || null };
  },
  ops: [{ id: "gte", label: "at least", operand: "number" }], test: (_op, a, v) => Number(v) >= Number(a), sort: v => (isEmpty(v) ? null : Number(v)),
};
registry.sealed = {
  label: "Sealed",
  display: displaySealed,
  // Password style, and never prefilled: the value is not on this screen. get() is undefined until the person types, so saving leaves a held value alone.
  edit: (_v, ctx) => { const f = inputField({ kind: "password", value: "", placeholder: "Enter a new value", onchange: () => ctx.onchange?.(get()) }); const get = () => /** @type {any} */ (f).input.value || undefined; return { el: f, get }; },
  ops: [{ id: "set", label: "is set", operand: "none" }, { id: "unset", label: "is not set", operand: "none" }], test: (op, _a, v) => (op === "unset" ? isEmpty(v) : !isEmpty(v)),
  // The sort key of a sealed field never carries the value: set or not set, nothing else.
  sort: v => (isEmpty(v) ? 0 : 1),
};

export const KINDS = /** @type {[FieldKind, string][]} */ (["text", "number", "money", "date", "choice", "stage", "actor", "link", "file", "address", "phone", "email", "richText", "rating", "sealed"]
  .map(k => [k, registry[k].label]));

/** A def sealed on a non-sealed kind (sealed from assistants on every record) is drawn like a sealed field for an assistant. */
const sealedFor = (/** @type {string} */ kind, /** @type {Ctx} */ ctx) => ctx.who === "assistant" && (kind === "sealed" || !!ctx.def?.sealed);

/**
 * The one display renderer for a kind.
 * @param {FieldKind} kind @param {any} value @param {Ctx} [ctx] @returns {Node}
 */
export function display(kind, value, ctx = {}) {
  const c = { who: "person", ...ctx };
  if (sealedFor(kind, c)) return displaySealed(value, { ...c, def: defOf(c, kind), who: "assistant" });
  // A store that sealed a value sends a marker in its place, whatever the kind (a sealed date of birth): the person sees the mask and Reveal.
  if (value && typeof value === "object" && value.sealed) return displaySealed(value, { ...c, def: defOf(c, kind) });
  const k = registry[kind] || registry.text;
  return k.display(value, c);
}

/**
 * The one edit renderer for a kind. An assistant is never offered one for a sealed field.
 * @param {FieldKind} kind @param {any} value @param {Ctx} [ctx] @returns {{ el: HTMLElement, get: () => any }}
 */
export function edit(kind, value, ctx = {}) {
  const c = { who: "person", ...ctx };
  return (registry[kind] || registry.text).edit(sealedFor(kind, c) ? undefined : value, c);
}

/** @param {FieldKind} kind */
export const filterOps = kind => (registry[kind] || registry.text).ops;
/** @param {FieldKind} kind @param {string} op @param {any} operand @param {any} value @param {Ctx} [ctx] */
export const matches = (kind, op, operand, value, ctx = {}) => (registry[kind] || registry.text).test(op, operand, value, ctx);
/** @param {FieldKind} kind @param {any} value @param {Ctx} [ctx] */
export const sortKey = (kind, value, ctx = {}) => (registry[kind] || registry.text).sort(value, ctx);
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
