// @ts-check
// The state kit (design-system.md section 5): every list and panel renders through four pieces.
//   skeleton(n)         loading: rows at the real row height. Cached content paints first; a skeleton is only for what has no cache.
//   loading(opts)       a skeleton that, after 10 s, says Vyre is slow to answer (one quiet line), and stops when told to.
//   emptyState(o)       one bold line, one sentence, one action. Calm: no dot, no badge, no picture.
//   errorState(o)       what failed in plain words, a quiet reason, and Try again. The real code is behind "Copy details", never on the screen.
//                       An error is never drawn as an empty list.
// The offline pill is js/reconnect.js (the shell shows it); its look comes with the shell step.

import { h } from "./dom.js";

/** How long a skeleton waits before it admits the answer is slow. */
export const SLOW_MS = 10_000;

/** @param {number} [n] rows */
export function skeleton(n = 5) {
  return h("div", { class: "skels", "aria-busy": "true", "aria-label": "Loading" },
    Array.from({ length: n }, () => h("div", { class: "skel", "aria-hidden": "true" }, h("i", { class: "c" }), h("div", { class: "tx" }, h("i", { class: "l1" }), h("i", { class: "l2" })))));
}

/**
 * A skeleton with the slow line. Returns the element and `stop()` (call it when the real content is drawn).
 * @param {{ rows?: number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [o]
 * @returns {HTMLElement & { stop: () => void }}
 */
export function loading(o = {}) {
  const set = o.setTimeout || setTimeout, clear = o.clearTimeout || clearTimeout;
  const el = /** @type {any} */ (h("div", { class: "loading" }, skeleton(o.rows ?? 5)));
  const t = set(() => el.append(h("p", { class: "kit-slow", role: "status" }, "Vyre is slow to answer. Still trying.")), SLOW_MS);
  el.stop = () => clear(t);
  return el;
}

/**
 * @param {{ title: string, text?: string, action?: { label: string, href?: string, onclick?: () => void, primary?: boolean } | null }} o
 */
export function emptyState({ title, text, action }) {
  return h("div", { class: "empty state", role: "status" },
    h("b", { class: "state-title" }, title),
    text ? h("p", { class: "state-text" }, text) : null,
    action ? actionButton(action) : null);
}

/**
 * @param {{ title: string, reason?: string|null, retry?: (() => void) | null, details?: string|null, copy?: (text: string) => void }} o
 *   title: what failed, in plain words ("Could not load what is running."). reason: the quiet second line ("Vyre did not answer. Your work is safe.").
 *   details: the real error text, copied by "Copy details".
 */
export function errorState({ title, reason, retry, details, copy }) {
  const doCopy = copy || ((/** @type {string} */ t) => { try { void navigator.clipboard?.writeText(t); } catch { /* no clipboard */ } });
  return h("div", { class: "empty state state-error", role: "alert" },
    h("b", { class: "state-title" }, title),
    reason ? h("span", { class: "state-reason" }, reason) : null,
    h("div", { class: "state-actions" },
      retry ? h("button", { class: "btn btn-primary", type: "button", "data-act": "retry", onclick: () => retry() }, "Try again") : null,
      details ? h("button", { class: "btn btn-ghost", type: "button", "data-act": "copy", onclick: () => doCopy(details) }, "Copy details") : null));
}

/** @param {{ label: string, href?: string, onclick?: () => void, primary?: boolean }} a */
function actionButton(a) {
  const cls = "btn " + (a.primary === false ? "btn-ghost" : "btn-primary");
  return a.href ? h("a", { class: cls, href: a.href }, a.label) : h("button", { class: cls, type: "button", onclick: () => a.onclick?.() }, a.label);
}

/**
 * What a failed tool call says, in plain words and a quiet reason, from an ApiError: a missing module, an unreachable box, or the error's own words.
 * @param {any} err
 * @returns {{ reason: string, details: string }}
 */
export function whyFailed(err) {
  if (!err) return { reason: "", details: "" };
  const details = [err.code, err.message].filter(Boolean).join(": ").slice(0, 400);
  if (err.missing && err.code === "offline") return { reason: "Vyre did not answer. Your work is safe.", details };
  if (err.missing) return { reason: `This part of Vyre is not running${err.module ? ` (${err.module})` : ""}.`, details };
  if (err.code === "timeout") return { reason: "Vyre took too long to answer. Your work is safe.", details };
  return { reason: String(err.message || "Something went wrong.").slice(0, 160), details };
}
