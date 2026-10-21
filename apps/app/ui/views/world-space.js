// @ts-check
// Which Space the records world is for. The shell sets it when the Space showing changes (screens/shell/state.ts); the shared records world is kept per Space, so a switch never draws the last Space's
// records (0.6.8 drew them: the world was kept by its filters alone).
let space = "";
/** @type {Set<() => void>} */ const listeners = new Set();

/** @returns {string} */ export const worldSpace = () => space;
/** @param {string} next */
export function setWorldSpace(next) {
  if (next === space) return;
  space = next;
  for (const l of [...listeners]) l();
}
/** @param {() => void} l @returns {() => void} */
export function subscribeWorldSpace(l) { listeners.add(l); return () => { listeners.delete(l); }; }
