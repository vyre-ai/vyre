// @ts-check
// deck/ui/components: the base components, built only from tokens (ui-primitives.md section 3). Every screen draws from these and from the field
// renderers (ui/fields.js); a feature adds definitions, never a component. This file is the whole public surface and its signatures are a contract:
// the signatures here are final. Extra options are optional and additive (switchEl disabled, field help, row tone, chip tone "space").
// Every function returns an element (menu returns a close function). Text is always a text node (h() never parses markup). Classes are `ui-*`,
// styled in css/ui.css from tokens alone: no colour, size or radius literal anywhere (a build check fails one).
//
//   button({ label, kind, icon, size, onclick, disabled, loading, title, type })      kind: primary | secondary | ghost | danger | hold
//   iconButton({ icon, label, onclick, size, kind })                                   always named: `label` is the aria-label and the tooltip
//   chip(content, { tone, icon, title })                                               tone: plain | accent | ok | warn | err | sealed
//   field({ kind, value, placeholder, label, onchange, oninput, name, disabled, error }) -> element with .input
//   switchEl({ on, label, onchange })
//   segmented({ options: [[value, label]], value, onchange, label })
//   tabs({ items: [[id, label]], current, onselect })
//   row({ lead, title, sub, end, onclick, href, selected, tone })
//   card({ title, actions, tone }, ...children)                                        tone: plain | ask
//   askCard({ lead, title, why, tags, actions, tone })                                 actions: [{ label, kind, onclick, disabled }]
//   banner({ tone, icon }, ...children)                                                tone: plain | warn
//   menu({ anchor, items })  -> close()                                                items: [{ label, onclick, danger }]
//   table({ columns, rows, onrow, empty })                                             columns: [{ key, label, render, align }]; becomes rows on a phone
//   stageSteps({ stages, current, onselect })                                          current: an index or a stage name
//   timelineItem({ actor, what, at, why })
//   emptyState({ title, body, action }) / errorState({ title, reason, retry })        the state kit (js/states.js)
//   avatar: js/avatars.js. sheet and toast: js/sheet.js openSheet, js/toast.js showToast, re-exported here.
import { h, add } from "../../js/dom.js";
import { icon as drawIcon } from "../../js/icons.js";
import { emptyState as kitEmpty, errorState as kitError } from "../../js/states.js";

export { openSheet } from "../../js/sheet.js";
export { showToast } from "../../js/toast.js";
export { skeleton, loading } from "../../js/states.js";
export { avatar, personAvatar, assistantAvatar, agentAvatar, teammateAvatar, projectAvatar, whoAvatar } from "../../js/avatars.js";

/** @param {string|undefined} name @param {number} [size] */
const ic = (name, size = 16) => (name ? drawIcon(/** @type {any} */ (name), size) : null);
const isKey = (/** @type {KeyboardEvent} */ e, ...names) => names.includes(e.key);

/** How long a hold button is held, in ms. The fill runs for the same time (--ui-hold in css/ui.css). */
export const HOLD_MS = 700;

/** @param {{ label?: any, kind?: string, icon?: string, size?: string, onclick?: (e: Event) => void, disabled?: boolean, loading?: boolean, title?: string, type?: string }} o */
export function button({ label, kind = "secondary", icon, size = "md", onclick, disabled, loading, title, type = "button" } = {}) {
  const hold = kind === "hold";
  const el = h("button", { type, class: `ui-btn ui-btn-${kind} ui-btn-${size}`, onclick: hold ? null : onclick, disabled: disabled || loading,
    title: title ?? (hold ? "Hold to confirm" : null), "aria-busy": loading ? "true" : null },
    loading ? h("span", { class: "ui-spin", "aria-hidden": "true" }) : ic(icon), label !== undefined ? h("span", { class: "ui-btn-l" }, label) : null);
  if (hold) {
    /** @type {any} */ let timer = null;
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } el.classList.remove("is-holding"); };
    const start = (/** @type {Event} */ e) => {
      if (/** @type {any} */ (el).disabled || timer) return;
      el.classList.add("is-holding");
      timer = setTimeout(() => { timer = null; el.classList.remove("is-holding"); onclick?.(e); }, HOLD_MS);
    };
    el.addEventListener("pointerdown", start);
    for (const t of ["pointerup", "pointerleave", "pointercancel", "blur"]) el.addEventListener(t, stop);
    el.addEventListener("keydown", (/** @type {any} */ e) => { if (isKey(e, "Enter", " ")) { e.preventDefault(); if (!e.repeat) start(e); } });
    el.addEventListener("keyup", (/** @type {any} */ e) => { if (isKey(e, "Enter", " ")) stop(); });
    el.addEventListener("click", (/** @type {any} */ e) => e.preventDefault());
  }
  return el;
}

