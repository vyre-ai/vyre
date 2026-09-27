// @ts-check
// The Deck's one toast (docs/design/system/components/toast.md). Styles: css/toast.css.
//
//   showToast({ text: "Denied", undo: () => ... })     4 s, then gone; Undo cancels the action
//   showToast({ text, slot: rowEl })                    in place: takes a collapsed row's slot
//   showToast({ text, action: { label, run }, ms })     another quiet action (the vault's Clear now)
//
// One toast at a time: a new one replaces the old (the caller flushes the old action first).
// role=status, aria-live=polite, and it never takes focus. While it is up on the desktop, Cmd+Z
// (Ctrl+Z) is Undo. Hover pauses the countdown; it restarts at 2 s when the pointer leaves. No
// timer runs but the one that closes it (and the countdown's, once a second, when asked for).
//
// Copy: past tense, what happened, then Undo ("Approved", "Sent to Sam"). Never "Success!".

import { h } from "./dom.js";

/** --motion-undo */
export const UNDO_MS = 4000;
/** Where the pointer leaving a paused toast restarts it. */
export const RESUME_MS = 2000;

/**
 * @typedef {{ text: string | Node | (string | Node)[], undo?: (() => void) | null,
 *   action?: { label: string, run: () => void } | null, ms?: number, slot?: HTMLElement | null,
 *   countdown?: boolean, bar?: boolean, pause?: boolean, dismiss?: Node | null,
 *   onClose?: ((why: "timeout" | "undo" | "replaced" | "closed") => void) | null }} ToastOptions
 * @typedef {{ el: HTMLElement, close: (why?: "timeout" | "undo" | "replaced" | "closed") => void, readonly open: boolean }} Toast
 */

/** @type {Toast | null} */ let current = null;

/** The toast that is up, if any. */
export const currentToast = () => current;

/** Close whatever toast is up. */
export function hideToast() { current?.close("closed"); }

/**
 * Show the one toast.
 * @param {ToastOptions} o
 * @returns {Toast}
 */
export function showToast(o) {
  current?.close("replaced");
  const ms = o.ms ?? UNDO_MS;
  const inPlace = !!o.slot;
  let open = true, timer = 0, tick = 0, endsAt = Date.now() + ms, pausedLeft = 0;

  const left = o.countdown ? h("span", { class: "toast-left", "aria-hidden": "true" }) : null;
  const undoBtn = o.undo ? h("button", { type: "button", class: "button button-ghost button-xs toast-undo" }, "Undo") : null;
  const actBtn = o.action ? h("button", { type: "button", class: "button button-ghost button-xs toast-act" }, o.action.label) : null;
  const closeBtn = o.dismiss ? h("button", { type: "button", class: "ibtn icon-button-xs toast-x", "aria-label": "Dismiss" }, o.dismiss) : null;
  const bar = o.bar ? h("span", { class: "toast-bar", "aria-hidden": "true", style: { animationDuration: `${ms}ms` } }) : null;
  const el = h("div", { class: "toast " + (inPlace ? "toast-inplace" : "toast-float"), role: "status", "aria-live": "polite" },
    inPlace ? h("span", { class: "toast-check", "aria-hidden": "true" }) : null,
    h("span", { class: "toast-t" }, o.text), undoBtn, actBtn, left, closeBtn, bar);

  const showLeft = () => { if (left) left.replaceChildren(`${Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))} s`); };
  const arm = (/** @type {number} */ wait) => {
    clearTimeout(timer);
    endsAt = Date.now() + wait;
    timer = window.setTimeout(() => close("timeout"), wait);
    if (left) { clearInterval(tick); showLeft(); tick = window.setInterval(showLeft, 1000); }
  };
  const onKey = (/** @type {any} */ e) => {
    if (!o.undo || !(e.metaKey || e.ctrlKey) || e.shiftKey || String(e.key).toLowerCase() !== "z") return;
    e.preventDefault?.();
    undo();
  };
  const enter = () => { if (!open) return; pausedLeft = Math.max(0, endsAt - Date.now()); clearTimeout(timer); clearInterval(tick); };
  const leave = () => { if (open && pausedLeft) arm(Math.min(pausedLeft, RESUME_MS)); pausedLeft = 0; };

  /** @param {"timeout" | "undo" | "replaced" | "closed"} why */
  function close(why = "closed") {
    if (!open) return;
    open = false;
    clearTimeout(timer); clearInterval(tick);
    document.removeEventListener("keydown", onKey);
    if (current === toast) current = null;
    // Out: opacity over --motion-tap, then gone. A replaced toast goes at once.
    if (why === "replaced" || inPlace) el.remove();
    else { el.classList.add("toast-out"); window.setTimeout(() => el.remove(), 120); }
    o.onClose?.(why);
  }
  function undo() {
    if (!open) return;
    const f = o.undo;
    close("undo");
    f?.();
  }

  undoBtn?.addEventListener("click", undo);
  actBtn?.addEventListener("click", () => { const run = o.action?.run; close("closed"); run?.(); });
  closeBtn?.addEventListener("click", () => close("closed"));
  if (o.pause !== false && !o.bar) { el.addEventListener("pointerenter", enter); el.addEventListener("pointerleave", leave); }
  if (o.undo) document.addEventListener("keydown", onKey);

  if (inPlace) /** @type {HTMLElement} */ (o.slot).replaceChildren(el);
  else document.body.append(el);
  const toast = { el, close, get open() { return open; } };
  current = toast;
  arm(ms);
  return toast;
}
