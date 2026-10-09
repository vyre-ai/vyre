// @ts-check
// signals: fingerprints for what Learning hears (ADR 0007, decision 6). Pure, apart from hashing
// a file, which reads at most 256 KB.
//
// A signal is { kind, session, seq, project, agent, key, lesson?, meta }. `key` fingerprints what
// it is about, so repeats can be counted across sessions: the same correction said twice, the
// same command declined three times, the same file reverted in two sessions. Keys are short
// hashes; meta is small and never holds whole content (a command's shape, a tool's name, a count).

import crypto from "node:crypto";
import fs from "node:fs";
import { TESTS, notARule } from "./checks.js";
import { shapeOf } from "./skills.js";

/** Files larger than this are not hashed: a revert of one is not worth reading it twice a turn. */
export const MAX_HASHED = 256 * 1024;
/** Tools whose PostToolUse (or PostToolUseFailure) the Harness passes on, so a missing one means no. */
export const TRACKED = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

export { isVyreTool, vyreSteps } from "../../lib/vyre-steps.js";
export const WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const short = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Words that carry no meaning of their own in a correction. */
const STOP = new Set(("a an the to of in on for and or but so it its this that these those is are be was were am i you we me my your our " +
  "please just again ever never always don't dont do not stop no more any every from now whenever each time use using with " +
  "should shouldn't must can could would will have has had here there what when then than as at by").split(" "));

/** A correction's words, order and filler dropped: the same thing said twice has one key. */
export function wordsKey(text) {
  const words = String(text || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)
    .filter(w => w && !STOP.has(w) && w.length > 1);
  const set = [...new Set(words)].sort();
  return set.length ? "p:" + short(set.join(" ")) : null;
}

/** The key of what a prompt said: its check when it has one, else its words. */
export function promptKey(d, prompt) {
  if (d && d.check) return "c:" + short(JSON.stringify(d.check));
  return wordsKey(d ? d.rule : prompt);
}

/** The key of a lesson: its check, or its rule's words. */
export const lessonKey = l => (l.check ? "c:" + short(JSON.stringify(l.check)) : wordsKey(l.rule));

/** A shell command's key, by its shape. */
export const commandKey = shape => "cmd:" + short(String(shape || ""));
/** A tool's key, by its name. */
export const toolKey = tool => "tool:" + String(tool || "");
/** A file's key, by its path. */
export const fileKey = file => "file:" + short(String(file || ""));

/**
 * A correction that fits no shape, said plainly at the start: "stop adding comments everywhere".
 * "Stop" and "quit" need a habit after them ("stop adding"): "stop the server" is a task. A
 * question or an instruction for now ("don't push yet") is not a correction.
 */
export function softCorrection(prompt) {
  const t = String(prompt || "").trim();
  if (!t || t.length > 200 || t.startsWith("/") || notARule(t)) return false;
  if (/^(?:no[,.!]?\s+)?(?:please\s+)?(?:don'?t|do not)\s+(?:worry|bother|mind|forget)\b/i.test(t)) return false;
  return /^(?:no[,.!]?\s+)?(?:please\s+)?(?:(?:don'?t|do not|no longer|avoid)\b|(?:stop|quit)\s+[a-z]+ing\b)/i.test(t);
}

/** Is this command a test run? */
export const isTest = command => new RegExp(TESTS, "i").test(String(command || ""));

/** A command's shape, for keys and meta (never the command itself). */
export const shape = command => shapeOf(String(command || ""));

/**
 * A file as Learning compares it: its hash, mtime and size, "none" when it does not exist, or
 * null when it is too big or cannot be read. Hashes only; the content is never kept.
 * @param {string} file
 * @returns {{ hash: string, mtime: number, size: number } | null}
 */
export function fileState(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { hash: "none", mtime: 0, size: -1 }; }
  if (!st.isFile() || st.size > MAX_HASHED) return null;
  try { return { hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), mtime: Math.trunc(st.mtimeMs), size: st.size }; } catch { return null; }
}

/** Only mtime and size, for the cheap "did it change at all" test before hashing. */
export function fileStat(file) {
  try { const st = fs.statSync(file); return { mtime: Math.trunc(st.mtimeMs), size: st.size }; } catch { return { mtime: 0, size: -1 }; }
}

/** The day a time falls on, in UTC, as YYYY-MM-DD. */
export const dayOf = at => new Date(at).toISOString().slice(0, 10);