/** @param {{ icon: string, label: string, onclick?: (e: Event) => void, size?: number, kind?: string }} o */
export function iconButton({ icon, label, onclick, size = 36, kind = "ghost" }) {
  return h("button", { type: "button", class: `ui-ibtn ui-btn-${kind} ui-ibtn-${size}`, onclick, "aria-label": label, title: label }, ic(icon, 20));
}

/** @param {any} content @param {{ tone?: string, icon?: string, title?: string }} [o] */
export function chip(content, { tone = "plain", icon, title } = {}) {
  return h("span", { class: `ui-chip ui-chip-${tone}`, title }, ic(icon, 12), content);
}

/** @param {{ kind?: string, value?: any, placeholder?: string, label?: string, onchange?: (v: string) => void, oninput?: (v: string) => void, name?: string, disabled?: boolean, error?: string, help?: string }} o */
export function field({ kind = "text", value = "", placeholder, label, onchange, oninput, name, disabled, error, help } = {}) {
  const types = /** @type {Record<string, string>} */ ({ number: "number", date: "date", email: "email", phone: "tel", password: "password", url: "url" });
  const note = error || help;
  const noteId = note ? `ui-fn-${Math.random().toString(36).slice(2, 8)}` : null;
  const input = /** @type {HTMLInputElement} */ (h(kind === "textarea" ? "textarea" : "input", { class: "ui-input", type: kind === "textarea" ? null : types[kind] || "text",
    value: String(value ?? ""), placeholder, name, disabled, "aria-invalid": error ? "true" : null, "aria-describedby": noteId, "aria-label": label ? null : placeholder || name || null }));
  if (onchange) input.addEventListener("change", () => onchange(input.value));
  if (oninput) input.addEventListener("input", () => oninput(input.value));
  const el = /** @type {any} */ (h("label", { class: `ui-field${error ? " is-error" : ""}${disabled ? " is-disabled" : ""}` }, label ? h("span", { class: "ui-field-l" }, label) : null, input,
    note ? h("span", { class: error ? "ui-field-e" : "ui-field-h", id: noteId }, note) : null));
  el.input = input;
  return el;
}

/** @param {{ on?: boolean, label: string, onchange?: (on: boolean) => void, disabled?: boolean }} o */
export function switchEl({ on = false, label, onchange, disabled }) {
  const b = h("button", { type: "button", class: "ui-switch", role: "switch", "aria-checked": String(!!on), "aria-label": label, disabled });
  b.addEventListener("click", () => { const v = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", String(v)); onchange?.(v); });
  return b;
}

/** @param {{ options: [string, string][], value?: string, onchange?: (v: string) => void, label?: string }} o */
export function segmented({ options, value, onchange, label }) {
  const el = h("div", { class: "ui-seg", role: "group", "aria-label": label });
  const buttons = options.map(([v, l]) => h("button", { type: "button", class: "ui-seg-b", "aria-pressed": String(v === value), "data-value": v,
    onclick: () => { if (el.querySelector("[aria-pressed=true]") === buttons[options.findIndex(o => o[0] === v)]) return; mark(v); onchange?.(v); } }, l));
  const mark = (/** @type {string|undefined} */ cur) => options.forEach(([v], i) => buttons[i].setAttribute("aria-pressed", String(v === cur)));
  add(el, buttons);
  return el;
}

/** @param {{ items: [string, string][], current?: string, onselect?: (id: string) => void }} o */
export function tabs({ items, current, onselect }) {
  const el = h("div", { class: "ui-tabs", role: "tablist" });
  const buttons = items.map(([id, l], i) => h("button", { type: "button", role: "tab", class: "ui-tab", "data-id": id, onclick: () => pick(i), onkeydown: (/** @type {KeyboardEvent} */ e) => {
    const d = isKey(e, "ArrowRight") ? 1 : isKey(e, "ArrowLeft") ? -1 : 0;
    if (!d) return;
    e.preventDefault(); pick((i + d + items.length) % items.length, true);
  } }, l));
  const mark = (/** @type {string|undefined} */ cur) => items.forEach(([id], i) => { buttons[i].setAttribute("aria-selected", String(id === cur)); buttons[i].setAttribute("tabindex", id === cur || (cur === undefined && i === 0) ? "0" : "-1"); });
  const pick = (/** @type {number} */ i, /** @type {boolean} */ focus = false) => { mark(items[i][0]); if (focus) buttons[i].focus(); onselect?.(items[i][0]); };
  mark(current);
  add(el, buttons);
  return el;
}

/** The row's tones: edge colours for a row that needs a look. tint: the space's own colour. */
const ROW_TONES = ["accent", "tint", "ok", "warn", "err"];

/** @param {{ lead?: any, title: any, sub?: any, end?: any, onclick?: (e: Event) => void, href?: string, selected?: boolean, tone?: string }} o */
export function row({ lead, title, sub, end, onclick, href, selected, tone }) {
  const body = [lead ? h("span", { class: "ui-row-lead" }, lead) : null,
    h("span", { class: "ui-row-main" }, h("span", { class: "ui-row-title" }, title), sub ? h("span", { class: "ui-row-sub" }, sub) : null),
    end ? h("span", { class: "ui-row-end" }, end) : null];
  const cls = `ui-row${selected ? " is-selected" : ""}${tone && ROW_TONES.includes(tone) ? ` ui-row-${tone}` : ""}`;
  if (href) return h("a", { class: cls, href, "aria-current": selected ? "true" : null }, body);
  if (!onclick) return h("div", { class: cls }, body);
  // A div, not a button: the end of a row may hold its own buttons, and a button cannot hold a button.
  return h("div", { class: cls, role: "button", tabindex: "0", "aria-pressed": selected ? "true" : null, onclick,
    onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.target === e.currentTarget && isKey(e, "Enter", " ")) { e.preventDefault(); onclick(e); } } }, body);
}

