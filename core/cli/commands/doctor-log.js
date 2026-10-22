// @ts-check
// What `vyre doctor` says about the server log: for the last 24 hours, the errors, the warnings by kind, the calls that took over 2 s, the retries and the module restarts, in plain words.
// The lead pastes it into every release note, so it is one fixed shape. Pure: `summarize` takes the log's lines, `readLog` reads the day files of a logs folder.

import fs from "node:fs";
import path from "node:path";

export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** A call slower than this is listed (the daemon logs it as "warn: slow call <tool> took <n> ms"). */
export const SLOW_MS = 2000;

/** Up to `n` entries of a count map, most first, as "kind: count". @param {Map<string, number>} m @param {number} [n] */
const top = (m, n = 8) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
/** @param {Map<string, number>} m @param {string} k */
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

/**
 * The kind of a warning: the module tag when it has one ("warn: [mail] ..." is mail), else its first two words.
 * @param {string} text what follows "warn: "
 */
export function kindOf(text) {
  const tag = /^\[([^\]]+)\]/.exec(text);
  if (tag) return tag[1];
  const mod = /^module (\S+)/.exec(text);
  if (mod) return `module ${mod[1]}`;
  return text.split(/\s+/).slice(0, 2).join(" ").replace(/[:,;]+$/, "") || "other";
}

/**
 * Count what a log says over a window.
 * @param {string[]} lines each "<ISO time> <message>"
 * @param {number} [now] @param {number} [windowMs]
 * @returns {{ from: string, to: string, lines: number, errors: number, errorKinds: [string, number][], warnings: number, warningKinds: [string, number][], slow: { tool: string, ms: number }[], retries: number, restarts: number, starts: number, restarted: [string, number][] }}
 */
export function summarize(lines, now = Date.now(), windowMs = WINDOW_MS) {
  const since = now - windowMs;
  const errorKinds = new Map(), warningKinds = new Map(), runs = new Map();
  let errors = 0, warnings = 0, retries = 0, starts = 0, seen = 0;
  /** @type {{ tool: string, ms: number }[]} */ const slow = [];
  /** @type {{ at: number, text: string }[]} */
  const kept = [];
  /** @type {number | null} */ let upAt = null;
  for (const line of lines) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!(at >= since && at <= now)) continue;
    seen++;
    kept.push({ at, text: m[2] });
    // Warmup is everything at or before the latest "vyred <version> up" line. A server that never came up has no such line, so nothing is hidden.
    if (/^vyred \S+ up /.test(m[2]) && (upAt === null || at >= upAt)) upAt = at;
  }
  for (const { at, text } of kept) {
    const warmed = upAt === null || at > upAt;
    const s = /^warn: slow call (\S+) took (\d+) ms/.exec(text);
    if (s) { if (warmed) slow.push({ tool: s[1], ms: Number(s[2]) }); continue; }
    const run = /^module (\S+) \S+ running/.exec(text);
    if (run) bump(runs, run[1]);
    if (/^vyred \S+ up /.test(text)) starts++;
    if (warmed && /\b(retry|retrying|trying again)\b/i.test(text)) retries++;
    if (/^error: /.test(text) || /^module \S+ failed to start/.test(text)) { errors++; bump(errorKinds, kindOf(text.replace(/^error: /, ""))); }
    else if (/^warn: /.test(text)) { warnings++; bump(warningKinds, kindOf(text.slice(6))); }
  }
  // A module that started more often than vyred did was started again on its own.
  const restarted = new Map();
  for (const [name, n] of runs) if (n > Math.max(starts, 1)) restarted.set(name, n - Math.max(starts, 1));
  const restarts = [...restarted.values()].reduce((a, b) => a + b, 0);
  return { from: new Date(since).toISOString(), to: new Date(now).toISOString(), lines: seen, errors, errorKinds: top(errorKinds), warnings, warningKinds: top(warningKinds), slow, retries, restarts, starts, restarted: top(restarted) };
}

/**
 * The log's lines for the window: today's file and the days before it that reach into it.
 * @param {string} dir the logs folder (YYYY-MM-DD.log files) @param {number} [now] @param {number} [windowMs]
 * @returns {string[] | null} null when there is no log folder
 */
export function readLog(dir, now = Date.now(), windowMs = WINDOW_MS) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const day = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);
  const first = day(now - windowMs), last = day(now);
  const out = [];
  for (const n of names.sort()) {
    const d = /^(\d{4}-\d\d-\d\d)\.log$/.exec(n);
    if (!d || d[1] < first || d[1] > last) continue;
    try { out.push(...fs.readFileSync(path.join(dir, n), "utf8").split("\n")); } catch { /* a file that went away is no lines */ }
  }
  return out;
}

/** The summary as plain lines, the same shape every time. @param {ReturnType<typeof summarize>} r */
export function logLines(r) {
  const kinds = (/** @type {[string, number][]} */ list) => (list.length ? ` (${list.map(([k, n]) => `${k}: ${n}`).join(", ")})` : "");
  const slowest = [...r.slow].sort((a, b) => b.ms - a.ms).slice(0, 5);
  return [
    `Server log, last 24 h (${r.lines} lines, vyred started ${r.starts} time${r.starts === 1 ? "" : "s"})`,
    `  errors: ${r.errors}${kinds(r.errorKinds)}`,
    `  warnings: ${r.warnings}${kinds(r.warningKinds)}`,
    `  slow calls over ${SLOW_MS / 1000} s: ${r.slow.length}${slowest.length ? ` (${slowest.map(x => `${x.tool} ${x.ms} ms`).join(", ")})` : ""}`,
    `  retries: ${r.retries}`,
    `  module restarts: ${r.restarts}${kinds(r.restarted)}`,
  ];
}
