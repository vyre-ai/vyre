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
  for (const line of splitLines(String(diffText))) {
    if (!line.length) { diff.push({ type: "context", content: line }); continue; }
    if (line.startsWith("@@")) { diff.push({ type: "header", content: line }); continue; }
    if (line.startsWith("+")) { if (!line.startsWith("+++")) diff.push({ type: "add", content: line }); continue; }
    if (line.startsWith("-")) { if (!line.startsWith("---")) diff.push({ type: "remove", content: line }); continue; }
    if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("\\ No newline")) { diff.push({ type: "header", content: line }); continue; }
    diff.push({ type: "context", content: line });
  }
  return diff;
}
