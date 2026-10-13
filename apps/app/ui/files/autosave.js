// The pure half of the document overlay's autosave and undo: when the next save is due, and the undo and redo stacks. No clock, no calls.

/** How long to wait before saving: 1.5 s after the last keystroke, and never closer than `spacing` ms to the previous save. */
export const nextSaveDelay = (now, lastSaveAt, spacing, pause = 1500) => Math.max(pause, lastSaveAt && spacing ? lastSaveAt + spacing - now : 0);

const KEEP = 200, BURST = 700;

/** @typedef {{ past: string[], future: string[], at: number }} History */

/** Remember `before` as an undo step when the last step was more than a burst of typing ago (so one undo takes back a few words, not a letter). Clears redo. @param {History} h @param {string} before @param {number} now @returns {History} */
export function pushHistory(h, before, now) {
  if (h.past.length && now - h.at < BURST) return { past: h.past, future: [], at: now };
  return { past: [...h.past, before].slice(-KEEP), future: [], at: now };
}

/** @param {History} h @param {string} current @returns {{ text: string | null, hist: History }} */
export function undoOf(h, current) {
  if (!h.past.length) return { text: null, hist: h };
  const text = h.past[h.past.length - 1];
  return { text, hist: { past: h.past.slice(0, -1), future: [current, ...h.future], at: 0 } };
}

/** @param {History} h @param {string} current @returns {{ text: string | null, hist: History }} */
export function redoOf(h, current) {
  if (!h.future.length) return { text: null, hist: h };
  const [text, ...rest] = h.future;
  return { text, hist: { past: [...h.past, current], future: rest, at: 0 } };
}
