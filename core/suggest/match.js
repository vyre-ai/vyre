// @ts-check
// suggest's matcher and cursor reader: pure, no I/O, so a keystroke costs only string work.
//
// The tiers follow the Capsule's @ completion (Route.swift complete()): exact, prefix, a word's
// start, every typed word starting a word, an id's start, anywhere in the label. One tier more,
// from the Deck's pickers: the letters in order within one word ("nwb" finds "northwind-bakery").
// Higher is better here, so callers add it into a score.

export const EXACT = 5, PREFIX = 4, WORD = 3, ID = 2, INSIDE = 1, SPREAD = 0.5;

/** Lowercased words of letters and digits. @param {string} s */
export const wordsOf = s => String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * A label made ready for many matches: lowercased once, split once.
 * @param {string} label @param {string} [id]
 * @returns {{ lower: string, words: string[], id: string }}
 */
export const prepare = (label, id = "") => ({ lower: String(label || "").toLowerCase(), words: wordsOf(label), id: String(id || "").toLowerCase() });

/** @param {string} q @param {string} t */
function spread(q, t) {
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (/\s/.test(t[ti])) { qi = 0; continue; }
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * How well a typed query matches a prepared label: 0 for not at all. An empty query matches
 * everything a little, so "@" alone lists every name.
 * @param {string} query already lowercased
 * @param {{ lower: string, words: string[], id: string }} p
 * @param {{ idPrefix?: boolean }} [o] idPrefix: an id's start counts (threads, as in the Capsule)
 */
export function quality(query, p, o = {}) {
  const q = query;
  if (!q) return INSIDE;
  if (p.lower === q || (p.id && p.id === q)) return EXACT;
  if (p.lower.startsWith(q)) return PREFIX;
  for (const w of p.words) if (w.startsWith(q)) return WORD;
  if (/[^\p{L}\p{N}]/u.test(q)) {
    const qw = wordsOf(q);
    if (qw.length > 1 && qw.every(w => p.words.some(lw => lw.startsWith(w)))) return WORD;
  }
  if (o.idPrefix && p.id && p.id.startsWith(q)) return ID;
  if (p.lower.includes(q)) return INSIDE;
  if (q.length >= 2 && spread(q, p.lower)) return SPREAD;
  return 0;
}

/**
 * The token at the cursor and the lane it asks for. "@ju" is a mention, "/pl" a command (one
 * slash only: "/Users/alex" is a path), anything else the last word, for entities and phrases.
 * @param {string} text @param {number} [cursor] defaults to the end
 * @returns {{ lane: "mention"|"command"|"text", prefix: string, token: string, start: number, end: number }}
 */
export function tokenAt(text, cursor) {
  const s = String(text ?? "");
  const end = Number.isInteger(cursor) && /** @type {number} */ (cursor) >= 0 && /** @type {number} */ (cursor) <= s.length ? /** @type {number} */ (cursor) : s.length;
  const token = /(\S*)$/u.exec(s.slice(0, end))?.[1] ?? "";
  const start = end - token.length;
  if (token.startsWith("@")) return { lane: "mention", prefix: token.slice(1).toLowerCase(), token, start, end };
  if (token.startsWith("/") && !token.slice(1).includes("/")) return { lane: "command", prefix: token.slice(1).toLowerCase(), token, start, end };
  return { lane: "text", prefix: token.toLowerCase(), token, start, end };
}
