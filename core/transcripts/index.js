// @ts-check
// transcripts — the ONE place in Vyre that reads Claude Code's transcript files.
//
// Vyre touches Claude Code only through public surfaces, with this as the single exception
// (docs/SPEC.md, principle 1). The file format is not a published contract and can change under
// us, so everything about it lives here, and every failure degrades to "no history" rather than
// an error: a missing folder is an empty list, an unreadable file is skipped, a bad line costs
// that line. Recall imports this; nothing else should.
//
// Claude Code lays transcripts out as
//   <folder>/<encoded cwd>/<session id>.jsonl                           a session
//   <folder>/<encoded cwd>/<session id>/subagents/agent-<id>.jsonl      a subagent it ran
// and a subagent's Vyre id is "<session id>/agent-<id>", because every line in it carries the
// PARENT's sessionId and the file name is the only thing that tells two subagents apart.
//
// Text leaves this file redacted. Nothing downstream ever sees a credential someone pasted.

import fs from "node:fs";
import path from "node:path";
import { redact } from "./sanitize.js";

export { redact, scan } from "./sanitize.js";

/** Long tool output is noise in a search index; a turn keeps its first 4,000 characters. */
export const CLIP = 4000;

/**
 * @typedef {{ id: string, file: string, parent: string|null, size: number, mtime: number }} Entry
 * @typedef {{ seq: number, role: "user"|"assistant", ts: number, text: string }} Turn
 * @typedef {{ id: string, file: string, cwd: string|null, name: string|null, title: string|null,
 *   started: number, ended: number, human: number, parent: string|null, turns: Turn[], redacted: number, bad: number }} Transcript
 */

/**
 * Every transcript under the given folders, one entry per session id.
 *
 * Resuming a session from another directory, or archiving a folder, leaves more than one file
 * with the same id. Taking whichever readdir yields first made two files take turns being "the"
 * session, each one looking changed against the other on every pass, so the fullest copy wins,
 * deterministically: appending to the fullest is the only choice that cannot lose turns.
 * @param {string[]} folders
 * @returns {Entry[]}
 */
export function list(folders) {
  /** @type {Map<string, Entry>} */
  const byId = new Map();
  const add = (/** @type {string} */ id, /** @type {string} */ file, /** @type {string|null} */ parent) => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (!st.isFile()) return;
    const e = { id, file, parent, size: st.size, mtime: Math.floor(st.mtimeMs) };
    const prev = byId.get(id);
    if (!prev || e.size > prev.size || (e.size === prev.size && e.file < prev.file)) byId.set(id, e);
  };
  for (const folder of folders) {
    for (const project of readdir(folder)) {
      if (!project.isDirectory()) continue;
      const dir = path.join(folder, project.name);
      for (const e of readdir(dir)) {
        if (e.name.endsWith(".jsonl")) add(e.name.slice(0, -6), path.join(dir, e.name), null);
        else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, "subagents");
          for (const a of readdir(sub)) {
            if (a.name.endsWith(".jsonl")) add(`${e.name}/${a.name.slice(0, -6)}`, path.join(sub, a.name), e.name);
          }
        }
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** @param {string} dir */
function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * The text of one line, if it is a turn: what a person typed, or what Claude wrote back.
 *
 * Tool traffic is not a turn. An assistant line holding only a tool_use, or a user line holding
 * only a tool_result, has no text of its own; Claude Code writes each content block of a reply
 * as its own line, so a reply's text arrives on a line of its own and is kept. Lines Claude Code
 * adds on the user's behalf (isMeta) are not something anyone said.
 * @param {any} o
 * @returns {{ role: "user"|"assistant", text: string } | null}
 */
export function turnOf(o) {
  if (!o || (o.type !== "user" && o.type !== "assistant") || o.isMeta) return null;
  const m = o.message;
  if (!m || typeof m !== "object") return null;
  const role = m.role === "assistant" || o.type === "assistant" ? "assistant" : "user";
  const c = m.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.filter(p => p && p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
  text = text.trim();
  return text ? { role, text } : null;
}

/**
 * Read one transcript into what Recall indexes. Never throws: an unreadable file is null, and a
 * line that is not JSON (a live session's last line is often half written) is counted and
 * skipped.
 *
 * - seq counts turns with text, from 0, in file order. It is the turn's identity.
 * - name is the LAST custom-title. Claude Code writes one again on every resume (one real
 *   session carried 12,454 copies), so the first one froze a session at its oldest name.
 * - cwd comes from the lines. The folder name cannot be decoded: "a-b" and "a/b" encode alike.
 * - human is 0 when a program started it: a subagent (isSidechain) or an SDK run.
 * @param {string} file
 * @param {{ id?: string, parent?: string|null }} [who]
 * @returns {Transcript | null}
 */
export function read(file, who = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const id = who.id ?? path.basename(file, ".jsonl");
  /** @type {Transcript} */
  const t = { id, file, cwd: null, name: null, title: null, started: 0, ended: 0, human: 1,
    parent: who.parent ?? null, turns: [], redacted: 0, bad: 0 };
  let program = null;
  // Line by line over the bytes rather than one giant string: a runaway transcript can be
  // hundreds of megabytes, and one string that size is the thing that falls over.
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    const line = buf.toString("utf8", start, end);
    start = end + 1;
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { t.bad++; continue; }
    if (!o || typeof o !== "object") continue;
    if (o.type === "custom-title") {
      if (typeof o.customTitle === "string" && o.customTitle.trim()) t.name = redact(o.customTitle.trim().slice(0, 120)).text;
      continue;
    }
    if (t.cwd === null && typeof o.cwd === "string" && o.cwd) t.cwd = o.cwd;
    if (program === null && (o.isSidechain !== undefined || o.entrypoint !== undefined)) {
      program = o.isSidechain === true || /^sdk/.test(String(o.entrypoint || ""));
    }
    const ts = Date.parse(o.timestamp || "") || 0;
    if (ts) { if (!t.started || ts < t.started) t.started = ts; if (ts > t.ended) t.ended = ts; }
    const turn = turnOf(o);
    if (!turn) continue;
    const clean = redact(turn.text.length > CLIP ? turn.text.slice(0, CLIP) : turn.text);
    t.redacted += clean.hits.length;
    t.turns.push({ seq: t.turns.length, role: turn.role, ts, text: clean.text });
    // The first real thing the user typed is a better title than anything generated. Command
    // echoes and injected context start with a tag and are not what anyone would call it.
    if (t.title === null && turn.role === "user" && !clean.text.startsWith("<") && clean.text.length > 3) {
      t.title = clean.text.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  if (program || t.parent) t.human = 0;
  return t;
}
