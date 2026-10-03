// @ts-check
// The rail's form, a setting in Settings > Appearance > Rail: "auto" (the default: names beside the icons from 1200 px), "icons", or "labels". Icons and
// Labels override Auto at any width of 720 px or more. Kept per device in localStorage "vyre.rail" and applied as html[data-rail]; css/shell-v2.css does the rest.

export const MODES = Object.freeze(["auto", "icons", "labels"]);
export const KEY = "vyre.rail";

/** @param {{ getItem: (k: string) => string | null } | null} [store] */
export function readRailMode(store) {
  try { const v = (store === undefined ? localStorage : store)?.getItem(KEY); return MODES.includes(/** @type {any} */ (v)) ? /** @type {"auto"|"icons"|"labels"} */ (v) : "auto"; } catch { return "auto"; }
}

/** Apply (and keep) a mode. @param {string} mode @param {{ doc?: Document, store?: { setItem: (k: string, v: string) => void, removeItem: (k: string) => void } | null }} [o] */
export function setRailMode(mode, o = {}) {
  const m = MODES.includes(/** @type {any} */ (mode)) ? mode : "auto";
  const doc = o.doc || document;
  doc.documentElement.dataset.rail = m;
  try { const s = o.store === undefined ? localStorage : o.store; if (m === "auto") s?.removeItem(KEY); else s?.setItem(KEY, m); } catch { /* private window */ }
  return m;
}
