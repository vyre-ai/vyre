// @ts-check
// changes: a permission ask's diff summary, the "Changes" row a card shows. Per file, how many
// lines are added and removed, plus totals.
//
// Two sources. An Edit, MultiEdit or Write carries its change in the input, so the counts come
// from a line diff of the full strings (before they are capped for display), and a Write is
// compared with the file on disk. A `git push` carries only a command, so the counts come from
// `git diff --numstat` over what the push would send, run in the thread's folder with no shell,
// no prompt, no network and a 3 s budget. Only counts and paths leave here, never content.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clip, CAPS } from "./translate.js";
import { gitAsync } from "../../lib/git-safe.js";

/** Past this many lines on either side (after the common ends are trimmed), count all removed and all added. */
export const DIFF_LINES = 2000;
/** A Write over a file bigger than this counts its content as all added. */
export const READ_BYTES = 1024 * 1024;
/** Rows kept for a push; totals still cover every file. */
export const MAX_ROWS = 200;
/** The whole budget for the git commands behind one push ask. */
export const GIT_MS = 3000;

/**
 * Lines the way git counts them: a trailing newline ends the last line rather than starting an
 * empty one, and a last line without one differs from the same line with one. A fragment (an
 * Edit's old or new string) is part of a file, so its last line gets no such marker.
 * @param {unknown} s @param {boolean} [fragment]
 */
export function lines(s, fragment = false) {
  const t = typeof s === "string" ? s : "";
  if (t === "") return [];
  const ls = t.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  else if (!fragment) ls[ls.length - 1] += "\0no newline";
  return ls;
}

/**
 * Added and removed line counts between two texts: an LCS over lines, bounded.
 * @param {unknown} before @param {unknown} after @param {boolean} [fragment] both are parts of a file, not whole files
 * @returns {{ added: number, removed: number }}
 */
export function countDiff(before, after, fragment = false) {
  const a = lines(before, fragment), b = lines(after, fragment);
  let s = 0, ea = a.length, eb = b.length;
  while (s < ea && s < eb && a[s] === b[s]) s++;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (n === 0 || m === 0) return { added: m, removed: n };
  if (n > DIFF_LINES || m > DIFF_LINES) return { added: m, removed: n };
  // Two rows of the LCS table, the shorter side across.
  const [x, xs, y, ys] = n <= m ? [a, s, b, s] : [b, s, a, s];
  const w = Math.min(n, m), h = Math.max(n, m);
  let prev = new Uint32Array(w + 1), row = new Uint32Array(w + 1);
  for (let i = 1; i <= h; i++) {
    const yi = y[ys + i - 1];
    for (let j = 1; j <= w; j++) row[j] = x[xs + j - 1] === yi ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    [prev, row] = [row, prev];
  }
  const common = prev[w];
  return { added: m - common, removed: n - common };
}

/** @param {{ file: string, added: number|null, removed: number|null, binary?: boolean }[]} rows */
function totalsOf(rows) {
  let added = 0, removed = 0;
  for (const r of rows) { if (!r.binary) { added += r.added || 0; removed += r.removed || 0; } }
  return { files: rows.length, added, removed };
}

/**
 * The diff summary of an Edit, MultiEdit or Write ask, or null for any other tool.
 * @param {string} tool @param {Record<string, any>} input @param {string} [cwd] where a relative Write path is read from
 * @returns {{ changes: { file: string, added: number, removed: number }[], totals: { files: number, added: number, removed: number } }|null}
 */
export function editChanges(tool, input, cwd) {
  const i = input || {};
  if (typeof i.file_path !== "string" || i.file_path === "") return null;
  let c;
  if (tool === "Edit") c = countDiff(i.old_string, i.new_string, true);
  else if (tool === "MultiEdit") {
    c = { added: 0, removed: 0 };
    for (const e of Array.isArray(i.edits) ? i.edits : []) {
      const d = countDiff(e && e.old_string, e && e.new_string, true);
      c.added += d.added; c.removed += d.removed;
    }
  } else if (tool === "Write") {
    const now = current(cwd ? path.resolve(cwd, i.file_path) : i.file_path);
    c = now === null ? { added: lines(i.content).length, removed: 0 } : countDiff(now, i.content);
  } else return null;
  const rows = [{ file: clip(i.file_path, CAPS.detail), ...c }];
  return { changes: rows, totals: totalsOf(rows) };
}

/** A file's text, when it is a readable file under READ_BYTES; else null. */
function current(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > READ_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch { return null; }
}

// ------------------------------------------------------------ git push

/**
 * Split a command line into segments of words, the way a shell would for simple commands.
 * Null when it holds anything this cannot read with certainty: command substitution, an
 * unclosed quote, a heredoc, a subshell or a brace group.
 * @param {string} cmd
 * @returns {{ words: string[], op: string|null }[]|null} each segment and the operator after it
 */
