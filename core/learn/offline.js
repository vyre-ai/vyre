// @ts-check
// offline — the lessons' checks when vyred is down, run inside the hook's own process.
//
// Stopping a daemon must not switch lessons off, just as it cannot switch off the security floor.
// So Learning keeps a snapshot of the accepted lessons in the home (lessons.json, mode 0600),
// rewritten whenever one changes, and the hooks fall back to it when vyred does not answer.
//
// Offline is a smaller world, but a complete one: no Projects, so each project lesson carries its
// project's folders in the snapshot and applies when cwd is in one (the longest match, as
// projects.of decides); agent lessons match VYRE_AGENT. When lessons.json is missing or cannot be
// read, the hook reads the active lessons from vyre.db instead, read-only, so deleting the file
// does not switch the lessons off. No store to write, so the thread's turn (its prompt_id, how
// often Stop sent it back, the files it changed and the commands it ran) lives in a small file
// per session under learn-offline/. What happened offline (caught, broken) is appended to
// learn-offline/log.jsonl, and the learn module counts it the next time vyred starts,
// escalation included.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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
 * Save the accepted lessons for the hooks to use when vyred is down. Only what a check needs, and
 * for a project lesson its project's slug and folders. Returns the text written, which vyred
 * hashes to notice a change it did not make.
 * @param {string} root the Vyre home
 * @param {any[]} lessons active lessons, in the learn module's shape
 * @param {Record<number, { project: string, folders: string[] }>} [projects] by lesson id
 * @returns {string}
 */
export function writeSnapshot(root, lessons, projects = {}) {
  const keep = lessons.filter(l => l.status === "active").map(({ id, rule, level, scope, check }) => ({ id, rule, level, scope, check, ...(projects[id] || {}) }));
  const text = JSON.stringify({ version: 2, at: Date.now(), lessons: keep }, null, 2) + "\n";
  writePrivate(path.join(root, SNAPSHOT), text);
  return text;
}

/**
 * Every active lesson the hooks can know of with vyred down: the snapshot's, or when it is missing
 * or unreadable, the store's. Never throws.
 * @param {string} root
 * @returns {any[]}
 */
export function allLessons(root) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT), "utf8"));
    if (s && Array.isArray(s.lessons)) return s.lessons.filter(l => l && typeof l === "object");
  } catch {}
  return fromStore(root);
}

/**
 * The active lessons from vyre.db, opened read-only with a short busy timeout, and project folders
 * from Projects' own table when it has one. node:sqlite is loaded only here, so a hook with a
 * snapshot never pays for it. [] when there is no store or it cannot be read.
 * @param {string} root
 */
export function fromStore(root) {
  const file = path.join(root, "vyre.db");
  if (!fs.existsSync(file)) return [];
  let db;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true, timeout: 200 });
    const rows = db.prepare("SELECT id, rule, level, scope, check_json FROM learn_lessons WHERE status = 'active' AND check_json IS NOT NULL ORDER BY id").all();
    let projects = [];
    try { projects = db.prepare("SELECT slug, name, home, spec FROM projects_projects").all(); } catch {}
    return rows.map(r => {
      const l = { id: Number(r.id), rule: String(r.rule), level: String(r.level), scope: JSON.parse(String(r.scope)), check: JSON.parse(String(r.check_json)) };
      const v = l.scope && l.scope.project;
      if (!v) return l;
      for (const p of projects) {
        let folders = [String(p.home)];
        try { const spec = JSON.parse(String(p.spec)); if (Array.isArray(spec.workspaces) && spec.workspaces.length) folders = spec.workspaces.map(String); } catch {}
        if (v === p.slug || v === p.name || v === p.home || folders.includes(v)) return { ...l, project: String(p.slug), folders };
      }
      return l;
    });
  } catch { return []; } finally { try { db && db.close(); } catch {} }
}

