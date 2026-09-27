// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/utils/tool-call-parsers.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS, no highlight tokens,
// a size guard past which a diff is the whole old block removed and the whole new block added.
//
// An edit's diff as lines, from its two strings or from a unified diff's text. Shared core: no DOM
// and no Node APIs, so the Deck, core and an Expo app all import it. The Deck's own renderer
// (deck/chat/lib/diff.js) builds DOM and numbers lines from Claude Code's structured patch; this
// is the plain data both a phone and a server can use, with word-level segments on a changed pair.

/**
 * @typedef {{ text: string, changed: boolean }} DiffSegment
 * @typedef {{ type: "add"|"remove"|"context"|"header", content: string, segments?: DiffSegment[] }} DiffLine
 *   content keeps its "+", "-" or " " prefix, the way a unified diff prints it
 */

const MAX_LINES = 2000; // past this, LCS over lines is wasted work: old block out, new block in
const MAX_WORDS = 2000; // the same guard for one changed pair's word-level segments

/** @param {string} text */
const splitLines = text => (text ? text.replace(/\r\n/g, "\n").split("\n") : []);

/** Word runs and the runs between them, both kept, so the segments join back to the line. @param {string} text */
const splitWords = text => text.match(/\w+|\W+/g) || [];

/**
 * LCS over the two lines' words: each side as runs of unchanged and changed text.
 * @param {string} oldLine @param {string} newLine
 * @returns {{ oldSegments: DiffSegment[], newSegments: DiffSegment[] }}
 */
function wordDiff(oldLine, newLine) {
  const xs = splitWords(oldLine), ys = splitWords(newLine);
  const m = xs.length, n = ys.length;
  if (m > MAX_WORDS || n > MAX_WORDS) {
    return { oldSegments: oldLine ? [{ text: oldLine, changed: true }] : [], newSegments: newLine ? [{ text: newLine, changed: true }] : [] };
  }
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const oldKeep = new Set(), newKeep = new Set();
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (xs[i] === ys[j]) { oldKeep.add(i); newKeep.add(j); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  /** @param {string[]} words @param {Set<number>} keep */
  const segments = (words, keep) => {
    /** @type {DiffSegment[]} */
    const out = [];
    words.forEach((w, k) => {
      const changed = !keep.has(k), last = out[out.length - 1];
      if (last && last.changed === changed) last.text += w; else out.push({ text: w, changed });
    });
    return out;
  };
  return { oldSegments: segments(xs, oldKeep), newSegments: segments(ys, newKeep) };
}

/**
 * Two strings as diff lines (LCS over lines), with word-level segments on each removed line that is
 * followed by an added one.
 * @param {string} originalText @param {string} updatedText
 * @returns {DiffLine[]}
 */
export function buildLineDiff(originalText, updatedText) {
  const xs = splitLines(originalText == null ? "" : String(originalText));
  const ys = splitLines(updatedText == null ? "" : String(updatedText));
  if (!xs.length && !ys.length) return [];
  const m = xs.length, n = ys.length;
  /** @type {DiffLine[]} */
  const diff = [];
  if (m > MAX_LINES || n > MAX_LINES) {
    for (const l of xs) diff.push({ type: "remove", content: `-${l}` });
    for (const l of ys) diff.push({ type: "add", content: `+${l}` });
    return diff;
  }
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (xs[i] === ys[j]) { diff.push({ type: "context", content: ` ${xs[i]}` }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { diff.push({ type: "remove", content: `-${xs[i]}` }); i++; }
    else { diff.push({ type: "add", content: `+${ys[j]}` }); j++; }
  }
  while (i < m) diff.push({ type: "remove", content: `-${xs[i++]}` });
  while (j < n) diff.push({ type: "add", content: `+${ys[j++]}` });

  for (let k = 0; k < diff.length - 1; k++) {
    const cur = diff[k], next = diff[k + 1];
    if (cur.type === "remove" && next.type === "add") {
      const { oldSegments, newSegments } = wordDiff(cur.content.slice(1), next.content.slice(1));
      cur.segments = oldSegments;
      next.segments = newSegments;
    }
  }
  return diff;
}

/**
 * A unified diff's text as diff lines: hunk headers kept, file headers (diff --git, index, ---, +++)
 * dropped, "\ No newline" kept as a header.
 * @param {string} [diffText]
 * @returns {DiffLine[]}
 */
export function parseUnifiedDiff(diffText) {
  if (!diffText) return [];
  /** @type {DiffLine[]} */
  const diff = [];
  // Lines the current hunk still holds, from its header's counts: inside a hunk, "--- x" is a
  // removed "-- x" (a SQL comment, say), not a file header.
  let oldLeft = 0, newLeft = 0;
  for (const line of splitLines(String(diffText))) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!line.length) { diff.push({ type: "context", content: line }); if (inHunk) { oldLeft--; newLeft--; } continue; }
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      oldLeft = m ? Number(m[1] ?? 1) : 0; newLeft = m ? Number(m[2] ?? 1) : 0;
      diff.push({ type: "header", content: line });
      continue;
    }
    if (line.startsWith("+")) { if (inHunk || !line.startsWith("+++")) diff.push({ type: "add", content: line }); newLeft--; continue; }
    if (line.startsWith("-")) { if (inHunk || !line.startsWith("---")) diff.push({ type: "remove", content: line }); oldLeft--; continue; }
    if (line.startsWith(" ")) { oldLeft--; newLeft--; }
    if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("\\ No newline")) { diff.push({ type: "header", content: line }); continue; }
    diff.push({ type: "context", content: line });
  }
  return diff;
}

/** The true minus sign; counts never use the hyphen. */
export const MINUS = "−";

/**
 * Added and removed line counts of diff lines (headers and context not counted).
 * @param {DiffLine[]} lines @returns {{ added: number, removed: number }}
 */
export function countLines(lines) {
  let added = 0, removed = 0;
  for (const l of lines || []) { if (l.type === "add") added++; else if (l.type === "remove") removed++; }
  return { added, removed };
}

/**
 * Counts the way every surface prints them beside the path: "+12 −4", "+60" for a new file,
 * "−3" when only lines went. Neutral text; the colour is the caller's (--text-2, never a hue).
 * @param {{ added: number, removed: number }} c @returns {string}
 */
export function formatCounts({ added, removed }) {
  const parts = [];
  if (added || !removed) parts.push(`+${added || 0}`);
  if (removed) parts.push(`${MINUS}${removed}`);
  return parts.join(" ");
}

/**
 * The inline variant's cut: the first `cap` lines (headers not counted) and how many lines the
 * whole diff has, for "Show all N lines". Nothing hidden when the diff fits.
 * @param {DiffLine[]} lines @param {number} [cap]
 * @returns {{ shown: DiffLine[], total: number, hidden: number }}
 */
export function capLines(lines, cap = 20) {
  const all = lines || [];
  const total = all.filter(l => l.type !== "header").length;
  if (!(cap > 0) || total <= cap) return { shown: all, total, hidden: 0 };
  let seen = 0, k = 0;
  for (; k < all.length && seen < cap; k++) if (all[k].type !== "header") seen++;
  return { shown: all.slice(0, k), total, hidden: total - cap };
}

/** The ghost button's words: "Show all 64 lines". @param {number} total */
export const showAllLabel = total => `Show all ${Number(total).toLocaleString("en-US")} lines`;
