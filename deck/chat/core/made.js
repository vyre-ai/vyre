// @ts-check
// The teammates a "@role" made a moment ago, so the handoff card can say "Made design, a new
// teammate" with Undo (native-core.md section 9). Memory only, this tab only: the card outlives it
// as a plain handoff, and Undo is offered only while the ask has no reply and nothing has run.

/** @type {Map<string, { id: string|null, at: number }>} */
const MADE = new Map();
const key = (/** @type {string} */ project, /** @type {string} */ role) => `${project}\u0000${role}`;

/** @param {string} project @param {string} role @param {string|null} id the teammate's id (team.add's answer) */
export function markMade(project, role, id) { MADE.set(key(project, role), { id, at: Date.now() }); }

/** @param {string} project @param {string} role @returns {{ id: string|null, at: number }|null} */
export function madeNow(project, role) { return MADE.get(key(project, role)) || null; }

/** @param {string} project @param {string} role */
export function unmark(project, role) { MADE.delete(key(project, role)); }

/**
 * A role that is one typo away from an existing one: edit distance up to 2, a plural, or a prefix
 * (`desgin`, `designs`, `des` for `design`). Never the exact role, never a role shorter than 3
 * letters (too many false hits). The nearest wins; a tie goes to the first listed.
 * @param {string} typed @param {string[]} roles @returns {string|null}
 */
export function nearRole(typed, roles) {
  const t = String(typed || "").toLowerCase();
  if (t.length < 3 || roles.includes(t)) return null;
  let best = null, bestD = 99;
  for (const r of roles) {
    const d = r.startsWith(t) || t === r + "s" || r === t + "s" ? 1 : editDistance(t, r);
    if (d <= 2 && d < bestD) { best = r; bestD = d; }
  }
  return best;
}

/** Levenshtein distance, two rows. @param {string} a @param {string} b */
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
