// @ts-check
// deck/ui/components: the base components, built only from tokens (ui-primitives.md section 3). Every screen draws from these and from the field
// renderers (ui/fields.js); a feature adds definitions, never a component. This file is the whole public surface and its signatures are a contract:
// the first versions below are plain, and the components team (docs/work/native-core.md) makes them final without changing a signature.
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

export { openSheet } from "../../js/sheet.js";
export { showToast } from "../../js/toast.js";

/** @param {string|undefined} name @param {number} [size] */
const ic = (name, size = 16) => (name ? drawIcon(/** @type {any} */ (name), size) : null);

/** @param {{ label?: any, kind?: string, icon?: string, size?: string, onclick?: (e: Event) => void, disabled?: boolean, loading?: boolean, title?: string, type?: string }} o */
export function button({ label, kind = "secondary", icon, size = "md", onclick, disabled, loading, title, type = "button" } = {}) {
  return h("button", { type, class: `ui-btn ui-btn-${kind} ui-btn-${size}`, onclick, disabled: disabled || loading, title, "aria-busy": loading ? "true" : null }, ic(icon), label !== undefined ? h("span", null, label) : null);
}

/** @param {{ icon: string, label: string, onclick?: (e: Event) => void, size?: number, kind?: string }} o */
export function iconButton({ icon, label, onclick, size = 36, kind = "ghost" }) {
  return h("button", { type: "button", class: `ui-ibtn ui-btn-${kind} ui-ibtn-${size}`, onclick, "aria-label": label, title: label }, ic(icon, 20));
}

/** @param {any} content @param {{ tone?: string, icon?: string, title?: string }} [o] */
export function chip(content, { tone = "plain", icon, title } = {}) {
  return h("span", { class: `ui-chip ui-chip-${tone}`, title }, ic(icon, 12), content);
}

/** @param {{ kind?: string, value?: any, placeholder?: string, label?: string, onchange?: (v: string) => void, oninput?: (v: string) => void, name?: string, disabled?: boolean, error?: string }} o */
export function field({ kind = "text", value = "", placeholder, label, onchange, oninput, name, disabled, error } = {}) {
  const input = /** @type {HTMLInputElement} */ (h("input", { class: "ui-input", type: kind === "number" ? "number" : kind === "date" ? "date" : kind === "email" ? "email" : kind === "phone" ? "tel" : kind === "password" ? "password" : "text",
    value: String(value ?? ""), placeholder, name, disabled, "aria-invalid": error ? "true" : null }));
  if (onchange) input.addEventListener("change", () => onchange(input.value));
  if (oninput) input.addEventListener("input", () => oninput(input.value));
  const el = /** @type {any} */ (h("label", { class: "ui-field" }, label ? h("span", { class: "ui-field-l" }, label) : null, input, error ? h("span", { class: "ui-field-e" }, error) : null));
  el.input = input;
  return el;
}

