// @ts-check
// One line per step of the first run's server pairing and space setup (step names and stage codes only: no key, no code, no name). It goes to the console and to a short list on the page, so the first-run
// proof can read it from the window however the page was loaded, and says which step a first run stopped at.

/** @param {string} line */
export function trail(line) {
  try {
    const g = /** @type {any} */ (globalThis);
    const list = g.__vyreTrail || (g.__vyreTrail = []);
    list.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (list.length > 300) list.splice(0, list.length - 300);
    if (typeof console !== "undefined") console.info(`vyre:stage ${line}`);
  } catch { /* no console, no page */ }
}
