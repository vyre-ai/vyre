// @ts-check
// adopt — type into a Claude Code session the Switchboard did not start.
//
// A session started in a terminal has a transcript and nothing else here. Sending to it from the
// Capsule or Chat means resuming it headless (`--resume`), which is safe only if no other process
// has it open: two writers on one transcript diverge the file, and the conversation is lost
// (floor rule 4). The lessons from the prototype's lease and claim:
//   - A session cannot be stopped from starting, so the check is at adoption, not in the terminal.
//   - Liveness is a positive signal that expires, never the absence of one. Here there are three,
//     any of which means "open somewhere": the session is bound (its SessionStart hook ran) to a
//     claude process that is still running and is not ours; a running claude names it in its
//     arguments (`claude --resume <id>`); or its transcript was written in the last ACTIVE_MS.
//   - When in doubt, refuse and say why: a refusal costs a click, a second writer costs the thread.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** A transcript written this recently belongs to a session that is still working somewhere. */
export const ACTIVE_MS = 30_000;
/** How long after our own child stopped its last transcript write may land. */
export const OUR_SLACK_MS = 2_000;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The transcript of a session, from the folders Claude Code keeps them in: `<folder>/<project>/<id>.jsonl`.
 * The biggest copy wins, as in core/transcripts. null when there is none.
 * @param {string[]} folders @param {string} id
 * @returns {{ file: string, mtime: number } | null}
 */
export function findSession(folders, id) {
  if (!SESSION_ID.test(id)) return null;
  let best = null;
  for (const folder of folders) {
    let dirs = [];
    try { dirs = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(folder, d.name, `${id}.jsonl`);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!best || st.size > best.size) best = { file, mtime: Math.floor(st.mtimeMs), size: st.size };
    }
  }
  return best && { file: best.file, mtime: best.mtime };
}

/**
 * Where a session's transcript is (the file that exists, wherever it sits) or will be (a new one under the first projects folder, in the folder named for `cwd`).
 * @param {string[]} folders @param {string} cwd @param {string} id @returns {{ file: string, root: string } | null}
 */
export function transcriptPlace(folders, cwd, id) {
  const known = findSession(folders, id);
  if (known) return { file: known.file, root: path.dirname(path.dirname(known.file)) };
  if (!SESSION_ID.test(id) || !folders[0] || !cwd) return null;
  return { file: path.join(folders[0], String(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`), root: folders[0] };
}

/** Where the provider keeps a session's transcript INSIDE a runner's workspace (the agent's home is `<work>/home`), for the folder `cwd` the session sees. @param {string} work @param {string} cwd @param {string} id */
export const workTranscript = (work, cwd, id) => path.join(work, "home", ".claude", "projects", String(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);

/**
 * The folder a session ran in and its name, from the start of its transcript (the first lines
 * carry cwd; the folder name cannot be decoded). Reads at most 512 KB.
 * @param {string} file
 */
export function sessionInfo(file) {
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString("utf8", 0, n);
  } catch { return { cwd: null, name: null }; }
  let cwd = null, name = null;
  for (const line of text.split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
    if (o.type === "custom-title" && typeof o.customTitle === "string") name = o.customTitle;
  }
  return { cwd, name };
}

/**
 * Does this command line open the session: a claude given it with --resume, -r or --session-id?
 * Naming the id is not enough. `vyre threads watch <id>` names it and only reads, and under a
 * folder with "claude" in its path it was taken for a second writer, so every resume after a
 * stop was refused for as long as the watch ran (found by scripts/stress-drive).
 * @param {string} cmd @param {string} id
 */
export function opensSession(cmd, id) {
  if (!/claude/i.test(cmd)) return false;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:--resume|-r|--session-id)(?:=|\\s+)${esc}(?:\\s|$)`).test(cmd);
}

/** Running claude processes that have this session open, other than ours. @param {string} id @param {number[]} ours */
export function claudesNaming(id, ours) {
  let out = "";
  try { out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); } catch { return []; }
  const pids = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !opensSession(m[2], id) || /\bps\b -ax/.test(m[2])) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && !ours.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * Is this session open anywhere but here? The first signal found, or null.
 * `ourLast` is when this Switchboard last saw the thread (its own child writes the transcript
 * too); a write no later than that, give or take OUR_SLACK_MS, was ours.
 * @param {{ id: string, mtime: number, boundPid: number|null, ours: number[], now?: number, ourLast?: number|null,
 *           alive: (pid: number) => boolean, naming?: (id: string, ours: number[]) => number[] }} o
 * @returns {string|null}
 */
export function openElsewhere(o) {
  if (o.boundPid && !o.ours.includes(o.boundPid) && o.alive(o.boundPid)) return `it is open in claude process ${o.boundPid}`;
  const named = (o.naming || claudesNaming)(o.id, o.ours);
  if (named.length) return `claude process ${named[0]} has it open`;
  const age = (o.now ?? Date.now()) - o.mtime;
  const ours = o.ourLast != null && o.mtime <= o.ourLast + OUR_SLACK_MS;
  if (age < ACTIVE_MS && !ours) return `its transcript was written ${Math.max(0, Math.round(age / 1000))}s ago`;
  return null;
}