/** A folder as Projects stores it: real path when it exists. */
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * The lessons with a check that apply here, with no Projects to ask: everyone's, this agent's,
 * and the project's whose folder holds cwd (the longest match wins, as projects.of decides).
 * @param {string} root @param {string} [agent] @param {string} [cwd]
 */
export function readSnapshot(root, agent, cwd) {
  return applicable(allLessons(root), agent, cwd);
}

/** @param {any[]} all @param {string} [agent] @param {string} [cwd] */
function applicable(all, agent, cwd) {
  let project = null, len = -1;
  if (cwd) {
    const here = real(cwd);
    for (const l of all) if (l.project && Array.isArray(l.folders)) for (const f of l.folders) {
      if ((here === f || here.startsWith(f + path.sep)) && f.length > len) { project = l.project; len = f.length; }
    }
  }
  return all.filter(l => l.check && (l.scope === "all" || (agent && l.scope && l.scope.agent === agent) || (project && l.scope && l.scope.project && l.project === project)));
}

const dir = root => path.join(root, DIR);
const stateFile = (root, session) => path.join(dir(root), String(session || "none").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) + ".json");

/**
 * This session's offline turn. A new prompt_id is a new turn: only the commands, when a file last
 * changed and the block count carry over. The count starts over only at a Stop that Claude Code
 * says is not a continuation (stop_hook_active false), so a turn at the cap cannot win more tries
 * by showing another prompt_id. Order is `n`, a counter kept in this file, not the clock: an edit and
 * the next command often land in the same millisecond, and then a timestamp cannot say which came
 * first. `changed` is the `n` of the newest edit; commands with a higher `n` came after it.
 */
function load(root, session, prompt_id) {
  let s = { prompt: null, blocks: 0, touched: [], ran: [], n: 0, changed: 0 };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(root, session), "utf8"));
    // A file written before the counter kept a timestamp in `changed`; it would outrank every `n`.
    s = Number.isInteger(saved.n) ? { ...s, ...saved } : { ...s, ...saved, n: 0, changed: 0 };
  } catch {}
  if (prompt_id && s.prompt !== prompt_id) s = { ...s, prompt: prompt_id, touched: [] };
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
 * @param {{ root: string, session?: string, prompt_id?: string, agent?: string, cwd?: string, tool: string, input: any }} call
 * @returns {{ decision: "deny"|"ask"|null, reason?: string, lesson?: number }}
 */
export function offlineTool({ root, session, prompt_id, agent, cwd, tool, input }) {
  const all = allLessons(root);
  if (!all.length) return { decision: null };
  // The guards hold wherever any lesson is active, as online.
  const guard = weakens(tool, input || {}, { home: root, cwd });
  if (guard) return { decision: "ask", reason: `${guard} Vyre asks the user first.` };
  const lessons = applicable(all, agent, cwd);
  if (!lessons.length) return { decision: null };
  const s = load(root, session, prompt_id);
  // An entry from before `n` existed has none, and so never counts: at worst the tests run again.
  const ran = s.ran.filter(r => Number.isInteger(r.n) && r.n > s.changed).map(r => r.command);
  if (tool === "Bash" && typeof input?.command === "string") s.ran.push({ command: input.command.slice(0, 2000), at: Date.now(), n: ++s.n });

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
  if (!raw || typeof raw !== "string" || !readSnapshot(root, agent, cwd).length) return;
  const s = load(root, session, prompt_id);
  const at = Date.now();
  s.touched.push({ path: path.resolve(cwd || process.cwd(), raw), at });
  s.changed = ++s.n;
  save(root, session, s);
}

/**
 * Stop with vyred down: send the turn back when it breaks a lesson, at most MAX_BLOCKS times.
 * @param {{ root: string, session?: string, prompt_id?: string, agent?: string, cwd?: string, text?: string, stop_hook_active?: boolean }} turn
 * @returns {{ decision: "block", reason: string } | { decision: null }}
 */
export function offlineStop({ root, session, prompt_id, agent, cwd, text, stop_hook_active }) {
  const lessons = readSnapshot(root, agent, cwd);
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
