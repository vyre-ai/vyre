// @ts-check
// Fuzzy matching for every list on the screen. Each word typed must appear in order as a
// subsequence of the text, case-folded. A match scores higher when its letters are together,
// when it starts a word, and when it is near the start, so "nor" finds "Northwind" before a
// session that happens to hold an n, an o and an r somewhere.

/**
 * Score one word against text. Greedy from each possible start, keeping the best.
 * @returns {{ score: number, positions: number[] } | null}
 */
function scoreWord(word, text) {
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  let best = null;
  for (let start = t.indexOf(w[0]); start !== -1; start = t.indexOf(w[0], start + 1)) {
    const pos = [start];
    let i = start + 1;
    for (let k = 1; k < w.length; k++) {
      const at = t.indexOf(w[k], i);
      if (at === -1) { pos.length = 0; break; }
      pos.push(at); i = at + 1;
    }
    if (!pos.length) break; // no later start can match either
    let score = 0;
    for (let k = 0; k < pos.length; k++) {
      const p = pos[k];
      const prev = p > 0 ? t[p - 1] : " ";
      score += 1;
      if (k > 0 && p === pos[k - 1] + 1) score += 5;
      if (/[\s\-_/.:·(]/.test(prev)) score += 4;
      if (p === 0) score += 6;
    }
    score -= Math.min(10, pos[0] / 4) + (pos[pos.length - 1] - pos[0] - pos.length + 1) * 0.5;
    if (!best || score > best.score) best = { score, positions: pos };
  }
  return best;
}

/**
 * Match a query (words separated by spaces) against text.
 * @returns {{ score: number, positions: number[] } | null} positions index code units of text
 */
export function match(query, text) {
  const words = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, positions: [] };
  let score = 0;
  const positions = new Set();
  for (const w of words) {
    const m = scoreWord(w, String(text || ""));
    if (!m) return null;
    score += m.score;
    for (const p of m.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * Items matching the query, best first; ties keep their order. The label is matched first and
 * the detail only as a weaker fallback, so a match in the name outranks one in the path.
 * @template T
 * @param {T[]} items @param {string} query @param {(it: T) => { label: string, detail?: string }} text
 * @returns {{ item: T, positions: number[] }[]}
 */
export function rank(items, query, text) {
  const out = [];
  items.forEach((item, i) => {
    const { label, detail = "" } = text(item);
    const a = match(query, label);
    // The detail counts only for words it holds whole: a letter here and there across a path
    // and a date matches almost anything.
    const words = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    const hay = `${label} ${detail}`.toLowerCase();
    const b = a || !words.every(w => hay.includes(w) || match(w, label)) ? null : { score: 0, positions: [] };
    const m = a || b;
    if (!m) return;
    out.push({ item, i, score: a ? a.score + 10 : m.score, positions: a ? a.positions : [] });
  });
  out.sort((x, y) => y.score - x.score || x.i - y.i);
  return out.map(({ item, positions }) => ({ item, positions }));
}

/**
 * Text with the matched positions styled. Works on plain text only; the caller clips first.
 * @param {string} text @param {number[]} positions @param {(s: string) => string} on
 */
export function highlight(text, positions, on) {
  if (!positions || !positions.length) return text;
  const set = new Set(positions);
  let out = "", run = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) { run += text[i]; continue; }
    if (run) { out += on(run); run = ""; }
    out += text[i];
  }
  return run ? out + on(run) : out;
}
