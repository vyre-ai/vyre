// @ts-check
// Word-level diff for showing what changed: a Gate item's draft vs. what the user actually sent,
// or a file edit's before vs. after. Same LCS-over-words shape as core/gate/gate.js's `diff`, but
// where that one only needs the removed/added snippets for a one-line memory note, this one
// reconstructs the whole sequence, equal runs included, so it can be rendered inline. Pure:
// two strings in, one DOM node out.

import { h, add } from "../../js/dom.js";

const MAX_TOKENS = 4000; // above this, diffing word-by-word is wasted work; show whole blocks instead

/**
 * @param {string} before
 * @param {string} after
 * @returns {HTMLElement}
 */
export function renderDiff(before, after) {
  const a = before == null ? "" : String(before);
  const b = after == null ? "" : String(after);
  const el = h("span", { class: "diff" });
  if (a === b) { add(el, a); return el; }

  const xs = tokenize(a), ys = tokenize(b);
  const segs = xs.length > MAX_TOKENS || ys.length > MAX_TOKENS
    ? [{ type: "removed", text: a }, { type: "added", text: b }]
    : diffTokens(xs, ys);

  for (const s of segs) {
    if (!s.text) continue;
    if (s.type === "equal") add(el, s.text);
    else if (s.type === "removed") add(el, h("del", { class: "diff-del" }, s.text));
    else add(el, h("ins", { class: "diff-ins" }, s.text));
  }
  return el;
}

/** Words and the whitespace between them, both as tokens, so spacing survives the diff untouched. */
const tokenize = s => s.match(/\S+|\s+/g) || [];

/** LCS over tokens, then walked back into ordered equal/removed/added runs. */
function diffTokens(xs, ys) {
  const n = xs.length, m = ys.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);

  const out = [];
  const push = (type, text) => { const last = out[out.length - 1]; if (last && last.type === type) last.text += text; else out.push({ type, text }); };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { push("equal", xs[i]); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { push("added", ys[j]); j++; }
    else { push("removed", xs[i]); i++; }
  }
  return out;
}

// ---- a unified, line-level diff (a file edit: Edit/MultiEdit's old_string vs new_string) ----

const MAX_LINES = 2000; // past this, the whole old block removed and the whole new block added

/** @typedef {{ type: " "|"-"|"+", text: string, n: number|null }} DiffRow n: the line number (old for "-", new otherwise), null when unknown */

/**
 * Line-level LCS: ordered rows, the way `diff -u` prints a hunk. With starts, each row carries its
 * line number (a removed line its old number, the rest their new one).
 * @param {string} before @param {string} after
 * @param {{ oldStart?: number|null, newStart?: number|null }} [at]
 * @returns {DiffRow[]}
 */
export function lineDiff(before, after, at = {}) {
  const xs = before == null || before === "" ? [] : String(before).split("\n");
  const ys = after == null || after === "" ? [] : String(after).split("\n");
  /** @type {{ type: " "|"-"|"+", text: string }[]} */
  let rows;
  if (xs.length > MAX_LINES || ys.length > MAX_LINES) rows = [...xs.map(text => ({ type: /** @type {"-"} */ ("-"), text })), ...ys.map(text => ({ type: /** @type {"+"} */ ("+"), text }))];
  else {
    const n = xs.length, m = ys.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    rows = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) { rows.push({ type: " ", text: xs[i] }); i++; j++; }
      else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) { rows.push({ type: "-", text: xs[i] }); i++; }
      else { rows.push({ type: "+", text: ys[j] }); j++; }
    }
  }
  return number(rows, at.oldStart ?? null, at.newStart ?? null);
}

/** Line numbers onto rows, from where the old and new sides start (null: unknown, left blank). */
function number(rows, oldStart, newStart) {
  let o = oldStart, nw = newStart;
  return rows.map(r => {
    const n = r.type === "-" ? o : nw;
    if (r.type !== "+" && o != null) o++;
    if (r.type !== "-" && nw != null) nw++;
    return { ...r, n };
  });
}

/**
 * A structured patch (Claude Code's toolUseResult.structuredPatch: hunks of " ", "-", "+" lines)
 * as rows, a hunk header between hunks.
 * @param {{ oldStart: number, newStart: number, lines: string[] }[]} hunks
 * @returns {(DiffRow | { type: "@", text: string, n: null })[]}
 */
export function patchRows(hunks) {
  const out = [];
  (hunks || []).forEach((hk, i) => {
    if (i > 0 || hk.oldStart > 1) out.push({ type: /** @type {"@"} */ ("@"), text: `@@ -${hk.oldStart} +${hk.newStart} @@`, n: null });
    const rows = (hk.lines || []).map(l => ({ type: /** @type {" "|"-"|"+"} */ (l[0] === "-" || l[0] === "+" ? l[0] : " "), text: l.slice(1) }));
    out.push(...number(rows, hk.oldStart, hk.newStart));
  });
  return out;
}

/**
 * Rows as DOM: a grid of line number, sign and code per line. Added lines on the signal wash,
 * removed ones on the ash wash, struck through.
 * @param {any[]} rows from lineDiff or patchRows
 * @returns {HTMLElement}
 */
export function renderRows(rows) {
  const el = h("div", { class: "cv-diff" });
  for (const r of rows) {
    if (r.type === "@") { add(el, h("div", { class: "cv-dl cv-dl-hunk" }, h("span", { class: "cv-dl-n" }), h("span", { class: "cv-dl-g" }), h("span", { class: "cv-dl-t" }, r.text))); continue; }
    add(el, h("div", { class: "cv-dl" + (r.type === "-" ? " cv-dl-del" : r.type === "+" ? " cv-dl-add" : "") },
      h("span", { class: "cv-dl-n" }, r.n == null ? "" : String(r.n)),
      h("span", { class: "cv-dl-g" }, r.type === " " ? "" : r.type),
      h("span", { class: "cv-dl-t" }, r.text || " ")));
  }
  return el;
}

/**
 * A unified diff of two strings as DOM.
 * @param {string} before @param {string} after
 * @param {{ oldStart?: number|null, newStart?: number|null }} [at]
 * @returns {HTMLElement}
 */
export function renderUnified(before, after, at) { return renderRows(lineDiff(before, after, at)); }
