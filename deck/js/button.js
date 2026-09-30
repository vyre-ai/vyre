// @ts-check
// The one button (docs/design/system/components/button.md), for code that builds one rather than
// writing its classes by hand. Styles: css/buttons.css. Existing markup with .btn / .sb keeps
// working (they are aliases there); new code can use this.
//
//   button({ label: "Send", variant: "primary" })             a 32 desktop button
//   button({ label: "Allow once", keyHint: "A", keys: "a" })  with its key hint
//   setBusy(b, "Sending") ... setBusy(b, false)               spinner, -ing word, same width
//   hold(b, { onHold: remove })                               a hold button's press and hold
//
// Labels are sentence case, verb first; nothing here upper-cases them.

import { h } from "./dom.js";

export const VARIANTS = /** @type {const} */ (["primary", "secondary", "outline", "ghost", "hold"]);
export const SIZES = /** @type {const} */ (["xs", "sm", "touch", "touch-lg"]);
/** The spec's hold time, --motion-hold. */
export const HOLD_MS = 600;

/**
 * @param {{ label: string, variant?: typeof VARIANTS[number], size?: typeof SIZES[number] | null,
 *   icon?: Node | null, keyHint?: string | null, keys?: string | null, busy?: string | null,
 *   disabled?: boolean, full?: boolean, type?: string, onClick?: ((e: Event) => void) | null,
 *   class?: string, attrs?: Record<string, any> }} o
 * @returns {HTMLButtonElement}
 */
export function button(o) {
  const variant = VARIANTS.includes(/** @type {any} */ (o.variant)) ? o.variant : "outline";
  const cls = ["button", `button-${variant}`];
  if (o.size && SIZES.includes(o.size)) cls.push(`button-${o.size}`);
  if (o.full) cls.push("button-full");
  if (o.class) cls.push(o.class);
  const b = /** @type {HTMLButtonElement} */ (h("button", {
    type: o.type || "button", class: cls.join(" "), disabled: !!o.disabled,
    "aria-keyshortcuts": o.keys || null,
    "aria-description": variant === "hold" ? "Hold for 0.6 seconds" : null,
    onclick: o.onClick || null, ...(o.attrs || {}),
  }, o.icon || null, h("span", { class: "button-label" }, o.label),
    o.keyHint ? h("span", { class: "button-key", "aria-hidden": "true" }, o.keyHint) : null));
  if (o.busy) setBusy(b, o.busy);
  return b;
}

/**
 * Busy: the spinner replaces the icon, the label becomes the verb in progress ("Sending"), and the
 * button keeps its resting width. setBusy(b, false) puts it back.
 * @param {HTMLElement} b @param {string | false} word
 */
export function setBusy(b, word) {
  const st = /** @type {any} */ (b);
  if (word) {
    if (!st._rest) {
      const w = b.getBoundingClientRect?.().width;
      st._rest = { kids: [...b.childNodes], minWidth: b.style.minWidth };
      if (w) b.style.minWidth = `${Math.ceil(w)}px`;
    }
    const key = st._rest.kids.find((/** @type {any} */ k) => k.classList?.contains("button-key"));
    b.replaceChildren(h("span", { class: "button-spin", "aria-hidden": "true" }), h("span", { class: "button-label" }, word), ...(key ? [key] : []));
    b.setAttribute("aria-busy", "true");
    return;
  }
  if (!st._rest) return;
  b.replaceChildren(...st._rest.kids);
  b.style.minWidth = st._rest.minWidth;
  st._rest = null;
  b.removeAttribute("aria-busy");
}

/**
 * The hold gesture: press (pointer, or Space/Enter) for HOLD_MS and onHold runs; release early and
 * nothing happens while the fill drains. A quick tap says "Hold to <verb>" in the note for 2 s.
 * Returns a stop function. One timer per press; nothing runs between presses.
 * @param {HTMLButtonElement} b
 * @param {{ onHold: () => void, note?: HTMLElement | null, tapWord?: string, ms?: number }} o
 */
export function hold(b, o) {
  const ms = o.ms ?? HOLD_MS;
  let timer = 0, noteTimer = 0, started = 0;
  const idle = o.note?.textContent || "";
  const start = (/** @type {Event} */ e) => {
    if (b.disabled || b.getAttribute("aria-busy") === "true" || timer) return;
    e.preventDefault?.();
    started = Date.now();
    b.classList.add("holding");
    timer = window.setTimeout(() => { timer = 0; b.classList.remove("holding"); o.onHold(); }, ms);
  };
  const end = () => {
    if (!timer) return;
    clearTimeout(timer); timer = 0;
    b.classList.remove("holding");
    if (o.note && Date.now() - started < 250) {
      o.note.textContent = o.tapWord || "Hold to delete";
      clearTimeout(noteTimer);
      noteTimer = window.setTimeout(() => { if (o.note) o.note.textContent = idle; }, 2000);
    }
  };
  const key = (/** @type {any} */ e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) start(e); };
  const keyUp = (/** @type {any} */ e) => { if (e.key === " " || e.key === "Enter") end(); };
  const click = (/** @type {Event} */ e) => e.preventDefault?.(); // a click alone never fires a hold
  b.addEventListener("pointerdown", start);
  for (const t of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(t, end);
  b.addEventListener("keydown", key);
  b.addEventListener("keyup", keyUp);
  b.addEventListener("click", click);
  return () => {
    end(); clearTimeout(noteTimer);
    b.removeEventListener("pointerdown", start);
    for (const t of ["pointerup", "pointerleave", "pointercancel"]) b.removeEventListener(t, end);
    b.removeEventListener("keydown", key);
    b.removeEventListener("keyup", keyUp);
    b.removeEventListener("click", click);
  };
}
