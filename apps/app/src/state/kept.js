// @ts-check
// The rule every list screen follows (stale while revalidate): the last answer for this Space draws at once, the fresh answer replaces it in place, and a read that does not answer in time ends
// in a plain error with Try again, or, when a kept copy is showing, leaves the copy and says nothing. Pure; the hook is src/state/kept.ts.

/** How long a read may take before the screen stops waiting. */
export const READ_BUDGET_MS = 20_000;
/** A copy older than this is not shown. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The view cache key for one screen's data in one Space. @param {string} name @param {string | null | undefined} space */
export const keptKey = (name, space) => `kept.${name}.${space || "home"}`;

/** The copy as kept: the value and when. @param {unknown} value @param {() => number} [clock] */
export const packKept = (value, clock = Date.now) => ({ v: 1, at: clock(), value });

/** The value of a kept copy, or undefined when there is none, it is not this version's or it is too old. @param {any} raw @param {() => number} [clock] */
export function unpackKept(raw, clock = Date.now) {
  if (!raw || raw.v !== 1 || typeof raw.at !== "number" || raw.value === undefined) return undefined;
  if (clock() - raw.at > MAX_AGE_MS) return undefined;
  return raw.value;
}

/** A promise that gives up: rejects with a plain sentence when `ms` passes first. @template T @param {Promise<T>} p @param {number} [ms] @param {string} [say] @returns {Promise<T>} */
export function within(p, ms = READ_BUDGET_MS, say = "This is taking too long. Check your connection, then try again.") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(say)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** What a failed read says, in plain words. @param {unknown} e @param {string} fallback */
export function saidError(e, fallback) {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m && m.trim() ? m.trim() : fallback;
}
