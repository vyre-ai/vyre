// @ts-check
// usage (Claude's adapter) — how full a Claude Code session's window is, read from its transcript, for the warning a person's own terminal session gets (team/0.2.5/memory-context.md, 4b).
//
// A session Vyre runs rolls itself (core/switchboard/rollover.js). One the person runs in their own terminal cannot be stopped from outside, so Vyre tells them, once, when the
// window passes the line, and `vyre roll` is the way on. The count is exact for the last request: each assistant line of the transcript carries its token usage.

import fs from "node:fs";
import path from "node:path";
import { windowFor } from "../windows.js";

/**
 * The last assistant request's tokens in the window, and the model that made it, from the end of a transcript. Null when there is none (a new session, an unreadable file).
 * @param {string} file @param {number} [bytes] how much of the end to read
 * @returns {{ used: number, model: string|null }|null}
 */
export function lastUsage(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift();                                   // the first line may be cut
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const m = o && o.type === "assistant" && !o.isSidechain ? o.message : null;
      const u = m && m.usage;
      if (!u || typeof u !== "object") continue;
      const n = (/** @type {unknown} */ v) => (typeof v === "number" && v >= 0 ? v : 0);
      const used = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
      if (used > 0) return { used, model: typeof m.model === "string" && m.model && !m.model.startsWith("<") ? m.model : null };
    }
  } catch { /* no transcript is no meter */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/**
 * Whether the person's Claude Code is set to a 1M-token model (`model: "opus[1m]"` in its settings, or ANTHROPIC_MODEL): a transcript names the model without the tag.
 * @param {string} claudeHome the folder Claude Code keeps its settings in (~/.claude) @param {Record<string, string|undefined>} [env]
 */
export function wantsMillion(claudeHome, env = process.env) {
  if (/1m/i.test(String(env.ANTHROPIC_MODEL || ""))) return true;
  for (const f of ["settings.json", "settings.local.json"]) {
    try { if (/1m/i.test(String(JSON.parse(fs.readFileSync(path.join(claudeHome, f), "utf8")).model || ""))) return true; } catch { /* none */ }
  }
  return false;
}

/**
 * How full the window is. A session using more than its model's window (a 1M-token model the transcript does not say) has a bigger one than the name says.
 * @param {string} file @param {{ million?: boolean }} [o]
 * @returns {{ used: number, window: number, share: number, model: string|null }|null}
 */
export function meterOf(file, { million = false } = {}) {
  const u = lastUsage(file);
  if (!u) return null;
  let window = million ? 1_000_000 : windowFor(u.model, "claude");
  if (u.used > window) window = 1_000_000;
  return { used: u.used, window, share: u.used / window, model: u.model };
}

/** @param {number} n */
const k = n => `${Math.round(n / 1000).toLocaleString("en-US")},000`;

/**
 * The line a person reads once, when the window passes the line.
 * @param {{ used: number, window: number, share: number }} m
 */
export function warning(m) {
  return `This session's window is ${Math.round(m.share * 100)}% full (about ${k(m.used)} of ${k(m.window)} tokens). Before it compacts and loses lines: type /exit, then run \`vyre roll\` in this folder. `
    + "It continues in a fresh window with your decisions, an index of what came before and the last turns word for word, and every earlier turn stays searchable.";
}
