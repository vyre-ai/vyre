// @ts-check
// A line diff for "Show changes": what a version changed against the one before it. Plain LCS on lines, with the common start and end trimmed first, and a cap so a huge change is shown as one block
// replaced instead of costing a second. Pure.

/** @typedef {{ t: "eq" | "add" | "del", line: string }} DiffOp */

const CAP = 4_000_000;

/** @param {string} text */
export const linesOf = text => { const t = String(text ?? "").replace(/\r\n/g, "\n"); return t === "" ? [] : t.endsWith("\n") ? t.slice(0, -1).split("\n") : t.split("\n"); };

/** @param {string} before @param {string} after @returns {DiffOp[]} */
export function lineDiff(before, after) {
  const a = linesOf(before), b = linesOf(after);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const ma = a.slice(s, a.length - e), mb = b.slice(s, b.length - e);
  /** @type {DiffOp[]} */ const out = a.slice(0, s).map(line => ({ t: "eq", line }));
  if (ma.length * mb.length > CAP) {
    for (const line of ma) out.push({ t: "del", line });
    for (const line of mb) out.push({ t: "add", line });
  } else {
    const n = ma.length, m = mb.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = ma[i] === mb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { out.push({ t: "eq", line: ma[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "del", line: ma[i++] });
      else out.push({ t: "add", line: mb[j++] });
    }
    while (i < n) out.push({ t: "del", line: ma[i++] });
    while (j < m) out.push({ t: "add", line: mb[j++] });
  }
  for (const line of a.slice(a.length - e)) out.push({ t: "eq", line });
  return out;
}

/** @param {DiffOp[]} ops */
export const diffStats = ops => ({ add: ops.filter(o => o.t === "add").length, del: ops.filter(o => o.t === "del").length });

/** The changed lines with `context` lines around each, and a gap marker between far apart changes. @param {DiffOp[]} ops @param {number} [context] */
export function hunks(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== "eq") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true; });
  /** @type {(DiffOp | { t: "gap", skipped: number })[]} */ const out = [];
  let skipped = 0;
  ops.forEach((o, i) => { if (keep[i]) { if (skipped) out.push({ t: "gap", skipped }); skipped = 0; out.push(o); } else skipped++; });
  if (skipped && out.length) out.push({ t: "gap", skipped });
  return out;
}
