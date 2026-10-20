// @ts-check
// A resizable edge's numbers: the width kept between a least and a most, remembered per device, moved by the pointer or the arrow keys. Pure, so Node tests it.

/** @param {number} w @param {number} min @param {number} max */
export const clampWidth = (w, min, max) => (Number.isFinite(w) ? Math.min(max, Math.max(min, Math.round(w))) : min);

const key = (/** @type {string} */ name) => `vyre.width.${name}`;

/** The width kept for `name` on this device, or null (nothing kept, junk, or a blocked store). @param {{ getItem: (k: string) => string | null } | null | undefined} store @param {string} name */
export function readWidth(store, name) {
  try {
    const n = Number(store?.getItem(key(name)));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Keep a width, or forget it with null (back to the default). @param {{ setItem: (k: string, v: string) => void } | null | undefined} store @param {string} name @param {number | null} width */
export function writeWidth(store, name, width) {
  try { store?.setItem(key(name), width === null ? "" : String(Math.round(width))); } catch { /* a blocked store: the width lasts until the app closes */ }
}

/** The width a key press asks for on a focused handle, or null for a key it does not use. Arrows move 16 (64 with shift), Home and End the ends, Enter the default. @param {string} k @param {number} w @param {{ min: number, max: number, def: number, shift?: boolean }} o */
export function keyStep(k, w, o) {
  const d = o.shift ? 64 : 16;
  if (k === "ArrowRight") return clampWidth(w + d, o.min, o.max);
  if (k === "ArrowLeft") return clampWidth(w - d, o.min, o.max);
  if (k === "Home") return o.min;
  if (k === "End") return o.max;
  if (k === "Enter") return o.def;
  return null;
}

/** How far past the least width a drag goes before the panel snaps shut (the sidebar: dragging it down to the edge collapses it, like Cmd backslash). */
export const SNAP_SLACK = 24;
/** Should a drag that wants `raw` px collapse a panel whose least width is `min`? @param {number} raw @param {number} min */
export const snapsShut = (raw, min) => raw < min - SNAP_SLACK;
/** How far a drag out of a collapsed edge goes before it opens (px). */
export const OPEN_AFTER = 40;
/** The width the pointer asks for, unclamped. @param {number} start @param {number} dx @param {"left" | "right"} edge */
export const rawWidth = (start, dx, edge) => (edge === "right" ? start + dx : start - dx);

/** The width after the pointer moved `dx`. An edge on the right of the panel (the left sidebar) grows with the pointer; one on its left (the right panel) shrinks. @param {number} start @param {number} dx @param {"left" | "right"} edge @param {{ min: number, max: number }} o */
export const dragWidth = (start, dx, edge, o) => clampWidth(edge === "right" ? start + dx : start - dx, o.min, o.max);
