// @ts-check
// The rail's folded state: remembered on this device only, with a store that may be missing or blocked (a private window): then the rail is simply expanded. Pure, so Node tests it.

export const RAIL_KEY = "vyre.rail.collapsed";
/** The folded rail's width: an icon, its row padding and the edge. */
export const COLLAPSED_WIDTH = 64;

/** @param {{ getItem: (k: string) => string | null } | null | undefined} store */
export function readCollapsed(store) {
  try { return store?.getItem(RAIL_KEY) === "1"; } catch { return false; }
}

/** @param {{ setItem: (k: string, v: string) => void } | null | undefined} store @param {boolean} collapsed */
export function writeCollapsed(store, collapsed) {
  try { store?.setItem(RAIL_KEY, collapsed ? "1" : "0"); } catch { /* a blocked store: the fold lasts until the app closes */ }
}

/** Cmd or Ctrl with a backslash folds and unfolds the rail. @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e */
export function isToggleKey(e) {
  return e.key === "\\" && Boolean(e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
}

/** @param {boolean} collapsed @param {number} full */
export const railWidth = (collapsed, full) => (collapsed ? COLLAPSED_WIDTH : full);
