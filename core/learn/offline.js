// @ts-check
// offline — the lessons' checks when vyred is down, run inside the hook's own process.
//
// Stopping a daemon must not switch lessons off, just as it cannot switch off the security floor.
// So Learning keeps a snapshot of the accepted lessons in the home (lessons.json, mode 0600),
// rewritten whenever one changes, and the hooks fall back to it when vyred does not answer.
//
// Offline is a smaller world: no Projects, so only lessons scoped to everyone (or to this
// agent) apply; no store, so the thread's turn (its prompt_id, how often Stop sent it back, the
// files it changed and the commands it ran) lives in a small file per session under
// learn-offline/. What happened offline (caught, broken) is appended to learn-offline/log.jsonl,
// and the learn module counts it the next time vyred starts, escalation included.

import fs from "node:fs";
import path from "node:path";
import { atStop, atTool, weakens, sentBack, held, MAX_BLOCKS } from "./checks.js";

export const SNAPSHOT = "lessons.json";
const DIR = "learn-offline";
const LOG = "log.jsonl";
/** Tools that change files, and where each keeps the path, as the Harness records them. */
const WRITERS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
/** A session's state file keeps the newest of these, so a long offline stretch stays small. */
const KEEP = 500;

/** Write a file readable only by its owner, whole or not at all. */
function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Save the accepted lessons for the hooks to use when vyred is down. Only what a check needs.
 * @param {string} root the Vyre home
 * @param {any[]} lessons active lessons, in the learn module's shape
 */
export function writeSnapshot(root, lessons) {
  const keep = lessons.filter(l => l.status === "active").map(({ id, rule, level, scope, check }) => ({ id, rule, level, scope, check }));
  writePrivate(path.join(root, SNAPSHOT), JSON.stringify({ version: 1, at: Date.now(), lessons: keep }, null, 2) + "\n");
}

/** The snapshot's lessons that apply with no Projects to ask: everyone's, and this agent's. */
export function readSnapshot(root, agent) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT), "utf8"));
    const all = Array.isArray(s.lessons) ? s.lessons : [];
    return all.filter(l => l && l.check && (l.scope === "all" || (agent && l.scope && l.scope.agent === agent)));
  } catch { return []; }
}

const dir = root => path.join(root, DIR);
const stateFile = (root, session) => path.join(dir(root), String(session || "none").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) + ".json");

/** This session's offline turn. A new prompt_id is a new turn: only the commands and when a file last changed carry over. */
function load(root, session, prompt_id) {
  let s = { prompt: null, blocks: 0, touched: [], ran: [], changed: 0 };
  try { s = { ...s, ...JSON.parse(fs.readFileSync(stateFile(root, session), "utf8")) }; } catch {}
  if (prompt_id && s.prompt !== prompt_id) s = { ...s, prompt: prompt_id, blocks: 0, touched: [] };
  return s;
}
function save(root, session, s) {
  fs.mkdirSync(dir(root), { recursive: true, mode: 0o700 });
  writePrivate(stateFile(root, session), JSON.stringify({ ...s, touched: s.touched.slice(-KEEP), ran: s.ran.slice(-KEEP) }));
}
function log(root, entry) {
  fs.mkdirSync(dir(root), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir(root), LOG), JSON.stringify({ ...entry, at: Date.now() }) + "\n", { mode: 0o600 });
}

/**
 * PreToolUse with vyred down: the lessons' verdict on a call, in the Harness rules' shape.
 * @param {{ root: string, session?: string, prompt_id?: string, agent?: string, tool: string, input: any }} call
 * @returns {{ decision: "deny"|"ask"|null, reason?: string, lesson?: number }}
 */
export function offlineTool({ root, session, prompt_id, agent, tool, input }) {
  const lessons = readSnapshot(root, agent);
  if (!lessons.length) return { decision: null };
  const guard = weakens(tool, input || {});
  if (guard) return { decision: "ask", reason: `${guard} Vyre asks the user first.` };
  const s = load(root, session, prompt_id);
  const ran = s.ran.filter(r => r.at >= (s.changed || 0)).map(r => r.command);
  if (tool === "Bash" && typeof input?.command === "string") s.ran.push({ command: input.command.slice(0, 2000), at: Date.now() });

  /** @type {{ decision: "deny"|"ask"|null, reason?: string, lesson?: number }} */
  let verdict = { decision: null };
  for (const l of lessons) {
    const r = atTool(l.check, { tool, input: input || {}, ran });
    if (!r.problem) continue;
    if (l.level === "remind") { log(root, { lesson: l.id, kind: "broken", session: session || null }); continue; }
    log(root, { lesson: l.id, kind: "caught", session: session || null });
    if (!verdict.decision || (verdict.decision === "ask" && l.level === "block")) {
      verdict = { decision: l.level === "block" ? "deny" : "ask", reason: held(l, r.problem), lesson: l.id };
    }
  }
  save(root, session, s);
  return verdict;
}

/** PostToolUse with vyred down: remember which file this turn changed. */
export function offlineTouched({ root, session, prompt_id, agent, cwd, tool, input }) {
  const key = WRITERS[/** @type {keyof typeof WRITERS} */ (tool)];
  const raw = key && input ? input[key] : null;
  if (!raw || typeof raw !== "string" || !readSnapshot(root, agent).length) return;
  const s = load(root, session, prompt_id);
  const at = Date.now();
  s.touched.push({ path: path.resolve(cwd || process.cwd(), raw), at });
  s.changed = at;
  save(root, session, s);
}

/**
 * Stop with vyred down: send the turn back when it breaks a lesson, at most MAX_BLOCKS times.
 * @param {{ root: string, session?: string, prompt_id?: string, agent?: string, text?: string, stop_hook_active?: boolean }} turn
 * @returns {{ decision: "block", reason: string } | { decision: null }}
 */
export function offlineStop({ root, session, prompt_id, agent, text, stop_hook_active }) {
  const lessons = readSnapshot(root, agent);
  if (!lessons.length) return { decision: null };
  const s = load(root, session, prompt_id);
  if (!stop_hook_active) s.blocks = 0;
  const touched = s.touched.map(f => f.path);
  const failed = [];
  for (const l of lessons) {
    const r = atStop(l.check, { text: typeof text === "string" ? text : null, touched });
    if (r.problem) failed.push({ l, problem: r.problem });
  }
  const back = failed.filter(f => f.l.level !== "remind");
  if (back.length && s.blocks < MAX_BLOCKS) {
    s.blocks++;
    for (const { l } of back) log(root, { lesson: l.id, kind: "caught", session: session || null });
    save(root, session, s);
    return { decision: "block", reason: sentBack(s.blocks, back) };
  }
  for (const { l } of failed) log(root, { lesson: l.id, kind: "broken", session: session || null });
  save(root, session, s);
  return { decision: null };
}

/** What happened while vyred was down, oldest first; the log is emptied. Never throws. */
export function drain(root) {
  const file = path.join(dir(root), LOG);
  // Moved aside before reading, so a hook appending meanwhile starts a new log instead of losing a line.
  const taken = `${file}.${process.pid}.draining`;
  let raw = "";
  try { fs.renameSync(file, taken); raw = fs.readFileSync(taken, "utf8"); fs.rmSync(taken, { force: true }); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) { try { const e = JSON.parse(line); if (e && Number.isInteger(e.lesson)) out.push(e); } catch {} }
  return out;
}
