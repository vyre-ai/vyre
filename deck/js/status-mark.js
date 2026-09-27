// @ts-check
// The one status model (docs/design/system/components/status-mark.md), drawn the same way on every
// Deck row: most urgent first, one mark per row, each with its own shape so colour is never the
// only signal. Styles: css/marks.css.
//
//   needs you   8 solid dot, the attention colour (--beacon-dot)
//   failed      12 circle with a cross, --text-2 (never the attention colour, never amber)
//   running     10 ring, --focus, with the elapsed time beside it
//   unread      8 solid dot, --text
//   done        8 hollow dot, --label
//
// Also the badge (needs you only: "3", "99+"), the neutral count, and the path dot for how a device
// is reached (direct --focus solid, relayed --label solid, none --label hollow). Relayed is normal,
// never a warning.

import { h } from "./dom.js";

/** Most urgent first. The keys are a contract (tokens.json status). */
export const ORDER = /** @type {const} */ (["needs", "failed", "running", "unread", "done"]);
/** The five words, exactly. */
export const WORDS = { needs: "needs you", failed: "failed", running: "running", unread: "unread", done: "done" };

/** A session's state word to its status: starting and running run, waiting needs you, stopped and idle are done. */
const FROM = /** @type {Record<string, typeof ORDER[number]>} */ ({
  needs: "needs", "needs you": "needs", waiting: "needs", ask: "needs",
  failed: "failed", error: "failed",
  running: "running", starting: "running",
  unread: "unread",
  done: "done", idle: "done", stopped: "done",
});

/** @param {string | null | undefined} s @returns {typeof ORDER[number] | null} */
export const statusOf = s => (s ? FROM[String(s).toLowerCase()] || null : null);

/** The most urgent of several statuses, or null. @param {(string | null | undefined)[]} list */
export function worst(list) {
  const got = new Set(list.map(statusOf));
  return ORDER.find(s => got.has(s)) || null;
}

/** Elapsed time for a running mark: "12s", "4m", "1h 12m". @param {number} ms */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The mark for a status. Alone it is an image named by its word; with word: true it comes inside
 * the .st line with its word beside it ("running · 4m"), and the mark itself is hidden.
 * @param {string} status any of ORDER, or a session state word (statusOf)
 * @param {{ word?: boolean | string, since?: number | null, now?: number, beside?: boolean }} [o]
 *   word: true prints the status word, a string prints that word instead (a session state word);
 *   since: when running started, for the elapsed time;
 *   beside: the caller prints the word itself, so the mark alone is returned, hidden
 * @returns {HTMLElement}
 */
export function statusMark(status, o = {}) {
  const s = statusOf(status) || "done";
  const text = typeof o.word === "string" ? o.word : WORDS[s];
  const tail = s === "running" && typeof o.since === "number" ? ` · ${elapsed((o.now ?? Date.now()) - o.since)}` : "";
  if (o.beside) return h("span", { class: `sm sm-${s}`, "aria-hidden": "true", "data-status": s });
  if (!o.word) return h("span", { class: `sm sm-${s}`, role: "img", "aria-label": text + tail, "data-status": s });
  return h("span", { class: "st", "data-status": s }, h("span", { class: `sm sm-${s}`, "aria-hidden": "true" }), text + tail);
}

/**
 * The needs-you badge: 1 to 99, then "99+". Empty (hidden) at 0.
 * @param {number} n @param {HTMLElement} [el] an existing badge to update
 */
export function badge(n, el) {
  const b = el || h("span", { class: "sm-badge" });
  b.hidden = !n;
  b.replaceChildren(n > 99 ? "99+" : String(n || 0));
  if (n) b.setAttribute("aria-label", n > 99 ? "more than 99 need you" : `${n} need${n === 1 ? "s" : ""} you`);
  else b.removeAttribute("aria-label");
  return b;
}

/** A neutral count (group sizes, totals): same shape as the badge, no attention colour. @param {number} n */
export const count = n => h("span", { class: "sm-count" }, n > 99 ? "99+" : String(n));

/**
 * How a device is reached (not a status): "direct", "relayed" (relay or peer relay) or "none".
 * @param {string | null | undefined} path @param {string} [label] its accessible name
 */
export function pathMark(path, label) {
  const p = path === "direct" ? "direct" : path === "relayed" || path === "relay" || path === "peer-relay" ? "relayed" : "none";
  return h("span", { class: `sm sm-path-${p}`, "data-path": p, ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }) });
}
