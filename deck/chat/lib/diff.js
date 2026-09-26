// @ts-check
// Word-level diff for showing what changed: a Gate item's draft vs. what the user actually sent,
// or a file edit's before vs. after. Same LCS-over-words shape as core/gate/gate.js's `diff`, but
// where that one only needs the removed/added snippets for a one-line memory note, this one
// reconstructs the whole sequence — equal runs included — so it can be rendered inline. Pure:
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
