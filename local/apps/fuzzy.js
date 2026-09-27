// @ts-check
// fuzzy: how well a name a person typed matches a name in an app, so "ammi" finds "Ammi jee" and
// "jono" still finds "juno". A score from 0 (no match) to 1 (the same name); 0.85 and up is a
// strong match, strong enough to offer as "Did you mean ...?" when it is the only one.

export const STRONG = 0.85;

/** Levenshtein distance, giving up (returning max + 1) once it is past `max`. */
export function distance(/** @type {string} */ a, /** @type {string} */ b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Score a typed name against a title (and its id).
 * @param {string} query @param {string} title @param {string} [id]
 */
export function score(query, title, id = "") {
  const q = String(query).trim().toLowerCase().replace(/^[@#]/, "");
  const t = String(title).trim().toLowerCase().replace(/^[@#]/, "");
  if (!q || !t) return 0;
  if (q === t || q === String(id).toLowerCase()) return 1;
  const tw = t.split(/[\s._-]+/).filter(Boolean), qw = q.split(/\s+/).filter(Boolean);
  if (t.startsWith(q)) return 0.9;
  if (tw[0] === qw[0] && qw.length === 1) return 0.9;
  if (qw.every(w => tw.some(x => x.startsWith(w)))) return tw[0].startsWith(qw[0]) ? 0.85 : 0.8;
  // A slip of a letter or two: against the whole name, or its first word.
  const allowed = q.length >= 6 ? 2 : q.length >= 3 ? 1 : 0;
  if (allowed && (distance(q, t, allowed) <= allowed || distance(q, tw[0], allowed) <= allowed)) return 0.7;
  return 0;
}

/**
 * Targets that match a typed name, best first.
 * @template {{ id: string, title: string }} T
 * @param {string} query @param {T[]} targets @param {number} [limit]
 * @returns {Array<T & { score: number }>}
 */
export function rank(query, targets, limit = 10) {
  return targets.map(t => ({ ...t, score: score(query, t.title, t.id) }))
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