/** @param {{ title?: any, actions?: any, tone?: string }} o @param {...any} kids */
export function card({ title, actions, tone = "plain" } = {}, ...kids) {
  return h("section", { class: `ui-card ui-card-${tone}` }, title || actions ? h("header", { class: "ui-card-h" }, title ? h("h3", { class: "ui-card-t" }, title) : null, actions) : null, ...kids);
}

/** @param {{ lead?: any, title: any, why?: any, tags?: any[], actions?: { label: string, kind?: string, icon?: string, onclick?: (e: Event) => void, disabled?: boolean, loading?: boolean }[], tone?: string }} o */
export function askCard({ lead, title, why, tags, actions = [], tone = "ask" }) {
  return h("article", { class: `ui-card ui-card-${tone} ui-ask` },
    lead ? h("div", { class: "ui-ask-lead" }, lead) : null,
    h("div", { class: "ui-ask-main" },
      h("h3", { class: "ui-ask-t" }, title), why ? h("p", { class: "ui-ask-why" }, why) : null,
      tags && tags.length ? h("div", { class: "ui-ask-tags" }, tags) : null,
      actions.length ? h("div", { class: "ui-ask-acts" }, actions.map(a => button({ label: a.label, kind: a.kind || "secondary", size: "sm", icon: a.icon, onclick: a.onclick, disabled: a.disabled, loading: a.loading }))) : null));
}

/** @param {{ tone?: string, icon?: string }} o @param {...any} kids */
export function banner({ tone = "plain", icon } = {}, ...kids) {
  return h("div", { class: `ui-banner ui-banner-${tone}`, role: "status" }, ic(icon ?? (tone === "warn" || tone === "err" ? "alert" : "info")), h("div", { class: "ui-banner-b" }, ...kids));
}

/** @param {{ anchor: HTMLElement, items: { label: string, onclick: () => void, danger?: boolean }[] }} o @returns {() => void} */
export function menu({ anchor, items }) {
  const back = /** @type {any} */ (document.activeElement);
  const buttons = items.map(i => h("button", { type: "button", role: "menuitem", class: `ui-menu-i${i.danger ? " is-danger" : ""}`, tabindex: "-1",
    onclick: () => { close(); i.onclick(); } }, i.label));
  const el = h("div", { class: "ui-menu", role: "menu" }, buttons);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false; el.remove();
    document.removeEventListener("pointerdown", out, true); document.removeEventListener("keydown", key, true);
    try { (back && back !== document.body ? back : anchor)?.focus?.(); } catch { /* nothing to focus */ }
  };
  const out = (/** @type {Event} */ e) => { if (!el.contains(/** @type {Node} */ (e.target)) && !anchor.contains?.(/** @type {Node} */ (e.target))) close(); };
  const key = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : 0;
    if (!d) return;
    e.preventDefault();
    const at = buttons.indexOf(/** @type {any} */ (document.activeElement));
    const next = d === "first" ? 0 : d === "last" ? buttons.length - 1 : (at + /** @type {number} */ (d) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  document.addEventListener("pointerdown", out, true); document.addEventListener("keydown", key, true);
  document.body.append(el);
  // Under the anchor, kept inside the window; above it when there is no room below.
  const r = anchor.getBoundingClientRect?.();
  if (r) {
    const m = el.getBoundingClientRect?.();
    const w = m?.width || 0, ht = m?.height || 0, vw = globalThis.innerWidth || 0, vh = globalThis.innerHeight || 0;
    const left = vw ? Math.max(8, Math.min(r.left, vw - w - 8)) : r.left;
    const top = vh && r.bottom + 4 + ht > vh - 8 && r.top - 4 - ht >= 8 ? r.top - 4 - ht : r.bottom + 4;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }
  buttons[0]?.focus();
  return close;
}

