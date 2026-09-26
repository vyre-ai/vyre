// @ts-check
// Client-side fuzzy search over what the Deck already has: names, descriptions, hosts, the kind
// and field NAMES. Never values: the page has none to search. No DOM here, so node tests it.

/**
 * Score one needle against one haystack: a subsequence match, with more for runs of adjacent
 * characters and for starting at a word boundary. 0 means no match.
 * @param {string} needle lowercase
 * @param {string} hay
 */
export function fuzzy(needle, hay) {
  const h = String(hay || "").toLowerCase();
  if (!needle) return 1;
  if (!h) return 0;
  const exact = h.indexOf(needle);
  if (exact >= 0) return 100 + (exact === 0 ? 50 : boundary(h, exact) ? 25 : 0) - Math.min(h.length, 40) / 4;
  let score = 0, j = 0, run = 0;
  for (let i = 0; i < h.length && j < needle.length; i++) {
    if (h[i] !== needle[j]) { run = 0; continue; }
    run += 1;
    score += 1 + run * 2 + (boundary(h, i) ? 6 : 0);
    j += 1;
  }
  return j === needle.length ? score : 0;
}
const boundary = (h, i) => i === 0 || /[\s\-_.:/@]/.test(h[i - 1]);

/** Where each item is searched, and how much a hit there counts. */
const WEIGHTS = [["name", 3], ["hosts", 2], ["description", 1], ["kindLabel", 1], ["fields", 1]];

/**
 * Filter and rank items. Every word of the query must match somewhere in the item.
 * @template {{ name: string, description?: string, hosts?: string[], kindLabel?: string, fields?: string[] }} T
 * @param {T[]} items
 * @param {string} query
 * @returns {T[]}
 */
export function search(items, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice();
  const scored = [];
  for (const it of items) {
    let total = 0;
    let ok = true;
    for (const w of words) {
      let best = 0;
      for (const [key, weight] of WEIGHTS) {
        const v = /** @type {any} */ (it)[key];
        const texts = Array.isArray(v) ? v.map(x => String(x).replace(/^https?:\/\//, "")) : [v];
        for (const t of texts) best = Math.max(best, fuzzy(w, t) * /** @type {number} */ (weight));
      }
      if (!best) { ok = false; break; }
      total += best;
    }
    if (ok) scored.push({ it, total });
  }
  return scored.sort((a, b) => b.total - a.total || a.it.name.localeCompare(b.it.name)).map(s => s.it);
}