function segments(cmd) {
  if (/`|\$\(|<<|\$\{/.test(cmd)) return null;
  /** @type {{ words: string[], op: string|null }[]} */
  const out = [];
  let words = [], word = "", has = false, q = "";
  const endWord = () => { if (has) words.push(word); word = ""; has = false; };
  const endSeg = op => { endWord(); out.push({ words, op }); words = []; };
  for (let k = 0; k < cmd.length; k++) {
    const ch = cmd[k];
    if (q === "'") { if (ch === "'") q = ""; else word += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = "";
      else if (ch === "\\" && k + 1 < cmd.length && '"\\$'.includes(cmd[k + 1])) word += cmd[++k];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === "\\") { if (k + 1 < cmd.length && cmd[k + 1] !== "\n") { word += cmd[++k]; has = true; } else k++; continue; }
    if (ch === " " || ch === "\t") { endWord(); continue; }
    if (ch === "\n" || ch === ";") { endSeg(";"); continue; }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") { if (!has && (ch === "(" || ch === ")")) return null; word += ch; has = true; continue; }
    if (ch === "&" || ch === "|") {
      // 2>&1, >&2: part of a redirect, not an operator.
      if (ch === "&" && (word.endsWith(">") || word.endsWith("<"))) { word += ch; has = true; continue; }
      const two = cmd[k + 1] === ch;
      endSeg(two ? ch + ch : ch);
      if (two) k++;
      continue;
    }
    word += ch; has = true;
  }
  if (q) return null;
  endSeg(null);
  return out.filter(s => s.words.length || s.op);
}

/** @param {string} p @param {string} base */
function resolveDir(p, base) {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  if (p.startsWith("~")) return null;
  if (/[*?[$]/.test(p)) return null;
  return path.resolve(base, p);
}

/**
 * Where a Bash command pushes from, when it is plainly a `git push`: the folder git would run
 * in (`git -C <dir>` and a `cd <dir> &&` before it are followed). Null for anything else,
 * including a command with two pushes or a push whose folder cannot be read with certainty.
 * @param {unknown} command @param {string} cwd
 * @returns {string|null}
 */
export function pushDir(command, cwd) {
  if (typeof command !== "string" || !/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return null;
  const segs = segments(command);
  if (!segs) return null;
  let dir = cwd, found = /** @type {string|null} */ (null), pushes = 0;
  let prevOp = /** @type {string|null} */ (null);
  for (const { words, op } of segs) {
    let w = words.slice();
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();       // FOO=bar git push
    if (w[0] === "command" || w[0] === "exec") w.shift();
    // A cd changes where later commands run only when it is chained, not piped or backgrounded.
    if (w[0] === "cd") {
      if (prevOp === "|" || op === "|" || op === "&") { prevOp = op; continue; }
      if (w.length !== 2) return null;
      const d = resolveDir(w[1], dir);
      if (!d) return null;
      dir = d; prevOp = op; continue;
    }
    if (w[0] === "git") {
      let here = dir, k = 1, clear = true;
      while (k < w.length && w[k].startsWith("-")) {
        const o = w[k];
        if (o === "-C" && k + 1 < w.length) { const d = resolveDir(w[k + 1], here); if (!d) { clear = false; break; } here = d; k += 2; continue; }
        if (o === "-c" && k + 1 < w.length) { k += 2; continue; }
        if (o === "--no-pager" || o === "--no-replace-objects" || o === "--no-optional-locks" || o.startsWith("-c")) { k++; continue; }
        clear = false; break;                                                     // --git-dir, --work-tree, ...: not certain
      }
      if (w[k] === "push") {
        if (!clear) return null;
        pushes++; found = here;
      }
    }
    prevOp = op;
  }
  return pushes === 1 ? found : null;
}

/**
 * git, with no shell, no prompt, no pager, no network and a deadline.
 * @param {string} dir @param {string[]} args @param {number} deadline
 * @returns {Promise<string|null>} stdout, or null when it failed or ran out of time
 */
function git(dir, args, deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.resolve(null);
  return gitAsync(dir, args, { timeout: ms }).then(r => (r.ok ? r.stdout : null));
}

/**
 * `git diff --numstat -z` output as rows. A rename is one row under its new path; a binary file
 * has null counts and `binary: true`.
 * @param {string} out
 */
export function parseNumstat(out) {
  /** @type {{ file: string, added: number|null, removed: number|null, binary?: boolean }[]} */
  const rows = [];
  const parts = out.split("\0");
  for (let k = 0; k < parts.length; k++) {
    const head = parts[k];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head.replace(/^\n+/, ""));
    if (!m) continue;
    let file = m[3];
    if (file === "") { k += 2; file = parts[k] || ""; }                            // rename: old\0new
    file = clip(file, 1000);
    const binary = m[1] === "-" || m[2] === "-";
    rows.push(binary ? { file, added: null, removed: null, binary: true } : { file, added: Number(m[1]), removed: Number(m[2]) });
  }
  return rows;
}

/**
 * What a push from `dir` would send, as rows and totals: @{push}..HEAD, else @{upstream}..HEAD,
 * else the merge-base with origin's default branch..HEAD. Null when none resolves, git fails or
 * the budget runs out.
 * @param {string} dir @param {number} [budgetMs]
 */
export async function pushChanges(dir, budgetMs = GIT_MS) {
  const deadline = Date.now() + budgetMs;
  let base = null;
  for (const ref of ["@{push}", "@{upstream}"]) {
    const out = await git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], deadline);
    if (out && out.trim()) { base = out.trim(); break; }
    if (Date.now() >= deadline) return null;
  }
  if (!base) {
    const out = await git(dir, ["merge-base", "refs/remotes/origin/HEAD", "HEAD"], deadline);
    if (out && out.trim()) base = out.trim();
  }
  if (!base) return null;
  const out = await git(dir, ["diff", "--numstat", "-z", "-M", "--no-color", "--no-ext-diff", "--no-textconv", `${base}..HEAD`, "--"], deadline);
  if (out === null) return null;
  const rows = parseNumstat(out);
  const totals = totalsOf(rows);
  return rows.length > MAX_ROWS ? { changes: rows.slice(0, MAX_ROWS), totals, truncated: true } : { changes: rows, totals };
}