/** @param {{ columns: { key: string, label: string, render?: (row: any) => any, align?: string }[], rows: any[], onrow?: (row: any) => void, empty?: any }} o */
export function table({ columns, rows, onrow, empty }) {
  if (!rows.length) return h("div", { class: "ui-table-empty" }, empty ?? "Nothing here yet.");
  const tpl = columns.length > 1 ? `minmax(0, 2fr) repeat(${columns.length - 1}, minmax(0, 1fr))` : "minmax(0, 1fr)";
  return h("div", { class: "ui-table", role: "table", style: `--tpl:${tpl}` },
    h("div", { class: "ui-tr ui-th", role: "row" }, columns.map(c => h("div", { class: "ui-td", role: "columnheader", "data-align": c.align || null }, c.label))),
    rows.map(r => h("div", { class: `ui-tr${onrow ? " is-link" : ""}`, role: "row", tabindex: onrow ? "0" : null, onclick: onrow ? () => onrow(r) : null,
      onkeydown: onrow ? (/** @type {KeyboardEvent} */ e) => { if (e.target === e.currentTarget && isKey(e, "Enter", " ")) { e.preventDefault(); onrow(r); } } : null },
      columns.map(c => h("div", { class: "ui-td", role: "cell", "data-label": c.label, "data-align": c.align || null }, c.render ? c.render(r) : String(r[c.key] ?? ""))))));
}

/** @param {{ stages: string[], current?: number|string, onselect?: (stage: string, i: number) => void }} o */
export function stageSteps({ stages, current, onselect }) {
  const at = typeof current === "number" ? current : Math.max(0, stages.indexOf(String(current)));
  return h("ol", { class: "ui-stages" }, stages.map((s, i) => h("li", { class: `ui-stage ${i < at ? "is-done" : i === at ? "is-current" : "is-next"}`, "aria-current": i === at ? "step" : null },
    onselect ? h("button", { type: "button", onclick: () => onselect(s, i) }, s) : s)));
}

/** @param {{ actor: any, what: any, at: any, why?: any }} o */
export function timelineItem({ actor, what, at, why }) {
  return h("div", { class: "ui-tl" }, h("span", { class: "ui-tl-dot", "aria-hidden": "true" }),
    h("div", { class: "ui-tl-b" },
      h("div", { class: "ui-tl-line" }, h("b", { class: "ui-tl-actor" }, actor), " ", h("span", { class: "ui-tl-what" }, what)),
      why ? h("span", { class: "ui-tl-why" }, why) : null,
      h("span", { class: "ui-tl-at" }, at)));
}

/** The kit's state pieces (js/states.js) with this file's names. `action` is an element, or { label, onclick, href }. @param {{ title: any, body?: any, action?: any }} o */
export function emptyState({ title, body, action }) {
  const el = kitEmpty({ title, text: body, action: action && !(action instanceof Node) ? action : null });
  if (action instanceof Node) el.append(h("div", { class: "state-actions" }, action));
  el.classList.add("ui-state");
  return el;
}

/** @param {{ title: any, reason?: any, retry?: () => void, details?: string }} o */
export function errorState({ title, reason, retry, details }) {
  const el = kitError({ title, reason, details, retry: null });
  if (retry) {
    const acts = el.querySelector(".state-actions");
    if (acts) acts.replaceChildren(button({ label: "Try again", kind: "primary", onclick: () => retry() }), ...acts.childNodes);
  }
  el.classList.add("ui-state");
  return el;
}

export { add };