/** @param {{ on?: boolean, label: string, onchange?: (on: boolean) => void }} o */
export function switchEl({ on = false, label, onchange }) {
  const b = h("button", { type: "button", class: "ui-switch", role: "switch", "aria-checked": String(!!on), "aria-label": label });
  b.addEventListener("click", () => { const v = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", String(v)); onchange?.(v); });
  return b;
}

/** @param {{ options: [string, string][], value?: string, onchange?: (v: string) => void, label?: string }} o */
export function segmented({ options, value, onchange, label }) {
  const el = h("div", { class: "ui-seg", role: "group", "aria-label": label });
  const draw = (/** @type {string|undefined} */ cur) => {
    el.replaceChildren(...options.map(([v, l]) => h("button", { type: "button", class: "ui-seg-b", "aria-pressed": String(v === cur), onclick: () => { draw(v); onchange?.(v); } }, l)));
  };
  draw(value);
  return el;
}

/** @param {{ items: [string, string][], current?: string, onselect?: (id: string) => void }} o */
export function tabs({ items, current, onselect }) {
  const el = h("div", { class: "ui-tabs", role: "tablist" });
  const draw = (/** @type {string|undefined} */ cur) => {
    el.replaceChildren(...items.map(([id, l]) => h("button", { type: "button", role: "tab", class: "ui-tab", "aria-selected": String(id === cur), onclick: () => { draw(id); onselect?.(id); } }, l)));
  };
  draw(current);
  return el;
}

/** @param {{ lead?: any, title: any, sub?: any, end?: any, onclick?: (e: Event) => void, href?: string, selected?: boolean, tone?: string }} o */
export function row({ lead, title, sub, end, onclick, href, selected, tone }) {
  const body = [lead ? h("span", { class: "ui-row-lead" }, lead) : null,
    h("span", { class: "ui-row-main" }, h("span", { class: "ui-row-title" }, title), sub ? h("span", { class: "ui-row-sub" }, sub) : null),
    end ? h("span", { class: "ui-row-end" }, end) : null];
  const cls = `ui-row${selected ? " is-selected" : ""}${tone ? ` ui-row-${tone}` : ""}`;
  return href ? h("a", { class: cls, href }, body) : h(onclick ? "button" : "div", { class: cls, type: onclick ? "button" : null, onclick }, body);
}

/** @param {{ title?: any, actions?: any, tone?: string }} o @param {...any} kids */
export function card({ title, actions, tone = "plain" } = {}, ...kids) {
  return h("section", { class: `ui-card ui-card-${tone}` }, title || actions ? h("header", { class: "ui-card-h" }, h("h3", { class: "ui-card-t" }, title), actions) : null, ...kids);
}

/** @param {{ lead?: any, title: any, why?: any, tags?: any[], actions?: { label: string, kind?: string, onclick?: (e: Event) => void, disabled?: boolean }[], tone?: string }} o */
export function askCard({ lead, title, why, tags, actions = [], tone = "ask" }) {
  return h("article", { class: `ui-card ui-card-${tone} ui-ask` },
    lead ? h("div", { class: "ui-ask-lead" }, lead) : null,
    h("div", { class: "ui-ask-main" },
      h("h3", { class: "ui-ask-t" }, title), why ? h("p", { class: "ui-ask-why" }, why) : null,
      tags && tags.length ? h("div", { class: "ui-ask-tags" }, tags) : null,
      actions.length ? h("div", { class: "ui-ask-acts" }, actions.map(a => button({ label: a.label, kind: a.kind || "secondary", onclick: a.onclick, disabled: a.disabled }))) : null));
}

/** @param {{ tone?: string, icon?: string }} o @param {...any} kids */
export function banner({ tone = "plain", icon } = {}, ...kids) {
  return h("div", { class: `ui-banner ui-banner-${tone}`, role: "status" }, ic(icon ?? (tone === "warn" ? "alert" : "info")), h("div", { class: "ui-banner-b" }, ...kids));
}

/** @param {{ anchor: HTMLElement, items: { label: string, onclick: () => void, danger?: boolean }[] }} o @returns {() => void} */
export function menu({ anchor, items }) {
  const el = h("div", { class: "ui-menu", role: "menu" }, items.map(i => h("button", { type: "button", role: "menuitem", class: `ui-menu-i${i.danger ? " is-danger" : ""}`, onclick: () => { close(); i.onclick(); } }, i.label)));
  const r = anchor.getBoundingClientRect();
  el.style.left = `${r.left}px`; el.style.top = `${r.bottom + 4}px`;
  const close = () => { el.remove(); document.removeEventListener("pointerdown", out, true); document.removeEventListener("keydown", key, true); };
  const out = (/** @type {Event} */ e) => { if (!el.contains(/** @type {Node} */ (e.target))) close(); };
  const key = (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") close(); };
  document.addEventListener("pointerdown", out, true); document.addEventListener("keydown", key, true);
  document.body.append(el);
  return close;
}

/** @param {{ columns: { key: string, label: string, render?: (row: any) => any, align?: string }[], rows: any[], onrow?: (row: any) => void, empty?: any }} o */
export function table({ columns, rows, onrow, empty }) {
  if (!rows.length) return h("div", { class: "ui-table-empty" }, empty ?? "Nothing here yet.");
  return h("div", { class: "ui-table", role: "table", style: `--cols:${columns.length}` },
    h("div", { class: "ui-tr ui-th", role: "row" }, columns.map(c => h("div", { class: "ui-td", role: "columnheader", "data-align": c.align || null }, c.label))),
    rows.map(r => h("div", { class: "ui-tr", role: "row", tabindex: onrow ? "0" : null, onclick: onrow ? () => onrow(r) : null },
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
  return h("div", { class: "ui-tl" }, h("span", { class: "ui-tl-actor" }, actor), h("div", { class: "ui-tl-b" }, h("span", { class: "ui-tl-what" }, what), why ? h("span", { class: "ui-tl-why" }, why) : null), h("span", { class: "ui-tl-at" }, at));
}

/** @param {{ title: any, body?: any, action?: any }} o */
export function emptyState({ title, body, action }) {
  return h("div", { class: "ui-empty" }, h("b", null, title), body ? h("p", null, body) : null, action || null);
}

/** @param {{ title: any, reason?: any, retry?: () => void }} o */
export function errorState({ title, reason, retry }) {
  return h("div", { class: "ui-error", role: "alert" }, h("b", null, title), reason ? h("p", null, reason) : null, retry ? button({ label: "Try again", kind: "primary", onclick: retry }) : null);
}

export { add };
