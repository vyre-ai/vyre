// @ts-check
// core/modules/semver.js: version ranges for a module's `requires`. Split out of index.js (its line budget); re-exported there.

/** A version as [major, minor, patch], or null. @param {string} v */
export const semver = v => { const x = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim()); return x ? [Number(x[1]), Number(x[2] || 0), Number(x[3] || 0)] : null; };
export const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a version meets a range: comparators (>=, >, <=, <, =, ^, ~, or a bare version) joined by
 * spaces, all of which must hold, or * for any. null when the range can't be read.
 * @param {string} version @param {string} range @returns {boolean | null}
 */
export function satisfies(version, range) {
  const v = semver(version);
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  if (!v) return false;
  let ok = true;
  for (const part of parts) {
    if (part === "*" || part === "x") continue;
    const x = /^(>=|<=|>|<|=|\^|~)?(v?\d+(?:\.\d+){0,2})$/.exec(part);
    if (!x) return null;
    const want = /** @type {number[]} */ (semver(x[2])), c = cmp(v, want);
    const op = x[1] || "=";
    const upper = op === "^" ? (want[0] > 0 ? [want[0] + 1, 0, 0] : [0, want[1] + 1, 0]) : [want[0], want[1] + 1, 0];
    const hold = op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : op === "=" ? c === 0 : c >= 0 && cmp(v, upper) < 0;
    ok = ok && hold;
  }
  return ok;
}
