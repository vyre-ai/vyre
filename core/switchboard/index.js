// @ts-check
// The switchboard (docs/SPEC.md 7.8): headless Claude Code sessions, streamed to every surface,
// one keyboard at a time, and every permission question routed to wherever the user is.
//
// The module is named "threads" because its tools are: a thread is a Claude Code session, the
// same one whether it is in a terminal, the Deck, the Capsule or Chat (floor rule 3). A thread's
// id IS its Claude Code session id, fixed before the process starts with --session-id, so there
// is never a Vyre id to map to a Claude one.
//
// What flows where:
//   surface --threads.send--> lease check --> the child's stdin (a stream-json user line)
//   child's stdout --translate--> thread.* / ask.* events --> /v1/events/stream --> every surface
//   ask.raised --threads.answer (any human surface)--> a control_response on the child's stdin

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translate, cut, clip, CAPS } from "./translate.js";
import { userLine, answerLine, run as defaultRun } from "./runner.js";
import { claudeProvider } from "../sessions/providers.js";
import { sessionsConfig, sdkDir, claudeBin, CREDENTIALS } from "../sessions/config.js";
import { claudeHome, transcriptFolders, privateSocketDir } from "../config/index.js";
import { findSubreaper, groupAlive, usesSpawner } from "../sessions/spawn.js";
import { openThreadSocket, DIR as THREAD_SOCKETS } from "../daemon/threadsock.js";
import { keyUuid } from "../modules/idempotency.js";
import { rules as floorRules } from "../harness/rules.js";
import { threadStatus, LIVE_STATUSES } from "../../lib/thread-status.js";
import { load as loadSdk, install as installSdk, installed as sdkInstalled, autoInstallAllowed, abortInstalls } from "../sessions/sdk.js";
import { Leases } from "./lease.js";
import { Asks } from "./asks.js";
import { editChanges, pushDir, pushChanges } from "./changes.js";
import { register as registerClaim } from "./claim.js";
import { Sessions, SESSIONS_MIGRATION, alive } from "./sessions.js";
import { findSession, sessionInfo, openElsewhere } from "./adopt.js";
import { wantsMacs, askMacs, mergeRows, gatedAsk } from "../modules/federate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Reviewer's LOW on cb387d88, 2026-09-28: a teammate's own request id (threads.post -> thread.sent/
// thread.queued -> threads_inbox) is a matching hint, not an auth fact, but it is still stored and
// broadcast on every device watching the thread - checked for shape before either, same as any
// other id this codebase stores untrusted.
const REQUEST_ID = /^[\w-]{1,64}$/;
const safeRequest = v => (typeof v === "string" && REQUEST_ID.test(v) ? v : undefined);

/** Usage per turn (for agents.usage), and the last rate-limit report Claude Code gave a thread. */
const USAGE_MIGRATION = `CREATE TABLE threads_turns (thread TEXT NOT NULL, agent TEXT, auth TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL,
     cost_usd REAL NOT NULL, duration_ms INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL);
   CREATE INDEX threads_turns_agent ON threads_turns (agent, at);
   ALTER TABLE threads_runs ADD COLUMN last_limit TEXT;`;

export const MIGRATIONS = [
  `CREATE TABLE threads_runs (
     id TEXT PRIMARY KEY, name TEXT, cwd TEXT NOT NULL, project TEXT, agent TEXT, agent_kind TEXT,
     status TEXT NOT NULL, model TEXT, auth TEXT NOT NULL DEFAULT 'ambient', pid INTEGER,
     started_at INTEGER NOT NULL, last_at INTEGER NOT NULL, cost_usd REAL NOT NULL DEFAULT 0,
     turns INTEGER NOT NULL DEFAULT 0, stopped_reason TEXT
   );
   CREATE INDEX threads_runs_agent ON threads_runs (agent, last_at);
   CREATE TABLE threads_asks (
     id TEXT PRIMARY KEY, thread TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL,
     summary TEXT, destination TEXT, reason TEXT, at INTEGER NOT NULL, state TEXT NOT NULL,
     decision TEXT, answered_by TEXT, answered_at INTEGER
   );
   CREATE INDEX threads_asks_open ON threads_asks (state, at);
   CREATE TABLE threads_leases (thread TEXT PRIMARY KEY, surface TEXT NOT NULL, since INTEGER NOT NULL, beat INTEGER NOT NULL);`,
  SESSIONS_MIGRATION,
  // How a thread was launched, so a resume runs it the same way (a lean thread stays lean), and
  // watches: a surface or the assistant waiting for a thread to finish or ask.
  `ALTER TABLE threads_runs ADD COLUMN opts TEXT;
   CREATE TABLE threads_watches (id TEXT PRIMARY KEY, thread TEXT NOT NULL, until TEXT NOT NULL, notify TEXT, note TEXT, by TEXT, at INTEGER NOT NULL);
   CREATE INDEX threads_watches_thread ON threads_watches (thread);`,
  USAGE_MIGRATION,
  // Words for a session busy in another process (a terminal), handed over by the Harness at the
  // session's next Stop or prompt. replied_at is when the turn that answered them ended.
  `CREATE TABLE threads_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, text TEXT NOT NULL, surface TEXT NOT NULL,
     at INTEGER NOT NULL, delivered_at INTEGER, via TEXT, replied_at INTEGER);
   CREATE INDEX threads_inbox_thread ON threads_inbox (thread, delivered_at);`,
  // Questions (AskUserQuestion) as well as permissions, and what a card shows for each: the
  // questions, or the command, file and change a permission is for (JSON, redacted and capped).
  `ALTER TABLE threads_asks ADD COLUMN kind TEXT NOT NULL DEFAULT 'permission';
   ALTER TABLE threads_asks ADD COLUMN detail TEXT;`,
  // Where an ask sits in its session, so a surface can open the transcript at it: the tool call it
  // is about (Claude Code's tool_use_id) and the id of its ask.raised event.
  `ALTER TABLE threads_asks ADD COLUMN tool_use_id TEXT;
   ALTER TABLE threads_asks ADD COLUMN event INTEGER;`,
  // Which driver runs a thread (ADR 0030): "sdk" (the Claude Agent SDK) or "cli" (runner.js).
  `ALTER TABLE threads_runs ADD COLUMN driver TEXT;`,
  // Which provider runs a thread (claude, or one a module registered) and what kind of session it
  // is (chat, agent, project, capsule, job, memory, planner, learn), which picks its model.
  `ALTER TABLE threads_runs ADD COLUMN provider TEXT;
   ALTER TABLE threads_runs ADD COLUMN purpose TEXT;`,
  // Claude Code reports a session's cost as a running total (total_cost_usd, across the turns of
  // one process, continued from the transcript's saved total on a resume): the last one seen, so
  // each turn's own cost is the difference.
  `ALTER TABLE threads_runs ADD COLUMN cost_total REAL;`,
  // A queued message's own id (the SDK user message uuid it goes to Claude Code with).
  `ALTER TABLE threads_inbox ADD COLUMN uuid TEXT;`,
  // Every message handed to Claude Code, by its uuid (ADR 0029 R2 with ADR 0030): a retried send
  // with the same Idempotency-Key is the same message, never a second turn, even after a restart.
  // And the permission mode a person put the thread in.
  `CREATE TABLE threads_sent (uuid TEXT PRIMARY KEY, thread TEXT NOT NULL, at INTEGER NOT NULL);
   ALTER TABLE threads_runs ADD COLUMN mode TEXT;`,
  // What a queued item is: a person's message, or a teammate's result (ADR 0031), which waits for
  // the turn to end and never steers.
  `ALTER TABLE threads_inbox ADD COLUMN kind TEXT;`,
  // A queued message's pasted images (JSON), handed over with its words; and steered messages not
  // folded in yet, so a stop or a restart does not lose them: they run first when it comes back.
  `ALTER TABLE threads_inbox ADD COLUMN images TEXT;
   CREATE TABLE threads_steers (uuid TEXT PRIMARY KEY, thread TEXT NOT NULL, text TEXT NOT NULL, images TEXT, at INTEGER NOT NULL);
   CREATE INDEX threads_steers_thread ON threads_steers (thread);`,
  // A teammate's async reply (ADR 0031, core/team's finish()) carries its own request id, so a
  // surface with two open asks to the same teammate can match a reply to the ask it answers
  // instead of by role, FIFO (ambiguous once @role makes that a common case, not an edge one).
  `ALTER TABLE threads_inbox ADD COLUMN request TEXT;`,
];

/** Images kept as JSON (a queued or steered message's), or null. @param {any} v */
const imagesJson = v => (Array.isArray(v) && v.length ? JSON.stringify(v) : null);
/** @param {any} v @returns {{ media_type: string, data: string }[]|null} */
const imagesFrom = v => { try { const a = v ? JSON.parse(String(v)) : null; return Array.isArray(a) && a.length ? a : null; } catch { return null; } };

/**
 * An "always in <project>" rule, as Claude Code takes it in updatedPermissions. Claude Code's own
 * addRules suggestions say best what to allow (a Bash suggestion names the command prefix), so
 * their rules are kept and only the destination changes; a suggestion that is a mode (setMode, as
 * for Edit and Write) becomes a rule for the whole tool. localSettings is the project folder's
 * .claude/settings.local.json: the user's own, never committed with the project's code.
 * @param {string} tool @param {any[]|null|undefined} suggestions
 */
export function projectRules(tool, suggestions) {
  const rules = (suggestions || []).filter(x => x && x.type === "addRules" && Array.isArray(x.rules)).flatMap(x => x.rules)
    .filter(r => r && r.toolName).map(r => ({ toolName: String(r.toolName), ...(r.ruleContent ? { ruleContent: String(r.ruleContent) } : {}) }));
  return [{ type: "addRules", rules: rules.length ? rules : [{ toolName: tool }], behavior: "allow", destination: "localSettings" }];
}


/** The permission modes an answer may hand back (safePermissions). Never bypassPermissions (ADR 0030, "Security"). */
export const MODES = ["default", "acceptEdits", "plan"];

/**
 * "Doesn't ask" (bypassPermissions): the person's own choice, per session (threads.mode, Shift+Tab)
 * or as a project's default (sessions.mode.set). No Touch ID (the user's decision), but only a
 * person's surface sets it, an answer never does (MODES), and only in a session with Vyre's
 * plugin loaded, so the security floor still runs at PreToolUse; the Gate is vyred's and holds
 * whatever the mode.
 */
export const BYPASS = "bypassPermissions";
/** The modes a person may put a session in. */
export const PERSON_MODES = [...MODES, BYPASS];
export const MODE_LABELS = { default: "Ask", acceptEdits: "Edits without asking", plan: "Plan", [BYPASS]: "Doesn't ask" };

/**
 * What an answer may hand back to Claude Code as updatedPermissions: rules and directories as
 * offered, and a mode only among MODES. A suggestion to switch to bypassPermissions (or any mode
 * Vyre does not offer) is dropped, whoever answers.
 * @param {any[]|null|undefined} list
 */
export function safePermissions(list) {
  return (list || []).filter(x => x && typeof x === "object" && (x.type !== "setMode" || MODES.includes(x.mode)));
}

/**
 * Learned skills (written by Learning): the account's folder for every thread, a project's for
 * that project's threads, and an agent's for that agent's threads. Each is a Claude Code plugin,
 * and loads only if it is complete.
 * @param {string} root @param {string|null} project @param {string|null} [agent]
 */
export function learnedDirs(root, project, agent = null) {
  const dirs = [path.join(root, "learned", "account")];
  if (project) dirs.push(path.join(root, "learned", "projects", project));
  if (agent) dirs.push(path.join(root, "learned", "agents", agent));
  return dirs.filter(d => fs.existsSync(path.join(d, ".claude-plugin", "plugin.json")));
}

/** A rate-limit report in words, for the thread. @param {{ status: string, kind: string|null, resets_at: number|null, utilization?: number }} l */
function limitNotice(l) {
  const which = l.kind ? String(l.kind).replace(/_/g, "-") + " " : "";
  const when = l.resets_at ? `; it resets at ${new Date(l.resets_at * 1000).toISOString().slice(11, 16)} UTC` : "";
  if (l.status === "rejected") return `Claude's ${which}usage limit is reached${when}.`;
  const pct = typeof l.utilization === "number" ? ` is at ${Math.round(l.utilization * 100)}%` : " is close";
  return `Claude's ${which}usage limit${pct}${when}.`;
}

/** A rate-limit warning is said in the thread from this much of the limit used. */
export const LIMIT_NOTICE_AT = 0.8;

/** The events a watch waits for, and the reason each gives. */
const WATCHED = { "thread.finished": "finished", "ask.raised": "asked", "thread.stopped": "stopped" };

/** Launch options kept with a thread and reused on every resume. */
const KEPT = ["plugin", "plugins", "tools", "settings", "once", "provider", "purpose", "effort", "quick"];

/** Reasoning effort, as /effort takes it (the Agent SDK's EffortLevel). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const effortOf = (/** @type {any} */ v) => { if (v == null || v === "") return null; if (!EFFORTS.includes(String(v))) throw Object.assign(new Error(`effort must be one of ${EFFORTS.join(", ")}`), { code: "bad_input" }); return String(v); };
/** The saved launch options of a thread (threads_runs.opts). */
const optsOf = (/** @type {any} */ r) => { try { return r && r.opts ? JSON.parse(String(r.opts)) : {}; } catch { return {}; } };

/** The kind of session a launch is, when the caller does not say: it picks the model (sessions.models). */
export function purposeOf(o, project) {
  if (o.purpose) return String(o.purpose);
  if (o.once || o.lean || o.tools === "none") return "job";
  if (o.agent) return "agent";
  return project ? "project" : "chat";
}

/** Partial text is sent at most this often per thread: 20 a second, not one event per token. */
export const TEXT_EVERY_MS = 50;
/**
 * A turn's partial text (thread.text with a delta) is deleted from the event log this long after
 * its thread.finished: the done text holds the whole message, and the grace lets a surface that
 * is still catching up on the SSE backlog see the deltas first. VYRE_TEXT_PRUNE_MS overrides it.
 */
export const TEXT_PRUNE_MS = 60_000;
const LIVE = LIVE_STATUSES;
/** thread.state's words for a record's status (ADR 0030 section 1). */
const STATE = { starting: "starting", working: "running", waiting: "waiting", idle: "idle", stopped: "stopped" };

/**
 * The Harness plugin every thread loads. VYRE_HARNESS_DIR points elsewhere (tests, a user's own
 * copy); a missing plugin means the thread runs without Vyre's hooks rather than not at all.
 */
export function pluginDir() {
  const dir = process.env.VYRE_HARNESS_DIR || path.resolve(HERE, "..", "..", "harness");
  return fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}

/**
 * What a person approves when they answer an ask: the decision, the tool, where it goes, and the
 * thread; for a question, the answers they are giving.
 * @param {Switchboard} sb @param {{ ask: string, decision: string, answers?: Record<string, any>, scope?: string }} i
 */
export function answerSummary(sb, i) {
  const a = /** @type {any} */ (sb.asks.get(i.ask));
  if (!a) return `${i.decision} permission question ${i.ask}`;
  const t = sb.record(a.thread);
  const thread = `(thread ${t && t.name ? t.name : String(a.thread).slice(0, 8)})`;
  if (i.decision === "always" && i.scope === "project" && a.kind !== "question") {
    const sc = sb.scopes && sb.scopes.get(a.thread);
    return `Always allow ${a.tool} in ${sc ? sc.name : t && t.project ? t.project : "its project"}${a.summary ? `: ${a.summary}` : ""} ${thread}`;
  }
  if (a.kind === "question") {
    if (i.decision === "deny") return `Decline the question${a.summary ? `: ${a.summary}` : ""} ${thread}`;
    const said = Object.entries(i.answers || {}).map(([q, v]) => {
      const shown = (a.questions || []).find(x => x.question === q);
      return `Answer ${shown && shown.header ? shown.header : cut(q, 80)}: ${cut(clip(Array.isArray(v) ? v.join(", ") : String(v ?? ""), CAPS.answer), 120)}`;
    });
    return `${said.length ? said.join("; ") : "Answer the question"} ${thread}`;
  }
  const where = a.destination ? ` to ${a.destination}` : "";
  const verb = i.decision === "always" ? "Always allow" : i.decision === "allow" ? "Allow" : "Deny";
  return `${verb} ${a.tool}${where}${a.summary ? `: ${a.summary}` : ""} ${thread}`;
}

/**
 * Who a caller is, for the checks below. The MCP server calls as "mcp", or "mcp:agent:<name>"
 * inside an agent's own thread.
 */
const agentOf = caller => { const m = /^mcp:agent:(.+)$/.exec(String(caller || "")); return m ? m[1] : null; };

export class Switchboard {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, emit: (type: string, payload: any, where?: any) => any,
   *           call: (tool: string, input: any) => Promise<any>, root: string, log: (m: string) => void,
   *           prune?: (thread: string, before: number) => void, run?: typeof defaultRun, bin?: string,
   *           transcripts?: string[], naming?: (id: string, ours: number[]) => number[], isClaude?: (pid: number) => boolean,
   *           sdk?: { module: any, bin: string|null }|null, idleMs?: number, maxLive?: number, subreaper?: string|null, uid?: number, gid?: number,
   *           auth?: (o: { agent?: string|null }) => Promise<{ auth: string, env?: Record<string,string>, fallback?: any }|null> }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.db = deps.db;
    this.leases = new Leases(deps.db);
    /** @type {Map<string, any[]>} Claude Code's permission suggestions per open ask, in memory only (what "always" hands back) */
    this.suggestions = new Map();
    /** @type {Map<string, { slug: string, name: string, cwd: string }|null>} per thread: the project an "always in <project>" rule would be for */
    this.scopes = new Map();
    this.asks = new Asks(deps.db, ({ id, thread, project }) => {
      const always = this.suggestions.has(id), sc = this.scopes.get(thread);
      return { always, always_project: always && sc && sc.slug === project ? sc.name : null };
    });
    /** @type {Map<string, any>} live sessions: id -> { proc, launch, message, pending, timer, lastPrompt } */
    this.live = new Map();
    this.run = deps.run || defaultRun;
    this.bin = deps.bin || process.env.VYRE_CLAUDE_BIN || "claude";
    /** The Agent SDK, once loaded (ADR 0030); null runs threads on the CLI runner. */
    this.sdk = deps.sdk || null;
    /** @type {null | (() => Promise<{ module: any, bin: string|null }|null>)} loads it, on the first thread */
    this.loadSdk = null;
    /** @type {Map<number, number>} every session's process group, pgid -> sid, kept until the whole group is gone */
    this.groups = new Map();
    /** Spare quick sessions being started (threads.quick), which a stop waits for; and whether vyred is stopping. */
    this.starting = new Set();
    this.closing = false;
    /** @type {Map<string, { path: string, close: () => Promise<void> }>} each live thread's own socket to vyred (deps.threadSocket) */
    this.socks = new Map();
    /** @type {Map<string, string>} the last status said per thread, for thread.state */
    this.states = new Map();
    /** @type {Map<string, string[]>} `!` shell output waiting to go with a thread's next message */
    this.shellContext = new Map();
    /** @type {Set<{ timer: any, run: () => void }>} delta prunes waiting out their grace */
    this.prunes = new Set();
    /** Sessions bound by their SessionStart hook, so an MCP call can say which one it is from (sessions.js). */
    this.sessions = new Sessions(deps.db, { children: () => this.ours(),
      ...(deps.isClaude ? { isClaude: deps.isClaude } : {}) });
  }

  /** Delete a thread's partial text up to a finished turn, after the grace. */
  schedulePrune(thread, before) {
    if (!this.deps.prune) return;
    const ms = Number(process.env.VYRE_TEXT_PRUNE_MS ?? TEXT_PRUNE_MS);
    const job = { timer: null, run: () => { this.prunes.delete(job); clearTimeout(job.timer);
      try { this.deps.prune?.(thread, before); } catch (e) { this.deps.log(`pruning ${thread}'s partial text failed: ${/** @type {Error} */ (e).message}`); } } };
    job.timer = setTimeout(job.run, Number.isFinite(ms) && ms >= 0 ? ms : TEXT_PRUNE_MS);
    job.timer.unref?.();
    this.prunes.add(job);
  }

  /** After a restart nothing is running: say so, and close the questions nobody can answer now. */
  recover() {
    const stale = /** @type {any[]} */ (this.db.prepare(`SELECT id, project FROM threads_runs WHERE status IN (${LIVE.map(() => "?").join(",")})`).all(...LIVE));
    for (const r of stale) {
      // "restart" (ADR 0029 R7): a surface says the box restarted, and the next message resumes it.
      // Said as an event too: a surface that missed the old process's end would spin otherwise.
      this.db.prepare("UPDATE threads_runs SET status = 'stopped', stopped_reason = 'restart', pid = NULL WHERE id = ?").run(r.id);
      for (const a of this.asks.open(String(r.id))) this.closeAsk(a, "cancelled", "restart");
      this.emit("thread.stopped", { code: null, reason: "restart" }, String(r.id), r.project || null);
      // The canonical status too (bypassing set(): there is no live process to route through it),
      // so a surface watching thread.status in real time sees "paused" here, same as an idle
      // close - not silence until its next poll, and never read as a crash.
      this.emitRaw("thread.status", { status: threadStatus("stopped", "restart") }, String(r.id), r.project || null);
      this.states.set(String(r.id), "stopped");
    }
  }

  /**
   * Emit, without letting a payload that looks like a secret take the thread down. The event log
   * refuses such payloads (spec 6); what Claude typed or ran can contain a token, so the text
   * is withheld and the event still goes out, saying so.
   */
  emit(type, payload, thread, project) {
    // Every event of a turn says which turn (ADR 0030): a surface follows one turn's events.
    const st = this.live.get(thread);
    if (st && st.turn && payload && payload.turn === undefined && /^(thread|ask)\./.test(type) && type !== "thread.stopped") payload = { ...payload, turn: st.turn };
    // The server's clock on every piece of text (ms epoch), for a surface's words-per-second meter.
    if ((type === "thread.text" || type === "thread.thinking") && payload && payload.t === undefined) payload = { ...payload, t: Date.now() };
    const ev = this.emitRaw(type, payload, thread, project);
    if (WATCHED[type]) this.fire(type, thread, payload, project);
    return ev;
  }

  emitRaw(type, payload, thread, project) {
    const where = { thread, project: project || undefined };
    try { return this.deps.emit(type, { thread, ...payload }, where); }
    catch (e) {
      if (!/looks like a secret/.test(/** @type {Error} */ (e).message)) throw e;
      const safe = { thread };
      for (const [k, v] of Object.entries(payload)) safe[k] = typeof v === "string" && k !== "tool" && k !== "id" && k !== "ask" && k !== "kind" ? "[withheld: looked like a credential]"
        : k === "questions" || k === "answers" ? "[withheld: looked like a credential]" : v;   // an ask's words are nested
      return this.deps.emit(type, safe, where);
    }
  }

  record(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM threads_runs WHERE id = ?").get(id));
    if (!r) return null;
    const holder = this.leases.holder(id);
    // status stays the raw internal word (unchanged: existing callers compare it). canonical_status
    // is the one person-facing vocabulary (lib/thread-status.js) every surface should read instead.
    return { id: r.id, name: r.name, cwd: r.cwd, project: r.project, agent: r.agent, status: r.status,
      canonical_status: threadStatus(r.status, r.stopped_reason), model: r.model, driver: r.driver || null,
      provider: r.provider || "claude", purpose: r.purpose || null, mode: r.mode || "default", effort: optsOf(r).effort || null, origin: optsOf(r).origin || null,
      auth: r.auth, started: r.started_at, last: r.last_at, cost_usd: r.cost_usd, turns: r.turns,
      holder: holder ? holder.surface : null, asks: this.asks.open(id).length, ...(r.stopped_reason ? { stopped_reason: r.stopped_reason } : {}) };
  }

  must(id) {
    const r = this.record(id);
    if (!r) throw new Error(`no thread ${id}`);
    return r;
  }

  set(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE threads_runs SET ${keys.map(k => `${k} = ?`).join(", ")}, last_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), Date.now(), id);
    // thread.state (legacy words, kept for surfaces that already read it) and thread.status (the
    // canonical vocabulary, lib/thread-status.js), once per change: the working dot and "waiting
    // on you" read one of these.
    if (fields.status && this.states.get(id) !== fields.status) {
      this.states.set(id, fields.status);
      const rec = /** @type {any} */ (this.db.prepare("SELECT project, stopped_reason FROM threads_runs WHERE id = ?").get(id));
      const st = this.live.get(id);
      const turn = st && st.turn ? { turn: st.turn } : {};
      this.emitRaw("thread.state", { state: STATE[fields.status] || fields.status, ...turn }, id, rec ? rec.project : null);
      const reason = fields.status === "stopped" ? (fields.stopped_reason ?? (rec ? rec.stopped_reason : null)) : null;
      this.emitRaw("thread.status", { status: threadStatus(fields.status, reason), ...turn }, id, rec ? rec.project : null);
    }
  }

  /**
   * Where a thread runs: the folder given, else the project's home - or, for a brand-new
   * thread starting at a GitHub project's own default folder (never an explicit cwd a caller
   * gave), that project's own worktree for this session (ADR 0041 section 5: "use its path as
   * the session's cwd instead"). Null-safe the same way every other cross-module call in this
   * file is: no core/github, or the project has no repo, changes nothing.
   * @param {string} [session] the new thread's own id, so github.session.worktree can key its
   *   worktree to it - only given by launch() for a genuinely new thread, never a resume or fork
   *   (both already have a fixed cwd of their own by the time this runs).
   */
  async where({ cwd, project }, session) {
    let slug = null, home = null;
    if (project) {
      const list = await this.deps.call("projects.list", {});
      const p = (list.data?.projects || []).find(x => x.slug === project || String(x.name).toLowerCase() === String(project).toLowerCase());
      if (!p) throw new Error(`no project ${project}`);
      slug = p.slug; home = p.home;
    }
    let dir = cwd ? path.resolve(cwd) : home;
    if (!dir) throw new Error("a thread needs a folder: give cwd or project");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    if (!slug) { const of = await this.deps.call("projects.of", { cwd: dir }); slug = of.data?.slug || null; }
    if (!cwd && slug && session) {
      const gh = await this.deps.call("github.project.of", { project: slug }).catch(() => null);
      if (gh && !gh.error && gh.data) {
        const wt = await this.deps.call("github.session.worktree", { project: slug, session }).catch(() => null);
        if (wt && !wt.error && wt.data && wt.data.path) dir = wt.data.path;
      }
    }
    return { cwd: dir, project: slug };
  }

  /**
   * Start a thread, or bring a stopped one back with --resume.
   * @param {{ cwd?: string, project?: string, prompt?: string, name?: string, model?: string, surface?: string,
   *           resume?: string, agent?: string, agent_kind?: string, env?: Record<string,string>, auth?: string,
   *           append?: string, budget_usd?: number, fallback?: { env: Record<string,string>, budget_usd?: number },
   *           scope?: { projects: string[]|"*", cwds?: string[] } }} o
   */
  async launch(o) {
    let id, rec;
    if (o.effort !== undefined) o = { ...o, effort: effortOf(o.effort) || undefined };
    if (o.lean) o = { ...o, plugin: false, tools: "none", settings: false };
    if (o.resume) {
      rec = this.must(o.resume);
      id = rec.id;
      if (this.live.has(id)) { if (o.prompt) this.write(id, o.prompt); return this.launched(id); }
      const row = /** @type {any} */ (this.db.prepare("SELECT opts FROM threads_runs WHERE id = ?").get(id));
      if (row && row.opts) o = { ...JSON.parse(String(row.opts)), ...o };
    } else {
      // A fork starts where another session is (ADR 0030, "Adopting existing sessions"): its
      // folder and project, a new id, and never the other session's process or transcript.
      if (o.fork) {
        const src = this.record(o.fork) || await this.adopt(o.fork);
        o = { ...o, cwd: src.cwd, project: undefined, forkFrom: src.id, name: o.name || `${src.name || String(src.id).slice(0, 8)} (fork)` };
      }
      id = crypto.randomUUID();
      const w = await this.where(o, id);
      const now = Date.now();
      const provider = String(o.provider || "claude");
      if (provider !== "claude" && !(this.deps.providers && this.deps.providers.get(provider))) {
        throw Object.assign(new Error(`no session provider ${provider}; this machine has ${["claude", ...(this.deps.providers ? this.deps.providers.list() : [])].join(", ")}`), { code: "bad_input" });
      }
      const purpose = purposeOf(o, w.project);
      // The model: explicit (a launch, an agent's own), else the project's or the purpose's.
      if (!o.model) {
        const r = await this.deps.call("sessions.models.resolve", Object.fromEntries(Object.entries({ purpose, project: w.project }).filter(([, v]) => v))).catch(() => null);
        if (r && r.data && r.data.model) o = { ...o, model: r.data.model };
      }
      o = { ...o, provider, purpose };
      this.db.prepare(`INSERT INTO threads_runs (id, name, cwd, project, agent, agent_kind, status, model, auth, started_at, last_at)
        VALUES (?,?,?,?,?,?, 'starting', ?,?,?,?)`).run(id, o.name || null, w.cwd, w.project, o.agent || null, o.agent_kind || null,
        o.model || null, o.auth || "ambient", now, now);
      this.db.prepare("UPDATE threads_runs SET provider = ?, purpose = ? WHERE id = ?").run(o.provider, o.purpose, id);
      // A project's default mode (sessions.mode.set), for a new session a person starts there.
      if (w.project && !o.agent && !o.lean) {
        const m = await this.deps.call("sessions.mode.resolve", { project: w.project }).catch(() => null);
        if (m && m.data && PERSON_MODES.includes(String(m.data.mode))) this.db.prepare("UPDATE threads_runs SET mode = ? WHERE id = ?").run(String(m.data.mode), id);
      }
      // A fork's running total starts at its source's, as Claude Code continues it.
      if (o.forkFrom) this.db.prepare("UPDATE threads_runs SET cost_total = (SELECT cost_total FROM threads_runs WHERE id = ?) WHERE id = ?").run(o.forkFrom, id);
      const kept = Object.fromEntries(KEPT.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
      // A quick answer keeps its facts, so a follow-up after an idle close is answered from them too.
      if (o.purpose === "capsule" && o.append) kept.append = String(o.append).slice(0, 20000);
      // The surface that started it (the Capsule, the Deck, a phone): threads.get says it as origin.
      if (o.surface) kept.origin = String(o.surface).slice(0, 80);
      if (Object.keys(kept).length) this.db.prepare("UPDATE threads_runs SET opts = ? WHERE id = ?").run(JSON.stringify(kept), id);
      rec = this.must(id);
    }
    await this.room(id);
    if (!this.sdk && this.loadSdk) this.sdk = await this.loadSdk();
    // A thread no agent runs gets this machine's own Claude credential (sessions.auth): the
    // vault's setup token on a box, Claude Code's login on a Mac. An agent brings its own.
    if (!o.agent && !(o.env && (o.env.CLAUDE_CODE_OAUTH_TOKEN || o.env.ANTHROPIC_API_KEY)) && this.deps.auth) {
      const a = await this.deps.auth({ agent: null }).catch(e => { this.deps.log(`threads: ${e.message}; using this machine's own Claude login`); return null; });
      if (a && a.env) { o = { ...o, env: { ...(o.env || {}), ...a.env }, ...(a.fallback && !o.fallback ? { fallback: a.fallback } : {}) }; this.db.prepare("UPDATE threads_runs SET auth = ? WHERE id = ?").run(a.auth, id); }
    }
    o = { ...o, system: await this.systemPrompt(rec, o) };
    // A quick answer thinks not at all, so the same words get the same answer (no temperature knob).
    if (o.purpose === "capsule" && !o.agent) o = { ...o, env: { ...(o.env || {}), MAX_THINKING_TOKENS: "0" } };
    await this.openSocket(id, rec);
    this.spawn(id, { ...o, cwd: rec.cwd, resume: Boolean(o.resume) });
    const fresh = this.must(id);
    // What a surface's chip says: "Claude · opus · subscription".
    const payload = { name: rec.name, cwd: rec.cwd, project: rec.project, agent: rec.agent, headless: true, resumed: Boolean(o.resume), ...(o.forkFrom ? { forked_from: o.forkFrom } : {}), mode: fresh.mode,
      provider: fresh.provider, model: fresh.model, auth: fresh.auth, purpose: fresh.purpose, effort: fresh.effort, ...(o.system && o.system.version ? { prompt: o.system.version } : {}) };
    this.emit("thread.started", payload, id, rec.project);
    // The surface that started it gets the keyboard. A prompt given at launch by a module (an
    // agent asked something) is typed without taking the lease, so no surface is locked out.
    if (o.surface) this.lease(id, o.surface);
    // A resume first hands over what was steered in and never taken (a stop or a restart mid-turn).
    if (o.resume) this.restoreSteers(id);
    if (o.prompt) {
      if (o.surface) await this.send(id, o.prompt, o.surface);
      else { this.write(id, o.prompt); this.emit("thread.sent", { text: cut(o.prompt, 2000), surface: o.agent ? `agent:${o.agent}` : null }, id, rec.project); }
    }
    return this.launched(id);
  }

  /**
   * launch()'s own answer (threads.start, threads.fork, threads.launch): the record, plus
   * `thread` as an alias of `id` (a naming footgun native-core hit: threads.rewind's answer
   * echoes the new/resumed session id as `.thread`, so a client that copied that pattern reading
   * `.thread` off a launch answer silently got undefined). `id` is canonical; drop `thread` here
   * once every surface is confirmed off it (2026-09-28).
   * @param {string} id
   */
  launched(id) { return { ...this.record(id), thread: id }; }

  /**
   * The system prompt for a launch: the levels a person edited (assistant, agent, project;
   * sessions.prompt.*) around Vyre's own launch text. Without the sessions module it is that
   * text alone, as before.
   */
  async systemPrompt(rec, o) {
    // The Capsule's quick answer is Vyre IQ (core/sessions/iq-prompt.js): the whole prompt, with
    // the launch's append read as its facts, versioned. Without the sessions module, as before.
    if (o.purpose === "capsule" && !o.agent) {
      const r = await this.deps.call("sessions.prompt.compose", { purpose: "capsule", ...(o.append ? { append: String(o.append) } : {}) }).catch(() => null);
      if (r && r.data && typeof r.data.text === "string") return { mode: r.data.mode === "replace" ? "replace" : "append", text: r.data.text, version: r.data.version || null };
    }
    // A job (no settings, no plugin: Learning's distillation) is told only what its launch says.
    if (o.settings === false) return o.append ? { mode: "append", text: String(o.append) } : null;
    const kind = o.agent_kind || (rec.agent ? this.kindOf(rec.agent) : null);
    try {
      const input = Object.fromEntries(Object.entries({ agent: rec.agent, agent_kind: kind, project: rec.project, append: o.append }).filter(([, v]) => v));
      const r = await this.deps.call("sessions.prompt.compose", input);
      if (r && r.error && r.error.code !== "no_such_tool") this.deps.log(`threads: the system prompt could not be composed (${r.error.message}); using Vyre's own`);
      if (r && r.data && typeof r.data.text === "string") return { mode: r.data.mode === "replace" ? "replace" : "append", text: r.data.text };
    } catch {}
    return o.append ? { mode: "append", text: String(o.append) } : null;
  }

  /**
   * Room for one more process (sessions.max_live): the longest-idle thread nobody is looking at
   * is closed to make it; when every one is busy, the start is refused.
   */
  async room(id) {
    const max = Number(this.deps.maxLive) || 0;
    if (!max || this.live.has(id) || this.live.size < max) return;
    const idle = [...this.live.entries()].filter(([t, st]) => this.closable(t, st)).sort((a, b) => a[1].touched - b[1].touched);
    if (!idle.length) throw Object.assign(new Error(`${max} sessions are already running on this machine (sessions.max_live), all busy; stop one or try again when one finishes`), { code: "busy" });
    await this.close(idle[0][0], idle[0][1], "idle");
  }

  /** May this live thread be closed for idleness: no turn running, nothing asked, nobody at its keyboard or waiting on it. */
  closable(id, st) {
    if (st.stopping || st.switching || st.launch.once) return false;
    const r = /** @type {any} */ (this.db.prepare("SELECT status FROM threads_runs WHERE id = ?").get(id));
    if (!r || r.status !== "idle") return false;
    if (this.asks.open(id).length || this.leases.holder(id)) return false;
    return !this.db.prepare("SELECT 1 FROM threads_watches WHERE thread = ? LIMIT 1").get(id);
  }

  /**
   * The floor at PreToolUse, in process, while a thread is in "Doesn't ask" (the Agent SDK's hooks).
   * In any other mode it answers nothing: the floor runs before the question instead (onMessage).
   * @returns {any} a PreToolUse hook's answer
   */
  bypassFloor(id, input) {
    const st = this.live.get(id);
    if (!st || st.mode !== BYPASS || !input) return {};
    const rec = this.record(id);
    let v = null;
    try { v = floorRules({ tool: String(input.tool_name || ""), input: input.tool_input || {}, cwd: rec ? rec.cwd : undefined, home: this.deps.root || undefined }); } catch {}
    if (!v || v.decision !== "deny") return {};
    this.emit("thread.text", { message: "vyre", text: `Refused ${input.tool_name}: ${cut(v.reason || "the security floor does not allow it", 300)}`, done: true, notice: true }, id, rec ? rec.project : null);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Vyre's security floor refused this: ${v.reason || "not allowed"}` } };
  }

  /**
   * Open the thread's own socket to vyred (ADR 0030 phase 3, option A), when this machine gives
   * sessions one (deps.threadSocket). One per live thread, kept across a fallback respawn, closed
   * when the thread stops. Only the thread's own processes get in (threadsock.js).
   */
  async openSocket(id, rec) {
    if (!this.deps.threadSocket || this.socks.has(id)) return;
    try {
      const sock = await this.deps.threadSocket({ thread: id, agent: rec.agent || null, pids: async () => {
        const st = this.live.get(id);
        const g = st && st.group;
        return { pids: [st && st.proc && st.proc.pid, g && g.pid].filter(Boolean), pgids: g && g.pgid ? [g.pgid] : [], sids: g && g.sid ? [g.sid] : [] };
      } });
      if (sock) this.socks.set(id, sock);
    } catch (e) {
      this.deps.log(`threads: no socket for ${id.slice(0, 8)} (${/** @type {Error} */ (e).message}); its Vyre tools will not answer`);
    }
  }

  closeSocket(id) {
    const sock = this.socks.get(id);
    if (!sock) return;
    this.socks.delete(id);
    sock.close().catch(() => {});
  }

  /** Close a live thread's process, saying why; its transcript stays and threads.send resumes it. */
  async close(id, st, reason) {
    st.haltReason = reason;
    st.stopping = true;
    await st.proc.stop();
  }

  /**
   * A subagent is about to start in this thread: take a subagent slot for the thread's project,
   * waiting its turn when the project or the box is full (the user's concurrency limits). The
   * slot goes back when the Agent call ends, the turn ends or the thread stops. No sessions
   * module, no limits.
   * @returns {Promise<any>} a PreToolUse hook's answer: {} to go on, or a deny with the reason
   */
  async subagentSlot(id, input, toolUseID) {
    const st = this.live.get(id);
    const rec = this.record(id);
    const key = String(toolUseID || (input && input.tool_use_id) || crypto.randomUUID());
    const r = await this.deps.call("sessions.slots", { action: "take", kind: "subagent", project: (rec && rec.project) || "_none", owner: id, key, timeout_ms: 10 * 60_000, auth: (rec && rec.auth) || "ambient" });
    if (r && r.error) {
      if (r.error.code === "no_such_tool") return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: r.error.code === "usage_paused"
          ? `Subagents are ${r.error.message} Carry on without one.`
          : `No subagent slot came free (${r.error.message}). Carry on without it, or try again later.` } };
    }
    if (st && this.live.get(id) === st) { st.subSlots = st.subSlots || new Set(); st.subSlots.add(key); }
    else this.deps.call("sessions.slots", { action: "release", owner: id, key }).catch(() => {});
    return {};
  }

  /** Give back this thread's subagent slots: one (its Agent call ended) or all. */
  releaseSlots(id, st, key = null) {
    if (!st.subSlots || !st.subSlots.size) return;
    if (key != null) { if (!st.subSlots.delete(key)) return; this.deps.call("sessions.slots", { action: "release", owner: id, key }).catch(() => {}); return; }
    st.subSlots.clear();
    this.deps.call("sessions.slots", { action: "release-owner", owner: id, kind: "subagent" }).catch(() => {});
  }

  /** Tool calls a turn left open, said as canceled (thread.tool status "canceled"). */
  cancelTools(id, st, project) {
    if (!st.openTools || !st.openTools.size) return;
    const rec = project === null ? this.record(id) : null;
    for (const call of st.openTools) this.emit("thread.tool", { id: call, call, phase: "done", status: "canceled" }, id, project ?? (rec ? rec.project : null));
    st.openTools.clear();
  }

  /** Something happened in a thread: its idle clock starts again (sessions.idle_minutes). */
  touch(id, st) {
    st.touched = Date.now();
    const ms = Number(this.deps.idleMs) || 0;
    if (!ms) return;
    if (st.idle) clearTimeout(st.idle);
    st.idle = setTimeout(() => {
      st.idle = null;
      if (this.live.get(id) !== st) return;
      if (this.closable(id, st)) this.close(id, st, "idle").catch(() => {});
      else this.touch(id, st);                                           // busy or watched: look again later
    }, ms);
    st.idle.unref?.();
  }

  spawn(id, o) {
    // File checkpoints (the same switch the Agent SDK sets), so a rewind can restore files too.
    const env = { ...process.env, VYRE_HOME: this.deps.root, VYRE_THREAD: id, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1" };
    // One credential per child, set only in that child. An agent on a setup token must not
    // quietly spend an API key that happens to be in vyred's own environment, or the reverse.
    if (o.env && (o.env.CLAUDE_CODE_OAUTH_TOKEN || o.env.ANTHROPIC_API_KEY)) { delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY; }
    Object.assign(env, o.env || {});
    // The key is how the child proves which agent it is: vyred believes "mcp:agent:<name>" only
    // with the key of a live thread of that agent (threads.vouch). A new one per process.
    const key = o.agent ? crypto.randomBytes(24).toString("base64url") : null;
    if (o.agent) { env.VYRE_AGENT = o.agent; env.VYRE_AGENT_KIND = o.agent_kind || "agent"; env.VYRE_AGENT_KEY = /** @type {string} */ (key); }
    else { delete env.VYRE_AGENT; delete env.VYRE_AGENT_KIND; delete env.VYRE_AGENT_KEY; }
    // An agent's context is limited to its projects; the Harness reads these (brief, Enrich,
    // recall.search through MCP). "*" is the assistant's: every project.
    if (o.scope) { env.VYRE_PROJECTS = o.scope.projects === "*" ? "*" : o.scope.projects.join(","); env.VYRE_SCOPE_CWDS = JSON.stringify(o.scope.cwds || []); }
    else { delete env.VYRE_PROJECTS; delete env.VYRE_SCOPE_CWDS; }
    // The session's own socket (option A): its plugin, hooks and any vyre it runs talk to vyred on
    // it, as this thread, whatever they claim. Without one, VYRE_SOCKET is not inherited.
    const sock = this.socks.get(id);
    if (sock) env.VYRE_SOCKET = sock.path; else delete env.VYRE_SOCKET;
    const rec = this.must(id);
    // Learned skills load with the Harness; a job without the plugin gets only what it names.
    const plugins = [...(o.plugin === false ? [] : learnedDirs(this.deps.root, rec.project, rec.agent)), ...(o.plugins || [])];
    // In-process hooks (the Agent SDK only): a subagent waits for a concurrency slot (sessions.slots).
    // "Doesn't ask": nothing reaches a question, so the floor also runs here, in process, on every
    // call (the plugin's PreToolUse hook runs it too; this one needs no vyred round trip).
    const hooks = { PreToolUse: [{ matcher: "Agent|Task", hooks: [async (/** @type {any} */ input, /** @type {any} */ toolUseID) => this.subagentSlot(id, input, toolUseID)] },
      { hooks: [async (/** @type {any} */ input) => this.bypassFloor(id, input)] }] };
    // The mode a person put the thread in carries over a resume; "Doesn't ask" only with the plugin.
    const withPlugin = o.plugin !== false && Boolean(pluginDir());
    const mode = PERSON_MODES.includes(String(rec.mode)) && rec.mode !== "default" && (rec.mode !== BYPASS || withPlugin) ? rec.mode : null;
    // "Doesn't ask" asked of a session without the plugin: it starts asking instead, and says so.
    if (rec.mode === BYPASS && !withPlugin) this.db.prepare("UPDATE threads_runs SET mode = 'default' WHERE id = ?").run(id);
    // A warm quick session (threads.quick) writes no transcript: nothing to resume, and nothing
    // for Recall to find its prompt (another question's passages) in.
    const lo = { id, hooks, mode, skippable: withPlugin, effort: o.effort || null, ephemeral: Boolean(o.quick), resume: o.resume, forkFrom: o.forkFrom || null, resumeAt: o.resumeAt || null, plugin: o.plugin === false ? null : pluginDir(), plugins, model: o.model || rec.model, name: rec.name,
      append: o.append, system: o.system || null, budgetUsd: o.budget_usd, tools: o.tools === "none" ? "none" : null, settings: o.settings === false ? false : undefined };
    const state = { launch: o, key, withPlugin, mode: mode || "default", message: "", pending: "", timer: null, lastPrompt: o.lastPrompt || null, switching: false, proc: null, touched: Date.now(), idle: null,
      // Turns (ADR 0030): the current one, how many this thread has had, the steered messages not
      // yet taken in, and each message's blocks so far (for message:block keys).
      turn: null, turnNo: Number(rec.turns) || 0, steers: new Map(), ord: new Map(), pendingBlock: 0, interrupting: false };
    this.live.set(id, state);
    // How the process is spawned (core/sessions/spawn.js): the subreaper, another uid, and its
    // group recorded before it can run anything, for the peer check.
    const how = { subreaper: this.deps.subreaper || null, ...(this.deps.uid != null ? { uid: this.deps.uid, gid: this.deps.gid } : {}),
      onSpawn: g => { state.group = g; this.groups.set(g.pgid, g.sid); } };
    const on = { ...how, onMessage: m => { this.touch(id, state); if (!state.pidSet && state.proc && state.proc.pid) { state.pidSet = true; this.set(id, { pid: state.proc.pid }); } this.onMessage(id, state, m); }, onExit: (code, signal, stderr) => this.onExit(id, state, code, signal, stderr) };
    // The Agent SDK when it is loaded (ADR 0030), else the CLI runner: the same protocol, so the
    // same stream reaches onMessage either way.
    const other = o.provider && o.provider !== "claude" && this.deps.providers ? this.deps.providers.get(o.provider) : null;
    const provider = other || claudeProvider({ sdk: this.sdk, bin: this.sdk ? this.deps.bin || process.env.VYRE_CLAUDE_BIN || "" : this.bin, run: this.run });
    const driver = other ? String(o.provider) : this.sdk ? "sdk" : "cli";
    state.proc = provider.run({ ...lo, cwd: rec.cwd, env, ...on });
    this.set(id, { status: "starting", pid: state.proc.pid || null, stopped_reason: null, driver });
    this.touch(id, state);
  }

  onMessage(id, st, m) {
    const t = translate(m, st.seen);
    const rec = this.record(id);
    const project = rec ? rec.project : null;
    if (t.model) this.set(id, { model: t.model, status: rec && rec.status === "starting" ? "idle" : rec ? rec.status : "idle" });
    if (t.message !== undefined) { this.flush(id, st); st.message = t.message; }
    // A message's blocks so far: an assistant line's own block index plus the lines before it.
    if (t.commands) st.commands = t.commands;
    if (typeof t.used === "number" && t.used > 0) st.used = t.used;
    if (t.window) st.window = t.window;
    if (t.blocks && m.message && m.message.id) {
      const mid = String(m.message.id), base = st.ord.get(mid) || 0;
      for (const e of t.events) if (typeof e.payload.block === "number") e.payload.block += base;
      st.ord.set(mid, base + t.blocks);
    }
    // Steered messages Claude Code took in at a step.
    // step: how many tool calls the turn had finished when Claude took the words in.
    for (const u of t.folded || []) if (st.steers.delete(u)) { this.db.prepare("DELETE FROM threads_steers WHERE uuid = ?").run(u); this.emit("thread.steered", { uuid: u, step: st.steps || 0 }, id, project); }
    if (t.reasoning) {
      if (typeof t.block === "number" && t.block !== st.pendingBlock) { this.flush(id, st); st.pendingBlock = t.block; }
      st.rpending = (st.rpending || "") + t.reasoning;
      if (!st.timer) st.timer = setTimeout(() => this.flush(id, st), TEXT_EVERY_MS);
    }
    if (t.task) {
      st.tasks = st.tasks || new Map();
      const task = { ...(st.tasks.get(t.task.id) || {}), ...t.task };
      st.tasks.set(task.id, task);
      this.emit("thread.task", task, id, project);
    }
    if (t.delta) {
      if (typeof t.block === "number" && t.block !== st.pendingBlock) { this.flush(id, st); st.pendingBlock = t.block; }
      st.pending += t.delta;
      if (!st.timer) st.timer = setTimeout(() => this.flush(id, st), TEXT_EVERY_MS);
    }
    for (const e of t.events) {
      if (e.type === "thread.text") this.flush(id, st);                // the whole text lands after its last delta
      if (e.type === "thread.text" && e.payload.done && !e.payload.kind && !e.payload.notice) st.lastText = String(e.payload.text || "");
      if (e.type === "thread.finished") {
        this.flush(id, st);
        // The turn's own cost from the running total: a total below the last one is a new count
        // (a fresh process on a transcript with no saved total, or a /clear).
        const total = Number(e.payload.cost_usd) || 0;
        if (st.costBase == null) {
          const row = /** @type {any} */ (this.db.prepare("SELECT cost_total FROM threads_runs WHERE id = ?").get(id));
          st.costBase = st.launch.resume || st.launch.forkFrom ? Number(row && row.cost_total) || 0 : 0;
        }
        const cost = total >= st.costBase ? total - st.costBase : total;
        st.costBase = total;
        this.db.prepare("UPDATE threads_runs SET cost_total = ? WHERE id = ?").run(total, id);
        e.payload.cost_usd = Math.round(cost * 1e6) / 1e6;
        e.payload.total_cost_usd = total;
        this.db.prepare("UPDATE threads_runs SET cost_usd = cost_usd + ?, turns = turns + 1, last_at = ? WHERE id = ?").run(cost, Date.now(), id);
        const tk = e.payload.tokens || {};
        this.db.prepare(`INSERT INTO threads_turns (thread, agent, auth, at, ok, cost_usd, duration_ms, input, output, cache_read, cache_write)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, rec ? rec.agent : null, rec ? rec.auth || "ambient" : "ambient", Date.now(), e.payload.ok ? 1 : 0, cost,
          Number(e.payload.duration_ms) || 0, Number(tk.input) || 0, Number(tk.output) || 0, Number(tk.cache_read) || 0, Number(tk.cache_write) || 0);
        if (st.interrupting) { st.interrupting = false; e.payload.canceled = true; e.payload.reason = "interrupt"; }
        // context: what the last request held, and the model's window (teammates rotate at 60 percent).
        this.emit("thread.usage", { cost_usd: e.payload.cost_usd, total_cost_usd: total, tokens: tk,
          ...(st.used ? { context: { used: st.used, max: st.window || null, ...(st.window ? { share: Math.round((st.used / st.window) * 1000) / 1000 } : {}) } } : {}) }, id, project);
        // A failed turn is said as a state of its own, with its turn, before the thread goes idle.
        if (!e.payload.ok && !e.payload.canceled && !st.stopping) {
          this.emitRaw("thread.state", { state: "failed", turn: st.turn, error: e.payload.error || null }, id, project);
          this.emitRaw("thread.status", { status: "failed", turn: st.turn, error: e.payload.error || null }, id, project);
          this.states.set(id, "failed");
        }
        if (this.asks.open(id).length === 0) this.set(id, { status: "idle" });
        // A one-shot thread (a job, not a conversation) ends with its first answer.
        if (st.launch.once && !st.stopping) { st.done = true; st.stopping = true; setImmediate(() => st.proc.stop()); }
      }
      if (e.type === "thread.tool" && e.payload.phase === "started") { this.set(id, { status: "working" }); st.openTools = st.openTools || new Set(); st.openTools.add(e.payload.call); }
      if (e.type === "thread.tool" && e.payload.phase === "done") { if (st.openTools) st.openTools.delete(e.payload.call); st.steps = (st.steps || 0) + 1; this.releaseSlots(id, st, e.payload.call); }
      // A turn that ends with tool calls still open (an interrupt) cancels them, so no row spins.
      if (e.type === "thread.finished") this.cancelTools(id, st, project);
      const ev = this.emit(e.type, e.payload, id, project);
      if (e.type === "thread.finished" && ev) this.schedulePrune(id, ev.id);
      if (e.type === "thread.finished") this.turnEnded(id, st, project);
      if (e.type === "thread.finished" && st.answered) { const a = st.answered; st.answered = null; a({ text: st.lastText || "", ok: Boolean(e.payload.ok), cost_usd: Number(e.payload.cost_usd) || 0 }); }
    }
    // The floor, before anyone is asked (ADR 0030, "Security"): a call it denies is refused here,
    // not put to the person, whatever the session's own settings say. The Harness runs the same
    // rules at PreToolUse for calls that never reach a question.
    if (t.ask && t.ask.kind === "permission") {
      let v = null;
      try { v = floorRules({ tool: t.ask.tool, input: t.ask.input || {}, cwd: rec ? rec.cwd : undefined, home: this.deps.root || undefined }); } catch {}
      if (v && v.decision === "deny") {
        st.proc.write(answerLine(t.ask.request_id, "deny", t.ask.input, `Vyre's security floor refused this: ${v.reason || "not allowed"}`));
        this.emit("thread.text", { message: "vyre", text: `Refused ${t.ask.tool}: ${cut(v.reason || "the security floor does not allow it", 300)}`, done: true, notice: true }, id, project);
        t.ask = null;
      }
    }
    if (t.ask && t.ask.kind === "permission") {
      // The Changes row: an edit's line counts come from its input, now; a push's from git,
      // which is held for at most GIT_MS and raised without them if git is slower.
      const cwd = rec ? rec.cwd : undefined;
      try { const c = editChanges(t.ask.tool, t.ask.input, cwd); if (c) t.ask.detail = { ...t.ask.detail, ...c }; } catch {}
      const dir = t.ask.tool === "Bash" && cwd ? pushDir(t.ask.input && t.ask.input.command, cwd) : null;
      if (dir) {
        const held = st.held = st.held || new Set();
        const rid = t.ask.request_id, ask = t.ask;
        held.add(rid);
        pushChanges(dir).catch(() => null).then(c => {
          if (!held.delete(rid) || this.live.get(id) !== st) return;       // withdrawn, or the thread ended meanwhile
          if (c) ask.detail = { ...ask.detail, ...c };
          this.raiseAsk(id, st, ask);
        });
      } else this.raiseAsk(id, st, t.ask);
    } else if (t.ask) this.raiseAsk(id, st, t.ask);
    if (t.cancel) {
      if (st.held && st.held.delete(t.cancel)) { /* withdrawn before it was raised */ }
      else {
        const a = this.asks.byRequest(id, t.cancel);
        if (a) this.closeAsk(a, "cancelled", "claude");
      }
    }
    if (t.limit) this.limit(id, st, t.limit, project);
    if (t.limited && st.launch.fallback && !st.switching) this.fallback(id, st);
  }

  /** Record an ask, set the thread waiting and emit ask.raised (small: never a permission's detail). */
  raiseAsk(id, st, ask) {
    const rec = this.record(id);
    const project = rec ? rec.project : null;
    const a = this.asks.raise({ thread: id, request_id: ask.request_id, tool: ask.tool, summary: ask.summary, destination: ask.destination,
      reason: ask.reason ? cut(clip(ask.reason, 2000)) : null, kind: ask.kind, questions: ask.questions, detail: ask.detail, tool_use_id: ask.tool_use_id });
    st.inputs = st.inputs || new Map();
    st.inputs.set(a.id, ask.input);                                        // kept in memory only, to hand back on allow
    if (ask.suggestions) { this.suggestions.set(a.id, ask.suggestions); if (rec && rec.project) this.projectScope(id).catch(() => {}); }
    this.set(id, { status: "waiting" });
    // Small: a question's options without their previews, and never a permission's detail.
    // Surfaces read the whole card from threads.asks.
    const questions = a.kind === "question" ? { questions: (a.questions || []).map(q => ({ ...q, options: q.options.map(({ preview, ...o }) => o) })) } : {};
    const ev = this.emit("ask.raised", { ask: a.id, kind: a.kind, tool: a.tool, tool_use_id: ask.tool_use_id || null, summary: a.summary, destination: a.destination, reason: a.reason, holder: rec ? rec.holder : null,
      agent: a.agent, thread_name: a.thread_name, ...questions }, id, project);
    this.asks.anchored(a.id, ev && ev.id);
  }

  /**
   * Claude Code reported the subscription's rate limit: kept on the thread, emitted as
   * thread.limit, and said in the thread only when it matters: 80% used or more, or refused
   * (once per status). Claude Code warns from much lower (27% was seen), and a notice at 27% is
   * noise in every reply.
   */
  limit(id, st, l, project) {
    this.db.prepare("UPDATE threads_runs SET last_limit = ? WHERE id = ?").run(JSON.stringify({ ...l, at: Date.now() }), id);
    this.emit("thread.limit", l, id, project);
    // The plan's usage per credential, where the usage pause is decided (sessions.usage.*).
    const rec = this.record(id);
    this.deps.call("sessions.usage.report", { auth: (rec && rec.auth) || "ambient", ...l }).catch(() => {});
    if (l.status === "allowed") { st.limitStatus = l.status; return; }
    const loud = l.status === "rejected" || (typeof l.utilization === "number" && l.utilization >= LIMIT_NOTICE_AT);
    if (!loud || st.limitStatus === l.status) return;
    st.limitStatus = l.status;
    this.emit("thread.text", { message: "vyre", text: limitNotice(l), done: true, notice: true }, id, project);
  }

  /** Say something in a thread as Vyre (a notice, not the model). */
  notice(id, text) {
    const rec = this.must(id);
    this.emit("thread.text", { message: "vyre", text: String(text), done: true, notice: true }, id, rec.project);
    return { thread: id, said: true };
  }

  /** Stop a thread with a reason the thread shows (a budget, say). */
  async halt(id, reason, text) {
    if (text) this.notice(id, text);
    const st = this.live.get(id);
    if (!st) return { thread: id, stopped: false, note: "not running" };
    st.haltReason = String(reason);
    st.stopping = true;
    await st.proc.stop();
    return { thread: id, stopped: true };
  }

  /**
   * Usage from the turns table: per agent (null for threads no agent ran), since a time.
   * @param {{ agent?: string, since?: number }} o
   */
  usage({ agent, since = 0 } = {}) {
    const rows = /** @type {any[]} */ (this.db.prepare(`SELECT agent, auth, COUNT(*) AS turns, SUM(cost_usd) AS cost_usd, SUM(duration_ms) AS duration_ms,
        SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, COUNT(DISTINCT thread) AS threads, MAX(at) AS last_at
      FROM threads_turns WHERE at >= ? ${agent ? "AND agent = ?" : ""} GROUP BY agent, auth`).all(Number(since) || 0, ...(agent ? [agent] : [])));
    /** @type {Map<string|null, any>} */
    const by = new Map();
    for (const r of rows) {
      const a = by.get(r.agent) || { agent: r.agent, turns: 0, threads: 0, duration_ms: 0, cost_usd: 0, api_cost_usd: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, by_auth: {}, last_at: 0 };
      a.turns += r.turns; a.threads += r.threads; a.duration_ms += r.duration_ms; a.cost_usd += r.cost_usd;
      if (r.auth === "api-key") a.api_cost_usd += r.cost_usd;
      for (const k of ["input", "output", "cache_read", "cache_write"]) a.tokens[k] += r[k];
      a.by_auth[r.auth] = { turns: r.turns, duration_ms: r.duration_ms, cost_usd: r.cost_usd };
      a.last_at = Math.max(a.last_at, r.last_at);
      by.set(r.agent, a);
    }
    for (const a of by.values()) {
      const l = /** @type {any} */ (this.db.prepare(`SELECT last_limit FROM threads_runs WHERE ${a.agent == null ? "agent IS NULL" : "agent = ?"} AND last_limit IS NOT NULL
        ORDER BY json_extract(last_limit, '$.at') DESC LIMIT 1`).get(...(a.agent == null ? [] : [a.agent])));
      a.limit = l ? JSON.parse(String(l.last_limit)) : null;
    }
    return [...by.values()];
  }

  /** Send what partial text has built up, as one event. */
  flush(id, st) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (!st.pending && !st.rpending) return;
    const rec = this.record(id);
    if (st.rpending) { const delta = st.rpending; st.rpending = ""; this.emit("thread.thinking", { message: st.message, block: st.pendingBlock, delta }, id, rec ? rec.project : null); }
    if (st.pending) { const delta = st.pending; st.pending = ""; this.emit("thread.text", { message: st.message, block: st.pendingBlock, delta }, id, rec ? rec.project : null); }
  }

  /**
   * The subscription's limit was reached: carry on under the API key if the agent allows one,
   * within its budget, and say so in the thread. The turn that failed is sent again.
   */
  async fallback(id, st) {
    st.switching = true;
    const fb = st.launch.fallback;
    const rec = this.record(id);
    await st.proc.stop();
    for (const a of this.asks.open(id)) this.closeAsk(a, "cancelled", "switched to the API key");
    const budget = typeof fb.budget_usd === "number" ? fb.budget_usd : null;
    this.emit("thread.text", { message: "vyre", text: `The subscription's limit was reached. Continuing on the API key${budget != null ? `, with $${budget.toFixed(2)} of budget left` : ""}.`, done: true, notice: true }, id, rec ? rec.project : null);
    this.db.prepare("UPDATE threads_runs SET auth = 'api-key' WHERE id = ?").run(id);
    this.spawn(id, { ...st.launch, env: fb.env, fallback: undefined, budget_usd: budget ?? undefined, resume: true, lastPrompt: st.lastPrompt });
    if (st.lastPrompt) this.write(id, st.lastPrompt);
  }

  onExit(id, st, code, signal, stderr) {
    this.flush(id, st);
    if (this.live.get(id) === st) { this.cancelTools(id, st, null); this.releaseSlots(id, st); }
    if (st.idle) { clearTimeout(st.idle); st.idle = null; }
    if (st.switching || this.live.get(id) !== st) return;               // replaced (fallback): not an end
    this.live.delete(id);
    this.closeSocket(id);
    const reason = st.haltReason || (st.done ? "done" : st.stopping ? "stopped" : code === 0 ? "exited" : `exited ${code ?? signal}${stderr ? ": " + cut(stderr, 160) : ""}`);
    this.set(id, { status: "stopped", pid: null, stopped_reason: reason });
    for (const a of this.asks.open(id)) this.closeAsk(a, "cancelled", "thread stopped");
    const rec = this.record(id);
    this.emit("thread.stopped", { code: code ?? null, reason }, id, rec ? rec.project : null);
  }

  /**
   * @param {any} a @param {string} decision @param {string|null} by @param {Record<string, string>|null} [answers] what was chosen, as shown
   * @param {string|null} [scope] "project" for an "always in <project>"
   */
  closeAsk(a, decision, by, answers = null, scope = null, device = null) {
    this.suggestions.delete(a.id);
    if (!this.asks.close(a.id, decision, by)) return false;
    const rec = this.record(a.thread);
    this.emit("ask.answered", { ask: a.id, decision, by: by || null, ...(device ? { device } : {}), tool: a.tool, summary: a.summary || null, ...(answers ? { answers } : {}), ...(scope ? { scope } : {}) },
      a.thread, rec ? rec.project : null);
    return true;
  }

  /**
   * Hand words to a live session. A new turn unless `steer`: then the words join the running turn
   * at Claude's next step (priority "next"), and thread.steered says when they were taken in.
   * @param {string} id @param {string} text @param {{ uuid?: string, steer?: boolean }} [o]
   * @returns {{ uuid: string, turn: string|null }}
   */
  write(id, text, { uuid = crypto.randomUUID(), steer = false, images = null } = {}) {
    const st = this.live.get(id);
    this.touch(id, st);
    this.db.prepare("INSERT OR IGNORE INTO threads_sent (uuid, thread, at) VALUES (?,?,?)").run(uuid, id, Date.now());
    st.lastPrompt = text;
    if (steer) {
      st.steers.set(uuid, String(text));
      this.db.prepare("INSERT OR REPLACE INTO threads_steers (uuid, thread, text, images, at) VALUES (?,?,?,?,?)").run(uuid, id, String(text), imagesJson(images), Date.now());
      st.proc.write(userLine(text, id, { uuid, priority: "next", ...(images ? { images } : {}) }));
      return { uuid, turn: st.turn };
    }
    st.turn = `${id}:${++st.turnNo}`;
    st.ord.clear();
    st.steps = 0;
    // `!` shell lines the person ran since the last message go with this one, as Claude Code does.
    const shells = this.shellContext.get(id);
    if (shells) this.shellContext.delete(id);
    st.proc.write(userLine(shells ? `${shells.join("\n")}\n\n${text}` : text, id, { uuid, ...(images ? { images } : {}) }));
    this.set(id, { status: "working" });
    const rec = this.record(id);
    this.emit("thread.turn", { turn: st.turn, uuid, text: cut(text, 2000) }, id, rec ? rec.project : null);
    return { uuid, turn: st.turn };
  }

  /**
   * A turn ended. Steered words Claude Code did not fold in run as the next turn, as it does; else
   * words queued for after this turn (threads.send mode "queue") are handed over as one turn, each
   * announced first (thread.sent via "turn"), marked delivered in the same step so they can no
   * longer be taken back.
   */
  turnEnded(id, st, project) {
    st.turn = null;
    this.releaseSlots(id, st);
    if (this.live.get(id) !== st || st.stopping) return;
    if (st.steers.size) {
      const [[uuid, text], ...rest] = [...st.steers.entries()];
      st.steers.clear();
      this.db.prepare("DELETE FROM threads_steers WHERE thread = ?").run(id);
      st.turn = `${id}:${++st.turnNo}`;
      st.ord.clear();
      this.set(id, { status: "working" });
      this.emit("thread.turn", { turn: st.turn, uuid, text: cut([text, ...rest.map(r => r[1])].join("\n\n"), 2000), steered: true }, id, project);
      return;
    }
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT id, text, surface, uuid, kind, images, request FROM threads_inbox WHERE thread = ? AND delivered_at IS NULL ORDER BY id").all(id));
    if (!rows.length) return;
    const now = Date.now();
    const mark = this.db.prepare("UPDATE threads_inbox SET delivered_at = ?, via = 'turn' WHERE id = ? AND delivered_at IS NULL");
    const taken = rows.filter(r => mark.run(now, r.id).changes);
    if (!taken.length) return;
    for (const r of taken) this.emit("thread.sent", { text: cut(r.text, 2000), surface: r.surface, queued: Number(r.id), uuid: r.uuid || null, via: "turn", ...(r.kind ? { kind: r.kind } : {}), ...(r.request ? { request: r.request } : {}) }, id, project);
    const images = taken.flatMap(r => imagesFrom(r.images) || []);
    this.write(id, taken.map(r => r.text).join("\n\n"), { uuid: taken[0].uuid || crypto.randomUUID(), images: images.length ? images : null });
  }

  /**
   * Steered words a stopped process never took in (st.steers lived only in its memory): after a
   * resume they run first, as one turn, with their images. Emits thread.sent via "restored".
   */
  restoreSteers(id) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT uuid, text, images FROM threads_steers WHERE thread = ? ORDER BY at").all(id));
    if (!rows.length || !this.live.has(id)) return;
    this.db.prepare("DELETE FROM threads_steers WHERE thread = ?").run(id);
    const rec = this.record(id);
    for (const r of rows) this.emit("thread.sent", { text: cut(r.text, 2000), surface: null, uuid: r.uuid, via: "restored" }, id, rec ? rec.project : null);
    const images = rows.flatMap(r => imagesFrom(r.images) || []);
    this.write(id, rows.map(r => r.text).join("\n\n"), { uuid: rows[0].uuid, images: images.length ? images : null });
  }

  /**
   * Does this machine have the thread: running here, recorded here, or a transcript here that
   * send could adopt? What threads.send on the box checks before it asks a Mac.
   * @param {string} id
   */
  knows(id) {
    return this.live.has(id) || Boolean(this.record(id)) || Boolean(findSession(this.deps.transcripts || [], id));
  }

  /** Our children's pids: a session bound to one of these is ours, not open elsewhere. */
  ours() { return [...this.live.values()].map(st => (st.group && st.group.pid) || (st.proc && st.proc.pid)).filter(Boolean); }

  /**
   * Every session's process group and session id still in use, for the peer check: a process
   * that detached from its session's tree (nohup, setsid, a double fork) still carries them, until
   * the whole group is gone.
   */
  groupIds() {
    for (const pgid of [...this.groups.keys()]) if (!groupAlive(pgid)) this.groups.delete(pgid);
    return { pgids: [...this.groups.keys()], sids: [...new Set(this.groups.values())] };
  }

  /**
   * Before resuming a thread that is not running here: is it open somewhere else (adopt.js)?
   * @param {string} id @returns {string|null} why it is, or null
   */
  elsewhere(id) {
    const t = findSession(this.deps.transcripts || [], id);
    const rec = this.record(id);
    return openElsewhere({ id, mtime: t ? t.mtime : 0, boundPid: this.sessions.boundPid(id), ours: this.ours(), alive, naming: this.deps.naming,
      ourLast: rec && rec.stopped_reason !== "adopted" ? rec.last : null });
  }

  /**
   * Take on a session the Switchboard did not start (a terminal `claude`), so it can be resumed
   * here. Only its record is made; send resumes it. No transcript, no thread.
   * @param {string} id
   */
  async adopt(id) {
    const t = findSession(this.deps.transcripts || [], id);
    if (!t) throw new Error(`no thread ${id}`);
    const info = sessionInfo(t.file);
    if (!info.cwd || !fs.existsSync(info.cwd)) throw new Error(`session ${id.slice(0, 8)} ran in ${info.cwd || "a folder its transcript does not name"}, which is not here`);
    const of = await this.deps.call("projects.of", { cwd: info.cwd });
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO threads_runs (id, name, cwd, project, status, auth, started_at, last_at, stopped_reason)
      VALUES (?,?,?,?, 'stopped', 'ambient', ?,?, 'adopted')`).run(id, info.name, info.cwd, of.data?.slug || null, t.mtime, now);
    return this.must(id);
  }

  /**
   * Type into a thread. The lease decides who may. A thread that is not running here is resumed
   * first, and a session the Switchboard never started is adopted; either only if no other
   * process has it open, since one transcript takes one writer. One that is open elsewhere (a
   * terminal) is not typed into: a person's words are queued instead, and the Harness hands them
   * over when that session's turn ends (queue). `queue` false (a model's call) keeps the refusal.
   * `wait` (the person at the box, through the link) never takes the keyboard: while another
   * surface holds it, the words are queued as for a terminal.
   */
  async send(id, text, surface, { queue = true, wait = false, mode = "steer", uuid = undefined, kind = undefined, images = null } = {}) {
    // The same message again (a retry whose first answer was lost): already handed over or queued.
    if (uuid) {
      const was = /** @type {any} */ (this.db.prepare("SELECT thread FROM threads_sent WHERE uuid = ?").get(uuid))
        || this.db.prepare("SELECT thread, id AS queued FROM threads_inbox WHERE uuid = ?").get(uuid);
      if (was) return { sent: true, already: true, thread: String(was.thread), uuid, ...(was.queued ? { queued_id: Number(was.queued) } : {}) };
    }
    if (!this.live.has(id)) {
      if (!this.record(id)) await this.adopt(id);
      const why = this.elsewhere(id);
      if (why && queue) return this.queue(id, text, surface, undefined, { ...(uuid ? { uuid } : {}), kind });
      if (why) return { sent: false, open_elsewhere: true, note: `This session is open somewhere else: ${why}. Only one keyboard can type into it, so close it there or type there.` };
    }
    const rec = this.must(id);
    const held = wait && this.leases.holder(id);
    if (held && held.surface !== surface) return this.queue(id, text, surface, held.surface, uuid ? { uuid } : {});
    const lease = this.leases.typing(id, surface);
    if (!lease.ok) return { sent: false, holder: lease.holder, note: `${lease.holder} has the keyboard; threads.lease takes it` };
    if (lease.took) this.emit("lease.changed", { holder: surface, previous: lease.took.previous, ...(lease.took.took ? { took: lease.took.took } : {}) }, id, rec.project);
    if (!this.live.has(id)) {
      // An agent's thread comes back with the agent's own credentials and scope, which only the
      // agents module can give it; any other thread resumes as it was.
      if (rec.agent) {
        const r = await this.deps.call("agents.resume", { agent: rec.agent, thread: id });
        if (r.error) return { sent: false, note: `could not resume ${rec.agent}'s thread: ${r.error.message}` };
      } else await this.launch({ resume: id });
    }
    // While a turn runs: steer into it (the default, as Claude Code does), or queue for after it.
    const st = this.live.get(id);
    const busy = Boolean(st && st.turn) && ["working", "waiting"].includes(String(this.must(id).status));
    if (busy && mode === "queue") return this.queue(id, text, surface, null, { owned: true, uuid, kind, images });
    if (busy) {
      const w = this.write(id, text, { steer: true, ...(uuid ? { uuid } : {}), images });
      this.emit("thread.sent", { text: cut(text, 2000), surface, uuid: w.uuid, via: "steer" }, id, rec.project);
      return { sent: true, steered: true, thread: id, uuid: w.uuid, turn: w.turn };
    }
    const w = this.write(id, text, { ...(uuid ? { uuid } : {}), images });
    this.emit("thread.sent", { text: cut(text, 2000), surface, uuid: w.uuid, ...(kind ? { kind } : {}), ...(images ? { images: images.length } : {}) }, id, rec.project);
    return { sent: true, thread: id };
  }

  /**
   * A module's words (a teammate's result): never steer and never need the keyboard. A new turn
   * when the thread is idle here, queued for the turn's end when one runs, and for a session open
   * in a terminal, queued as a person's words are.
   */
  async post(id, text, from, kind, request) {
    if (!this.live.has(id)) {
      if (!this.record(id)) await this.adopt(id);
      if (this.elsewhere(id)) return this.queue(id, text, from, undefined, { kind, request });
      const rec = this.must(id);
      if (rec.agent) {
        const r = await this.deps.call("agents.resume", { agent: rec.agent, thread: id });
        if (r.error) return { sent: false, note: `could not resume ${rec.agent}'s thread: ${r.error.message}` };
      } else await this.launch({ resume: id });
    }
    const st = this.live.get(id);
    const rec = this.must(id);
    if (st.turn && ["working", "waiting"].includes(String(rec.status))) return this.queue(id, text, from, null, { owned: true, kind, request });
    const w = this.write(id, text);
    this.emit("thread.sent", { text: cut(text, 2000), surface: from, uuid: w.uuid, via: "post", kind, ...(request ? { request } : {}) }, id, rec.project);
    return { sent: true, thread: id, uuid: w.uuid, turn: w.turn };
  }

  /**
   * Keep words for a session another process has open. Nothing is typed into it: the Harness's
   * Stop hook in that session hands them to Claude when its current turn ends (deliver), or its
   * next prompt does when it is idle. Emits thread.queued. `busy` in the answer is "terminal", or
   * the surface holding the keyboard when that is why (a send with `wait`).
   * @param {string} id @param {string} text @param {string} surface @param {string} [holder]
   */
  queue(id, text, surface, holder, { owned = false, uuid = crypto.randomUUID(), kind = undefined, request = undefined, images = /** @type {any} */ (null) } = {}) {
    const rec = this.must(id);
    // A session open elsewhere takes queued words through its hooks, which carry text only.
    if (images && images.length && !owned) throw Object.assign(new Error("images cannot wait for a session open in a terminal; send them when it is free here"), { code: "bad_input" });
    const r = this.db.prepare("INSERT INTO threads_inbox (thread, text, surface, at, uuid, kind, images, request) VALUES (?,?,?,?,?,?,?,?)").run(id, String(text), surface, Date.now(), uuid, kind || null, imagesJson(images), request || null);
    const queued = Number(r.lastInsertRowid);
    this.emit("thread.queued", { queued, uuid, text: cut(text, 2000), surface, ...(kind ? { kind } : {}), ...(request ? { request } : {}), ...(images && images.length ? { images: images.length } : {}) }, id, rec.project);
    const name = rec.name || id.slice(0, 8);
    // A session Vyre runs is never called a terminal (it is working, and the words go in after).
    if (owned) return { sent: false, queued: true, queued_id: queued, uuid, thread: id, name, busy: "working",
      note: `${name} is working on something. I'll hand it your message when this turn ends.` };
    return { sent: false, queued: true, queued_id: queued, uuid, open_elsewhere: true, thread: id, name, busy: holder || "terminal",
      note: holder ? `${name} is in use in ${holder}. I'll hand it your message when this turn ends.`
        : `${name} is busy in your terminal. I'll hand it your message when this turn ends.` };
  }

  /**
   * Take back queued words not handed over yet: one (queued, its row id) or all of the thread's.
   * Words already handed over are Claude's now and stay. Emits thread.unqueued per message.
   * @param {string} id @param {number} [queued] @param {string} [surface]
   */
  unqueue(id, queued, surface) {
    const rec = this.must(id);
    const rows = /** @type {any[]} */ (queued == null
      ? this.db.prepare("SELECT id, uuid FROM threads_inbox WHERE thread = ? AND delivered_at IS NULL ORDER BY id").all(id)
      : this.db.prepare("SELECT id, uuid FROM threads_inbox WHERE thread = ? AND id = ? AND delivered_at IS NULL").all(id, Number(queued)));
    const del = this.db.prepare("DELETE FROM threads_inbox WHERE id = ? AND delivered_at IS NULL");
    const out = [];
    for (const m of rows) {
      if (!del.run(m.id).changes) continue;
      out.push(Number(m.id));
      this.emit("thread.unqueued", { queued: Number(m.id), uuid: m.uuid || null, reason: "taken", surface: surface || null }, id, rec.project);
    }
    const note = out.length ? null : queued == null ? "Nothing is waiting to be handed over." : "That message was already handed over, or was never queued here.";
    return { unqueued: out, ...(note ? { note } : {}) };
  }

  /** Change queued words before they are handed over. Re-emits thread.queued with the same ids. */
  edit(id, queued, text, surface) {
    const rec = this.must(id);
    const row = /** @type {any} */ (this.db.prepare("SELECT id, uuid, surface FROM threads_inbox WHERE thread = ? AND id = ? AND delivered_at IS NULL").get(id, Number(queued)));
    if (!row || !this.db.prepare("UPDATE threads_inbox SET text = ? WHERE id = ? AND delivered_at IS NULL").run(String(text), row.id).changes) {
      return { edited: false, note: "That message was already handed over, or was never queued here." };
    }
    this.emit("thread.queued", { queued: Number(row.id), uuid: row.uuid || null, text: cut(text, 2000), surface: surface || row.surface, edited: true }, id, rec.project);
    return { edited: true, queued: Number(row.id) };
  }

  /**
   * Send queued words now instead of after the turn: steered into the running turn at Claude's
   * next step (or a turn of their own when none runs). Not for a session in a terminal, which
   * Vyre cannot reach mid-turn.
   */
  sendNow(id, queued) {
    const rec = this.must(id);
    const st = this.live.get(id);
    if (!st) return { sent: false, note: "This session is not running here; its words are handed over when its terminal's turn ends." };
    const row = /** @type {any} */ (this.db.prepare("SELECT id, text, surface, uuid, images, request FROM threads_inbox WHERE thread = ? AND id = ? AND delivered_at IS NULL").get(id, Number(queued)));
    if (!row || !this.db.prepare("UPDATE threads_inbox SET delivered_at = ?, via = 'now' WHERE id = ? AND delivered_at IS NULL").run(Date.now(), row.id).changes) {
      return { sent: false, note: "That message was already handed over, or was never queued here." };
    }
    const uuid = row.uuid || crypto.randomUUID();
    const w = this.write(id, row.text, { uuid, steer: Boolean(st.turn), images: imagesFrom(row.images) });
    this.emit("thread.sent", { text: cut(row.text, 2000), surface: row.surface, queued: Number(row.id), uuid, via: "now", ...(row.request ? { request: row.request } : {}) }, id, rec.project);
    return { sent: true, thread: id, queued: Number(row.id), uuid, turn: w.turn };
  }

  /**
   * The Harness, at a Stop or a prompt in this session: the words queued for it, marked handed
   * over. Each is emitted as thread.sent {queued, via}, which is when it reached Claude.
   * @param {string} id @param {"stop"|"prompt"} via
   */
  deliver(id, via) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT id, text, surface, at, request FROM threads_inbox WHERE thread = ? AND delivered_at IS NULL ORDER BY id").all(id));
    if (!rows.length) return { messages: [] };
    const now = Date.now();
    const mark = this.db.prepare("UPDATE threads_inbox SET delivered_at = ?, via = ? WHERE id = ?");
    const rec = this.record(id);
    for (const m of rows) {
      mark.run(now, via, m.id);
      this.emit("thread.sent", { text: cut(m.text, 2000), surface: m.surface, queued: m.id, via, ...(m.request ? { request: m.request } : {}) }, id, rec ? rec.project : null);
    }
    return { messages: rows.map(m => ({ id: m.id, text: m.text, surface: m.surface, at: m.at })) };
  }

  /**
   * The Harness, at the Stop that ends the turn answering handed-over words: Claude's last message
   * becomes the reply (thread.text, then thread.finished), the way a headless thread's would.
   * @param {string} id @param {string} text
   */
  replied(id, text) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT id FROM threads_inbox WHERE thread = ? AND delivered_at IS NOT NULL AND replied_at IS NULL ORDER BY id").all(id));
    if (!rows.length) return { replied: 0 };
    this.db.prepare("UPDATE threads_inbox SET replied_at = ? WHERE thread = ? AND delivered_at IS NOT NULL AND replied_at IS NULL").run(Date.now(), id);
    const rec = this.record(id);
    const project = rec ? rec.project : null;
    if (text) this.emit("thread.text", { message: `inbox-${rows.at(-1).id}`, text: String(text), done: true }, id, project);
    this.emit("thread.finished", { ok: true, via: "terminal" }, id, project);
    return { replied: rows.length };
  }

  lease(id, surface) {
    const rec = this.must(id);
    const r = this.leases.take(id, surface);
    if (r.changed) this.emit("lease.changed", { holder: surface, previous: r.previous, ...(r.took ? { took: r.took } : {}) }, id, rec.project);
    return { thread: id, holder: r.holder, previous: r.previous, ...(r.took ? { took: r.took } : {}) };
  }

  release(id, surface) {
    const rec = this.must(id);
    const r = this.leases.release(id, surface);
    if (r.released) this.emit("lease.changed", { holder: null, previous: surface || null }, id, rec.project);
    return { thread: id, ...r };
  }

  /**
   * Answer a permission question or a question. The ask id is the capability; the decision reaches
   * Claude Code first, then the row closes. A question is answered with `answers` (keyed by the
   * question as shown) or declined with "deny"; "always" allows and hands back Claude Code's suggestions.
   * `scope: "project"` with "always" writes the rule for the thread's project instead (projectRules).
   * @param {string} askId @param {"allow"|"deny"|"always"} decision @param {string} by @param {string} [message]
   * @param {Record<string, string|string[]>} [answers] @param {"project"} [scope]
   */
  async answer(askId, decision, by, message, answers, scope, device = null) {
    const a = this.asks.get(askId);
    if (!a) throw new Error(`no ask ${askId}`);
    // The same answer again (a retry after a lost response, a forward from the box) is the earlier
    // outcome, not a failure (ADR 0029 R2). A different one is refused: the first answer stands.
    if (a.state === "answered" && a.decision === decision) return { ask: askId, answered: true, decision, already: true };
    if (a.state !== "open") return { ask: askId, answered: false, note: `already ${a.state}${a.decision ? " (" + a.decision + ")" : ""}` };
    const st = this.live.get(a.thread);
    if (!st) { this.closeAsk(a, "cancelled", "thread stopped"); return { ask: askId, answered: false, note: "the thread has stopped" }; }
    const input = st.inputs && st.inputs.get(askId);
    let extra = {}, shown = null;
    if (a.kind === "question" && decision !== "deny") {
      if (decision === "always") throw new Error("a question is answered (allow with answers) or declined (deny); always is for permissions");
      ({ sent: extra, shown } = this.questionAnswers(a, input, answers));
    } else if (decision === "always") {
      const permissions = this.suggestions.get(askId);
      if (!permissions) throw new Error(`always allow is not on offer for ask ${askId}; allow or deny it`);
      if (scope === "project") {
        const sc = await this.projectScope(a.thread);
        if (!sc) throw new Error(`always in a project needs a thread in its project's folder; thread ${String(a.thread).slice(0, 8)} is not in one`);
        extra = { permissions: projectRules(a.tool, permissions) };
      } else extra = { permissions: safePermissions(permissions) };
    }
    // The answer may have waited on the project lookup: the ask can have closed meanwhile.
    if (this.asks.get(askId)?.state !== "open" || !this.live.has(a.thread)) return { ask: askId, answered: false, note: "it closed while being answered" };
    st.proc.write(answerLine(a.request_id, decision, input, message, extra));
    st.inputs && st.inputs.delete(askId);
    this.closeAsk(a, decision, by, shown, decision === "always" && scope === "project" ? "project" : null, device);
    if (this.asks.open(a.thread).length === 0) this.set(a.thread, { status: "working" });
    return { ask: askId, answered: true, decision };
  }

  /**
   * The project an "always in <project>" rule is for: the thread's project, when the thread runs in
   * that project's home or one of its folders (the rule lands in the thread's folder). Kept per
   * thread so the ask object can say it without waiting.
   * @param {string} id
   */
  async projectScope(id) {
    const rec = this.record(id);
    let sc = null;
    if (rec && rec.project && this.deps.call) {
      const of = await this.deps.call("projects.of", { cwd: rec.cwd });
      const p = of && of.data;
      if (p && p.slug === rec.project && p.home) {
        const home = path.resolve(String(p.home));
        const folders = (Array.isArray(p.folders) ? p.folders : []).map(f => path.resolve(home, String(f)));
        if (path.resolve(rec.cwd) === home || folders.includes(path.resolve(rec.cwd))) sc = { slug: rec.project, name: String(p.name || rec.project), cwd: rec.cwd };
      }
    }
    this.scopes.set(id, sc);
    return sc;
  }

  /**
   * A question's answers, checked against its questions. Surfaces key them by the question as shown
   * (redacted and capped); Claude Code expects its own text, so each is matched to its question by
   * position. Returns what is sent, and what the ask.answered event may say (shown keys, capped).
   * @param {any} a @param {any} input @param {Record<string, string|string[]>|undefined} answers
   */
  questionAnswers(a, input, answers) {
    const shownQs = a.questions || [];
    const realQs = input && Array.isArray(input.questions) ? input.questions : shownQs;
    /** @type {Record<string, string>} */ const sent = {};
    /** @type {Record<string, string>} */ const shown = {};
    for (const [k, v] of Object.entries(answers || {})) {
      let n = shownQs.findIndex(q => q.question === k);
      if (n < 0) n = realQs.findIndex(q => q && q.question === k);
      if (n < 0 || !realQs[n]) throw new Error(`ask ${a.id} has no question "${cut(k, 80)}"`);
      const text = (Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "")).slice(0, 4000);
      sent[String(realQs[n].question)] = text;
      shown[shownQs[n] ? shownQs[n].question : cut(k, CAPS.question)] = clip(text, CAPS.answer);
    }
    if (!Object.keys(sent).length) throw new Error("answer a question with answers: { [question]: answer }, or decline it with deny");
    return { sent: { answers: sent }, shown };
  }

  /**
   * Put a thread in a permission mode (as Shift+Tab does in Claude Code): default, acceptEdits or
   * plan. The person's own act (PERSON_ONLY); a model or an agent never changes a mode, and
   * nothing reaches bypassPermissions.
   * @param {string} id @param {string} mode
   */
  async mode(id, mode) {
    if (!PERSON_MODES.includes(mode)) throw Object.assign(new Error(`mode must be one of ${PERSON_MODES.join(", ")}`), { code: "bad_input" });
    const st = this.live.get(id);
    if (!st) return { thread: id, mode: null, note: "not running; the mode applies to a running session" };
    if (mode === BYPASS && !st.withPlugin) {
      throw Object.assign(new Error("Doesn't ask needs Vyre's plugin in the session, so the security floor still runs; this one started without it"), { code: "refused" });
    }
    if (st.proc.setMode) await st.proc.setMode(mode);
    else st.proc.write({ type: "control_request", request_id: `vyre-mode-${Date.now()}`, request: { subtype: "set_permission_mode", mode } });
    st.mode = mode;
    this.db.prepare("UPDATE threads_runs SET mode = ? WHERE id = ?").run(mode, id);
    const rec = this.record(id);
    this.emit("mode.changed", { mode, label: MODE_LABELS[mode] }, id, rec ? rec.project : null);
    return { thread: id, mode };
  }

  /**
   * Rewind to a message, as a double Esc does in Claude Code: the conversation goes back to just
   * before that message (the message and everything after it are left on a branch the session no
   * longer follows), and the message's words come back for the composer to edit and send again.
   * The same thread and transcript; a running turn is stopped first.
   * @param {string} id @param {string} uuid the user message (thread.turn's uuid, the transcript line's)
   */
  /** The user turn named by uuid, in this session's transcript here (rewind and forkAt share the lookup). */
  findLine(id, uuid) {
    const t = findSession(this.deps.transcripts || [], id);
    if (!t) throw Object.assign(new Error("this session has no transcript here to rewind"), { code: "bad_input" });
    let line = null;
    for (const l of fs.readFileSync(t.file, "utf8").split("\n")) {
      if (!l.includes(uuid)) continue;
      try { const j = JSON.parse(l); if (j.uuid === uuid && j.type === "user") { line = j; break; } } catch {}
    }
    if (!line) throw Object.assign(new Error(`no message ${String(uuid).slice(0, 8)} in this session`), { code: "bad_input" });
    return line;
  }

  /**
   * A new thread with this session's conversation up to (not including) a turn, that the
   * original never sees - "fork from here" (rewind's own, in-place, the other menu item).
   * @param {string} id @param {string} uuid @param {{ prompt?: string, name?: string, surface?: string }} [opts]
   */
  async forkAt(id, uuid, opts = {}) {
    const line = this.findLine(id, uuid);
    if (!line.parentUuid) throw Object.assign(new Error("that is the first message: fork the whole session instead"), { code: "bad_input" });
    return this.launch({ fork: id, resumeAt: String(line.parentUuid), prompt: opts.prompt, name: opts.name, surface: opts.surface });
  }

  async rewind(id, uuid, restore = "conversation") {
    const rec = this.must(id);
    const line = this.findLine(id, uuid);
    const text = typeof line.message?.content === "string" ? line.message.content
      : (Array.isArray(line.message?.content) ? line.message.content.filter(b => b && b.type === "text").map(b => b.text).join("\n") : "");
    // The files first, while the session that made the changes is running: Claude Code puts back
    // what its tools changed since that message (its file checkpoints).
    let files = null;
    if (restore === "code" || restore === "both") {
      if (!this.live.has(id)) await this.launch({ resume: id });
      const live = this.live.get(id);
      if (!live || !live.proc.control) throw Object.assign(new Error("this session cannot put files back"), { code: "unavailable" });
      const r = await live.proc.control("rewind_files", { user_message_id: uuid });
      files = { restored: true, ...(r && Array.isArray(r.filesChanged) ? { files_changed: r.filesChanged } : {}), ...(r && r.canRewind === false ? { restored: false, why: r.error || "no checkpoint" } : {}) };
      if (restore === "code") {
        this.emit("thread.rewound", { uuid, restore, files }, id, rec.project);
        return { rewound: true, id, thread: id, uuid, restore, files };
      }
    }
    if (!line.parentUuid) return { rewound: false, id, thread: id, text, note: "That is the first message: start a new session with it instead.", ...(files ? { files } : {}) };
    const st = this.live.get(id);
    if (st) await this.close(id, st, "rewind");
    await this.launch({ resume: id, resumeAt: String(line.parentUuid) });
    this.emit("thread.rewound", { uuid, at: String(line.parentUuid), restore, ...(files ? { files } : {}) }, id, rec.project);
    return { rewound: true, id, thread: id, uuid, text, ...(restore !== "conversation" ? { restore, files } : {}) };
  }

  /**
   * Switch a running thread's model (as /model does). The record and the chip follow.
   * @param {string} id @param {string} model
   */
  async switchModel(id, model) {
    if (!/^[A-Za-z0-9._:\[\]-]{1,80}$/.test(String(model))) throw Object.assign(new Error("a model is an alias like opus or haiku, or a model id"), { code: "bad_input" });
    const rec = this.must(id);
    const st = this.live.get(id);
    if (st && st.proc.control) await st.proc.control("set_model", { model });
    this.db.prepare("UPDATE threads_runs SET model = ? WHERE id = ?").run(String(model), id);
    this.emit("model.switched", { model: String(model), live: Boolean(st) }, id, rec.project);
    return { thread: id, model: String(model), ...(st ? {} : { note: "applies when the thread next runs" }) };
  }

  /**
   * Set a thread's reasoning effort, as /effort does: a running thread at once (the SDK's flag
   * settings), a stopped one when it next runs. Kept with the thread's launch, so a resume keeps it.
   * @param {string} id @param {string|null} effort null goes back to the model's default
   */
  async switchEffort(id, effort) {
    const e = effortOf(effort);
    const rec = this.must(id);
    const st = this.live.get(id);
    if (st && st.proc.control) await st.proc.control("apply_flag_settings", { settings: { effortLevel: e } });
    const row = /** @type {any} */ (this.db.prepare("SELECT opts FROM threads_runs WHERE id = ?").get(id));
    const kept = optsOf(row);
    if (e) kept.effort = e; else delete kept.effort;
    this.db.prepare("UPDATE threads_runs SET opts = ? WHERE id = ?").run(JSON.stringify(kept), id);
    if (st) st.launch = { ...st.launch, effort: e || undefined };
    this.emit("effort.switched", { effort: e, live: Boolean(st) }, id, rec.project);
    return { thread: id, effort: e, ...(st ? {} : { note: "applies when the thread next runs" }) };
  }

  /**
   * One question to a purpose's warm session (Vyre IQ's "memory", ADR 0034's latency target): a
   * lean session (no plugin, no tools, none of the user's settings) already started and waiting,
   * so the answer does not pay Claude Code's start. Each question gets a fresh one, never one that
   * heard another question: the one used is closed when it answers, and a new spare starts behind
   * it. Nothing is started before the first question (light by default); a spare nobody uses
   * closes after sessions.idle_minutes, as every idle session does. The system text is fixed per
   * spare, so the question's own material goes in `prompt`.
   * @param {{ purpose: string, system?: string|null, prompt: string, model?: string|null, timeoutMs?: number }} o
   * @returns {Promise<{ text: string, ok: boolean, cost_usd: number, warm: boolean, ms: number, thread: string }>}
   */
  async quick({ purpose, system = null, prompt, model = null, timeoutMs = 60_000 }) {
    const t0 = Date.now();
    const key = `${purpose}\u0000${model || ""}\u0000${crypto.createHash("sha256").update(String(system || "")).digest("hex")}`;
    this.spares = this.spares || new Map();
    let id = this.spares.get(key);
    this.spares.delete(key);
    const warm = Boolean(id && this.live.has(id) && !this.live.get(id).turn);
    if (!warm) id = (await this.spare(purpose, system, model)).id;
    const st = this.live.get(id);
    if (!st) throw new Error(`the ${purpose} session did not start`);
    const answer = new Promise((resolve, reject) => {
      st.answered = resolve;
      const t = setTimeout(() => { st.answered = null; reject(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: "timeout" })); }, timeoutMs);
      t.unref?.();
    });
    this.write(id, String(prompt));
    // The next question's session starts now, while this one answers.
    if (!this.closing) {
      const next = this.spare(purpose, system, model)
        .then(r => { if (this.closing || this.spares.has(key)) return this.stop(r.id).catch(() => {}); this.spares.set(key, r.id); })
        .catch(e => this.deps.log(`threads: no spare ${purpose} session (${e.message})`))
        .finally(() => this.starting.delete(next));
      this.starting.add(next);
    }
    try {
      const r = /** @type {any} */ (await answer);
      return { ...r, warm, ms: Date.now() - t0, thread: id };
    } finally {
      st.done = true; st.stopping = true;
      setImmediate(() => st.proc.stop());
    }
  }

  /** A lean session for a purpose, started and left waiting for its question. */
  async spare(purpose, system, model) {
    const cwd = path.join(this.deps.root || os.tmpdir(), "quick", purpose.replace(/[^a-z0-9-]/gi, "_"));
    fs.mkdirSync(cwd, { recursive: true });
    return this.launch({ cwd, lean: true, quick: true, purpose, name: `Vyre ${purpose}`, ...(system ? { append: String(system) } : {}), ...(model ? { model } : {}) });
  }

  /** A running thread's background tasks (shell commands and subagents), newest last. */
  tasks(id) {
    this.must(id);
    const st = this.live.get(id);
    return { thread: id, tasks: st && st.tasks ? [...st.tasks.values()] : [] };
  }

  /** Stop one background task. */
  async killTask(id, task) {
    const st = this.live.get(id);
    if (!st || !st.proc.control) return { thread: id, killed: false, note: "not running" };
    await st.proc.control("stop_task", { task_id: String(task) });
    return { thread: id, task: String(task), killed: true };
  }

  /** Thinking on (the model decides how much) or off. */
  async thinking(id, on) {
    const st = this.live.get(id);
    if (!st || !st.proc.control) return { thread: id, thinking: null, note: "not running" };
    await st.proc.control("set_max_thinking_tokens", { max_thinking_tokens: on ? null : 0 });
    st.thinking = Boolean(on);
    const rec = this.record(id);
    this.emit("thinking.switched", { on: Boolean(on) }, id, rec ? rec.project : null);
    return { thread: id, thinking: Boolean(on) };
  }

  /**
   * Claude Code's `!` mode: run a shell line in the thread's folder, as the person, under the
   * floor, and give Claude its output with the next message (not a turn of its own).
   * @param {string} id @param {string} command
   */
  async shell(id, command) {
    const rec = this.must(id);
    let v = null;
    try { v = floorRules({ tool: "Bash", input: { command }, cwd: rec.cwd, home: this.deps.root || undefined }); } catch {}
    if (v && v.decision === "deny") throw Object.assign(new Error(`Vyre's security floor refused this: ${v.reason || "not allowed"}`), { code: "denied" });
    const { execFile } = await import("node:child_process");
    const r = await new Promise(resolve => execFile("/bin/sh", ["-c", String(command)], { cwd: rec.cwd, timeout: 120_000, maxBuffer: 4 << 20, env: { ...process.env, VYRE_THREAD: id } },
      (e, stdout, stderr) => resolve({ code: e ? (typeof /** @type {any} */ (e).code === "number" ? /** @type {any} */ (e).code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") })));
    const out = clip((r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : "")), 30000);
    const st = this.live.get(id);
    const block = `<bash-input>${command}</bash-input>\n<bash-stdout>${clip(r.stdout, 30000)}</bash-stdout><bash-stderr>${clip(r.stderr, 10000)}</bash-stderr>`;
    this.shellContext.set(id, [...(this.shellContext.get(id) || []), block].slice(-5));
    this.emit("thread.shell", { command: cut(command, 2000), code: r.code, output: cut(out, 4000) }, id, rec.project);
    return { thread: id, code: r.code, output: out, ...(st ? {} : { note: "Claude sees it with your next message" }) };
  }

  /**
   * Claude Code's `#` mode: a line added to CLAUDE.md, the project's (project), the user's own
   * (user) or this folder's private one (local, CLAUDE.local.md). Vyre's memory is separate.
   */
  remember(id, text, scope = "project") {
    const rec = this.must(id);
    const file = scope === "user" ? path.join(claudeHome(this.deps.root), "CLAUDE.md")
      : path.join(rec.cwd, scope === "local" ? "CLAUDE.local.md" : "CLAUDE.md");
    const line = String(text).replace(/\s+/g, " ").trim();
    if (!line) throw Object.assign(new Error("nothing to remember"), { code: "bad_input" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const had = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.appendFileSync(file, `${had && !had.endsWith("\n") ? "\n" : ""}- ${line}\n`);
    this.emit("thread.remembered", { scope, file }, id, rec.project);
    return { thread: id, scope, file };
  }

  /** The slash commands a running thread offers (names, and descriptions where the driver has them). */
  async commands(id) {
    this.must(id);
    const st = this.live.get(id);
    if (!st) return { thread: id, commands: [], note: "not running; the list comes with the session" };
    if (st.proc.control && this.sdk) {
      try {
        const r = await st.proc.control("supported_commands");
        if (r && Array.isArray(r.commands)) return { thread: id, commands: r.commands.map(c => ({ name: String(c.name), description: c.description || "", argumentHint: c.argumentHint || "" })) };
      } catch {}
    }
    return { thread: id, commands: (st.commands || []).map(name => ({ name, description: "", argumentHint: "" })) };
  }

  /** Stop the turn a thread is running; the thread stays and takes the next message. */
  async interrupt(id) {
    const st = this.live.get(id);
    if (!st) return { thread: id, interrupted: false, note: "not running" };
    if (st.turn) st.interrupting = true;
    if (st.proc.interrupt) await st.proc.interrupt();
    else st.proc.write({ type: "control_request", request_id: `vyre-int-${Date.now()}`, request: { subtype: "interrupt" } });
    return { thread: id, interrupted: true };
  }

  async stop(id) {
    const st = this.live.get(id);
    if (!st) return { thread: id, stopped: false, note: "not running" };
    st.stopping = true;
    await st.proc.stop();
    return { thread: id, stopped: true };
  }

  list({ agent, all } = {}) {
    const rows = agent
      ? this.db.prepare("SELECT id FROM threads_runs WHERE agent = ? ORDER BY last_at DESC LIMIT 200").all(agent)
      : this.db.prepare(`SELECT id FROM threads_runs ${all ? "" : `WHERE status IN (${LIVE.map(() => "?").join(",")}) OR last_at > ?`} ORDER BY last_at DESC LIMIT 200`)
        .all(...(all ? [] : [...LIVE, Date.now() - 86_400_000]));
    const live = this.sessions.live(this.ours());
    // Warm sessions (quick) are Vyre's own plumbing: listed only with all.
    const quick = all ? new Set() : new Set(/** @type {any[]} */ (this.db.prepare("SELECT id, opts FROM threads_runs WHERE opts LIKE '%\"quick\":true%'").all()).map(r => String(r.id)));
    return rows.filter(r => !quick.has(String(r.id))).map(r => ({ ...this.record(String(r.id)), live: live.has(String(r.id)) }));
  }

  /** A thread with its recent events, its open asks and who holds it. What a surface opening it needs. */
  get(id, { since = 0, limit = 200 } = {}) {
    const rec = this.must(id);
    const events = this.db.prepare("SELECT * FROM events WHERE thread = ? AND id > ? ORDER BY id DESC LIMIT ?").all(id, since, Math.min(1000, limit))
      .reverse().map(e => ({ id: e.id, at: e.at, type: e.type, payload: JSON.parse(String(e.payload)) }));
    return { thread: rec, asks: this.asks.open(id).map(({ request_id, ...a }) => a), events };
  }

  /**
   * Conversations with agents, as exchanges: what a person or surface sent, and the replies that
   * came back before the next send. Newest last. Built from the stored events (thread.sent and
   * thread.text with done; partial text and notices are left out), so it outlives each process.
   * @param {{ agent?: string, limit?: number, before?: number }} o before: an exchange id (its send's event id)
   */
  history({ agent, limit = 20, before } = {}) {
    const runs = /** @type {any[]} */ (agent
      ? this.db.prepare("SELECT id, agent, project FROM threads_runs WHERE agent = ?").all(agent)
      : this.db.prepare("SELECT id, agent, project FROM threads_runs WHERE agent IS NOT NULL").all());
    if (!runs.length) return [];
    const byId = new Map(runs.map(r => [String(r.id), r]));
    const want = Math.max(1, Math.min(200, Number(limit) || 20));
    const rows = /** @type {any[]} */ (this.db.prepare(`SELECT id, at, type, thread, payload FROM events
      WHERE thread IN (${runs.map(() => "?").join(",")}) AND id < ?
        AND (type = 'thread.sent' OR (type = 'thread.text' AND json_extract(payload, '$.done') = 1 AND json_extract(payload, '$.notice') IS NULL AND json_extract(payload, '$.kind') IS NULL))
      ORDER BY id DESC`).iterate(...runs.map(r => r.id), Number(before) || Number.MAX_SAFE_INTEGER));
    /** @type {Map<string, string[]>} replies seen (newest first) per thread, waiting for their send */
    const replies = new Map();
    const out = [];
    for (const e of rows) {
      const p = JSON.parse(String(e.payload));
      const th = String(e.thread);
      if (e.type === "thread.text") { if (typeof p.text === "string") replies.set(th, [...(replies.get(th) || []), p.text]); continue; }
      const r = byId.get(th);
      const said = (replies.get(th) || []).reverse();
      replies.delete(th);
      out.push({ id: e.id, at: e.at, agent: r.agent, thread: th, project: r.project || null, surface: p.surface || null,
        text: String(p.text || ""), answer: said.length ? said.join("\n\n") : null });
      if (out.length >= want) break;
    }
    return out.reverse();
  }

  /**
   * Wait for a thread to finish a turn, ask a question, or stop, and hear about it once as
   * `thread.watched`. A stopped thread always ends a watch. Watches are rows, so they outlive a
   * vyred restart; a thread already stopped fires at once.
   * @param {{ thread: string, until?: string, notify?: string, note?: string }} o @param {string} by
   */
  watch(o, by) {
    const rec = this.must(o.thread);
    const until = o.until || "either";
    const id = "w" + crypto.randomBytes(6).toString("hex");
    this.db.prepare("INSERT INTO threads_watches (id, thread, until, notify, note, by, at) VALUES (?,?,?,?,?,?,?)")
      .run(id, rec.id, until, o.notify || null, o.note || null, by || null, Date.now());
    if (!this.live.has(rec.id)) { this.fire("thread.stopped", rec.id, {}, rec.project); return { watch: id, fired: true }; }
    return { watch: id, fired: false };
  }

  unwatch(id) {
    return { removed: Number(this.db.prepare("DELETE FROM threads_watches WHERE id = ?").run(String(id)).changes) > 0 };
  }

  /** An event a watch may be waiting for: emit thread.watched for each such watch, once. */
  fire(type, thread, payload, project) {
    const reason = WATCHED[type];
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM threads_watches WHERE thread = ?").all(thread))
      .filter(w => reason === "stopped" || w.until === "either" || (w.until === "finished" && reason === "finished") || (w.until === "asks" && reason === "asked"));
    if (!rows.length) return;
    let summary = null;
    if (reason === "asked") summary = payload.summary || payload.tool || null;
    else {
      const last = /** @type {any} */ (this.db.prepare(`SELECT payload FROM events WHERE thread = ? AND type = 'thread.text'
        AND json_extract(payload, '$.done') = 1 AND json_extract(payload, '$.kind') IS NULL ORDER BY id DESC LIMIT 1`).get(thread));
      summary = last ? cut(String(JSON.parse(String(last.payload)).text || ""), 280) : null;
    }
    for (const w of rows) {
      if (Number(this.db.prepare("DELETE FROM threads_watches WHERE id = ?").run(w.id).changes) === 0) continue;
      this.emitRaw("thread.watched", { watch: w.id, reason, notify: w.notify, note: w.note, by: w.by, ...(summary ? { summary } : {}) }, thread, project);
    }
  }

  /** The kind of agent a caller is, from the threads it runs. Unknown is not the assistant. */
  kindOf(agent) {
    const r = /** @type {any} */ (this.db.prepare("SELECT agent_kind FROM threads_runs WHERE agent = ? ORDER BY last_at DESC LIMIT 1").get(agent));
    return r ? r.agent_kind : null;
  }

  /**
   * Which live thread of this agent holds this key, or null. The key dies with the process, so a
   * stopped or replaced thread vouches for nothing.
   * @param {string} agent @param {string} key
   */
  vouch(agent, key) {
    const k = Buffer.from(String(key));
    for (const [id, st] of this.live) {
      if (!st.key || st.launch.agent !== agent) continue;
      const mine = Buffer.from(st.key);
      if (mine.length === k.length && crypto.timingSafeEqual(mine, k)) return id;
    }
    return null;
  }

  /** vyred is stopping: every live thread ends with reason "restart" (ADR 0029 R7), so a surface says why. */
  async stopAll() {
    // No new spare starts, and one being started is waited for, so it is stopped with the rest.
    this.closing = true;
    await Promise.all([...this.starting]);
    for (const st of this.live.values()) if (!st.haltReason) st.haltReason = "restart";
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
    for (const id of [...this.socks.keys()]) this.closeSocket(id);
    for (const job of [...this.prunes]) job.run();                     // no surface is left to catch up
  }
}

const str = { type: "string" };

/** Pasted images a message may carry (Claude Code's own limits are close to these). */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGES = { count: 5, mb: 5 };
/** Checked images, or null. @param {any} list */
function imagesOf(list) {
  if (!Array.isArray(list) || !list.length) return null;
  if (list.length > IMAGES.count) throw Object.assign(new Error(`at most ${IMAGES.count} images in a message`), { code: "bad_input" });
  return list.map(i => {
    const data = String(i && i.data || "");
    if (!IMAGE_TYPES.includes(String(i && i.media_type))) throw Object.assign(new Error(`an image is ${IMAGE_TYPES.join(", ")}`), { code: "bad_input" });
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data) || data.length * 0.75 > IMAGES.mb * 1024 * 1024) throw Object.assign(new Error(`an image is base64, at most ${IMAGES.mb} MB`), { code: "bad_input" });
    return { media_type: String(i.media_type), data: data.replace(/\s+/g, "") };
  });
}

/**
 * The person at the box, through the link: the Mac runs a WRITE only with `as: "person"`, as
 * "link:box" (core/link/mac.js). A caller kind of its own, named here rather than left to fall
 * through the model-caller patterns: it queues, is no agent, and types only as a box surface.
 * @param {string} [caller]
 */
export const fromLink = caller => /^link:/.test(String(caller || ""));

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
/**
 * Whose words are queued for a session busy in a terminal: a person's. That is every surface of
 * the person's, the owner's Deck or phone over the tailnet ("tailnet:<login>", the only login the
 * tailnet listener admits, ADR 0002) among them. A model's words are refused instead: an MCP call,
 * the Harness, or anything speaking as an agent, an agent's own tailnet node included.
 * @param {string} [caller]
 */
/**
 * The provider's daily cap (core/spend): an agent, a module or an automation does not start or feed a
 * thread on a provider that is at its cap; the answer is the cap line, which says how to raise it. The
 * person's own surfaces are never held, so nothing ever prompts. No spend module, or no answer from it,
 * means no cap.
 * @param {{ call: (tool: string, input: any) => Promise<any> }} ctx @param {unknown} caller @param {unknown} [provider]
 */
export async function spendCheck(ctx, caller, provider) {
  const c = String(caller || "");
  if (!(/^(module|mcp|harness|hook)/.test(c) || /(^|[\s:])agent:/.test(c))) return;
  let r = null;
  try { r = await ctx.call("spend.check", { provider: String(provider || "claude") }); } catch { return; }
  const d = r && (r.data || r);
  if (d && d.capped === true) throw Object.assign(new Error(String(d.line || "the daily spend cap for this provider is reached")), { code: "spend_capped" });
}

export const queuesFor = caller => {
  const c = String(caller || "");
  if (fromLink(c)) return true;
  return !/^(mcp|harness|hook)/.test(c) && !/(^|[\s:])agent:/.test(c) && c !== "tailnet:";
};

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const root = ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "";
    const cfg = sessionsConfig(ctx.config);
    // Where spawnSession (core/sessions/spawn.js) reads it, for both drivers.
    process.env.VYRE_SESSIONS_SPAWNER = cfg.spawner;
    /** This machine's own Claude credential for threads no agent runs (ADR 0030, "Auth"). */
    // The vault is asked only when a credential was put there for this (onboarding's Claude step,
    // or sessions.auth set on purpose), so a machine without one never touches the vault.
    const chosen = Boolean(ctx.config && ((ctx.config.sessions && ctx.config.sessions.auth) || (ctx.config.onboard && ctx.config.onboard.claude)));
    const auth = async () => {
      if (cfg.auth === "login" || !ctx.vault || !chosen) return null;
      const fetch = async kind => { const v = await ctx.vault.fetch(CREDENTIALS[kind]); if (!v) throw new Error(`the vault has no ${CREDENTIALS[kind]}`); return String(v); };
      if (cfg.auth === "api-key") return { auth: "api-key", env: { ANTHROPIC_API_KEY: await fetch("api-key") } };
      const out = { auth: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: await fetch("setup-token") } };
      try { return { ...out, fallback: { env: { ANTHROPIC_API_KEY: await fetch("api-key") } } }; } catch { return out; }
    };
    const sb = new Switchboard({
      db: ctx.store.db, call: ctx.call, root,
      transcripts: transcriptFolders((ctx.config && ctx.config.transcripts) || [], root),
      emit: (type, payload, where) => ctx.events.emit(type, payload, where), log: ctx.log,
      prune: (thread, before) => ctx.events.prune("thread.text", { thread, before, has: "delta" }),
      idleMs: cfg.idle_minutes * 60_000, maxLive: cfg.max_live, auth, providers: ctx.providers,
      // Each session's own socket (option A): always with "on", with the spawner under "auto".
      // Through the spawner it goes in the box's shared folder; else a private one of this user's.
      threadSocket: cfg.thread_socket === "off" ? null
        : async (/** @type {any} */ o) => cfg.thread_socket === "on" || usesSpawner()
          ? openThreadSocket({ handler: ctx.handler, log: ctx.log, ...o,
            dir: usesSpawner() ? THREAD_SOCKETS : path.join(privateSocketDir(), `t-${crypto.createHash("sha256").update(String(root)).digest("hex").slice(0, 12)}`) })
          : null,
      subreaper: cfg.subreaper === false ? null : typeof cfg.subreaper === "string" ? cfg.subreaper : findSubreaper(),
      ...(typeof cfg.uid === "number" ? { uid: cfg.uid, gid: typeof cfg.gid === "number" ? cfg.gid : cfg.uid } : {}),
    });
    sb.recover();
    // ADR 0041 section 5, end side (start side is where()'s github.session.worktree call above):
    // a github project's worktree is cleaned up once its session reaches "finished" - a one-shot's
    // own natural completion (threads.launch's own purpose: "job", once: true; never resumed by
    // design), the one canonical status that never needs the worktree again. Deliberately narrower
    // than the ADR's "stopped or finished": an ordinary interactive session that stops (the person
    // presses Stop, or an idle close/restart/rewind lands on "paused") is resumable - threads.send
    // brings it back on its EXISTING cwd (launch()'s resume branch never calls where() at all) -
    // so cleaning its worktree up there would break resume outright unless resume also learned to
    // recreate a missing one, which is real, separate work, not done here. Flagged to github/
    // reviewer-2 rather than guessed at silently.
    const offGithubCleanup = ctx.events.on("thread.status", e => {
      if (e.payload && e.payload.status === "finished" && e.project && e.thread) {
        ctx.call("github.project.of", { project: e.project }).then(gh => {
          if (!gh || gh.error || !gh.data) return;
          return ctx.call("github.session.cleanup", { project: e.project, session: e.thread });
        }).catch(() => {}); // no core/github, or nothing to clean up: changes nothing
      }
    });
    // The Agent SDK driver (ADR 0030). It is loaded with the first thread, not at start (the
    // import alone is about 40 MB), and installed in the background on first use while threads
    // run on the CLI runner.
    if (cfg.driver === "sdk") {
      const dir = sdkDir(root, cfg);
      const bundled = cfg.claude === "bundled";
      let failed = false;
      sb.loadSdk = async () => {
        if (failed || !sdkInstalled(dir, { bundled })) return null;
        const module = await loadSdk(dir);
        if (!module) { failed = true; ctx.log(`threads: the Claude Agent SDK in ${dir} did not load; threads run on the CLI`); return null; }
        return { module, bin: claudeBin(dir, cfg) };
      };
      // Never from a test run or a temp or dev home (autoInstallAllowed): a test brings its own SDK
      // or none, and an npm left running after vyred stops keeps writing into that home.
      if (!sdkInstalled(dir, { bundled }) && cfg.install && autoInstallAllowed(root)) {
        ctx.log(`threads: installing the Claude Agent SDK into ${dir}; threads run on the CLI until it is ready`);
        installSdk(dir, { bundled }).then(r => { if (r.why) ctx.log(`threads: ${r.why}`); }).catch(() => {});
      }
    }

    /**
     * Guard every tool. Inside an agent's own thread (caller mcp:agent:<name>) only the assistant
     * may drive sessions; other agents stay inside their own work.
     */
    const guard = (caller, what) => {
      if (fromLink(caller)) return;
      const agent = agentOf(caller);
      if (agent && sb.kindOf(agent) !== "assistant") throw new Error(`only the assistant can ${what}; ${agent} is an agent`);
    };
    const surfaceOf = (input, caller) => {
      const s = String(input.surface || caller || "vyre");
      // The link's words are always the box's surface, whatever the input says.
      return fromLink(caller) && !s.startsWith("box:") ? `box:${s}` : s;
    };
    const tool = (name, description, input, run, callers, extra = {}) => ctx.tool(name, { description, input, run, callers, ...extra });

    const spendGate = (caller, provider) => spendCheck(ctx, caller, provider);

    tool("threads.start", "Start a headless Claude Code session in a folder or a project's home, owned by vyred so it outlives every surface. The calling surface gets the keyboard. Returns the thread; its id is the Claude Code session id.",
      { type: "object", properties: { project: str, cwd: str, prompt: str, name: str, model: str, surface: str, append: str,
        purpose: { type: "string", enum: ["chat", "agent", "project", "teammate", "capsule", "job", "memory", "planner", "learn", "helper"], description: "What kind of session: picks its model (sessions.models.get). Default: chat, or project in a project." },
        provider: { type: "string", description: "The session provider: claude (the default), or one a module added." },
        effort: { type: "string", enum: EFFORTS, description: "Reasoning effort, as /effort: low, medium, high, xhigh or max. Default: the model's own." },
        lean: { type: "boolean", description: "A one-question thread: no Vyre plugin, no tools, no MCP servers, none of the user's settings. Cheap to start." } } },
      async (i, { caller }) => { guard(caller, "start sessions"); await spendGate(caller, i.provider); return sb.launch({ ...i, surface: surfaceOf(i, caller) }); });

    /**
     * On the box, the person's words for a thread the box does not have go to the paired Mac that
     * has it (docs/adr/0021-box-reads-the-mac.md, "Sending to a Mac session"): the Mac's answer,
     * labelled { source: "mac", machine }, or null when no Mac has it, so the box answers as usual.
     */
    const sendToMac = async (i, caller) => {
      const r = await ctx.call("link.macs.call", { tool: "threads.send", as: "person", ...(i.machine ? { mac: i.machine } : {}),
        input: { thread: i.thread, text: i.text, surface: surfaceOf(i, caller) } });
      if (r.error || !Array.isArray(r.data)) return null;
      const done = r.data.find(a => a.ok);
      if (done) {
        const d = done.data || {};
        // The note names the Mac, so the person knows where the session is busy.
        const note = d.queued ? (d.busy && d.busy !== "terminal"
          ? `${d.name} is in use in ${d.busy} on ${done.name}. I'll hand it your message when this turn ends.`
          : `${d.name} is busy in your terminal on ${done.name}. I'll hand it your message when this turn ends.`) : d.note;
        return { ...d, ...(note !== undefined ? { note } : {}), source: "mac", machine: done.name };
      }
      // A Mac that answered with its own error has the thread (or failed on it): say that one. A
      // Mac without the thread says "no thread"; an offline Mac may have it, so nothing was sent.
      const failed = r.data.find(a => a.error && !["mac_offline", "timeout"].includes(a.error.code) && !/^no thread\b/.test(a.error.message));
      if (failed) throw Object.assign(new Error(failed.error.message), { code: failed.error.code });
      const away = r.data.find(a => a.error && a.error.code === "mac_offline");
      if (away) throw Object.assign(new Error(`${away.name} is offline; your message was not sent`), { code: "mac_offline" });
      const slow = r.data.find(a => a.error && a.error.code === "timeout");
      if (slow) throw Object.assign(new Error(`${slow.name} did not answer in time; your message may not have been sent`), { code: "timeout" });
      return null;
    };

    /**
     * On the box, the person's answer to an ask the box does not have goes to the paired Mac it is
     * on (docs/adr/0021-box-reads-the-mac.md, "v2"): the link signs it for that Mac, and the Mac
     * checks the signature before it answers. The Mac's answer, labelled { source: "mac", machine },
     * or null when no Mac has the ask, so the box answers as usual ("no ask"). Never retried: a Mac
     * that says the ask is gone or cancelled has the last word, and a retry would carry a new nonce.
     */
    // The paired Macs' open asks, as their ask.raised reached this box (core/link relays them with
    // source "mac"): ask id -> gated. Read synchronously by threads.answer's presence rule. Box only.
    /** @type {Map<string, { gated: boolean }>} */
    const macAsks = new Map();
    /** Record a Mac's ask as gated or not, keeping at most 500. @param {string} ask @param {boolean} gated */
    const rememberMacAsk = (ask, gated) => {
      macAsks.delete(ask);
      while (macAsks.size >= 500) macAsks.delete(/** @type {string} */ (macAsks.keys().next().value));
      macAsks.set(ask, { gated });
    };
    const offs = [];
    if (ctx.config && ctx.config.role === "box") {
      offs.push(ctx.events.on("ask.raised", e => {
        const p = e.payload || {};
        if (p.source !== "mac" || typeof p.ask !== "string") return;
        rememberMacAsk(p.ask, gatedAsk(p));
      }));
      offs.push(ctx.events.on("ask.answered", e => { const p = e.payload || {}; if (p.source === "mac") macAsks.delete(p.ask); }));
    }
    // Whether any Mac has ever paired here (core/link/box.js's own table, read across modules:
    // "reads may join any table", core/modules/index.js). A box that has never paired one can
    // never have a Mac-gated ask to fail closed on; querying it here, not link's own tool, keeps
    // this synchronous, the way a presence `when` must be. Missing (link never started) reads as
    // no Macs, not an error.
    const hasPairedMacs = () => { try { return Boolean(ctx.store.db.prepare("SELECT 1 FROM link_peers WHERE kind = 'mac' LIMIT 1").get()); } catch { return false; } };
    /**
     * Would this answer go to a Mac, and approve a gated ask there? An ask the box never saw (the
     * box restarted, or it raced ask.raised) counts as gated too, not only one named by `machine`,
     * on a box that has ever paired a Mac: macAsks is memory-only, so "unknown, and a Mac could
     * have it" must fail toward asking for a fresh proof, not toward skipping it (e2e, review of
     * 0f2a8752, LOW 1). A box with no paired Mac, ever, has nothing to fail closed on (regression,
     * cohesion 2026-09-28: a plain single-box install asked for presence on every unknown ask,
     * `threads.answer` typo'd or already-closed alike, though ADR 0021 section 3a only fails
     * closed for one a Mac could actually own); the person sees a proof prompt they didn't
     * strictly need only when a Mac is actually in the picture.
     */
    const gatedOnMac = i => !sb.asks.get(i.ask) && (macAsks.has(i.ask) ? /** @type {any} */ (macAsks.get(i.ask)).gated : Boolean(i.machine) || hasPairedMacs());
    /** The owner's device over the tailnet or the relay: the person needs a person session there (ADR 0032). */
    const ownerDevice = caller => /^tailnet:(?!agent:)./.test(String(caller)) || /^device:[a-z2-7]{16}$/i.test(String(caller));

    const answerOnMac = async (i, caller, peer, meta = {}) => {
      // Defence in depth until the registry's person-session rule (ADR 0032) is on this branch: an
      // owner device answers a Mac's ask only inside a person session. Nothing is signed or sent.
      if (ownerDevice(caller) && !meta.person) throw Object.assign(new Error("answering a Mac's ask is the person's own action: sign in on this device with your passkey first"), { code: "person_session_required" });
      // An ask that approves a floor tool needs a fresh proof (the registry checked it; a presence session is not one).
      if (gatedOnMac(i) && (!meta.presence || meta.presence.method === "session")) throw Object.assign(new Error("this ask approves a protected action: prove you are here (passkey or Touch ID) to answer it"), { code: "presence_required" });
      const input = { ask: i.ask, decision: i.decision, surface: surfaceOf(i, caller),
        ...(i.message !== undefined ? { message: i.message } : {}), ...(i.answers !== undefined ? { answers: i.answers } : {}), ...(i.scope !== undefined ? { scope: i.scope } : {}) };
      const by = { caller: String(caller || ""), ...(peer && peer.stableId ? { device: String(peer.stableId) } : {}),
        ...(meta.person && meta.person.id ? { person: String(meta.person.id) } : {}), ...(meta.presence && meta.presence.method ? { presence: String(meta.presence.method) } : {}) };
      const r = await ctx.call("link.macs.call", { tool: "threads.answer", as: "person", by, input, ...(i.machine ? { mac: i.machine } : {}) });
      if (r.error || !Array.isArray(r.data) || !r.data.length) return null;
      const done = r.data.find(a => a.ok);
      if (done) return { ...(done.data || {}), source: "mac", machine: done.name };
      const a = r.data[0];
      const e = a.error || { code: "failed", message: "the Mac could not answer" };
      if (e.code === "mac_offline") throw Object.assign(new Error(`${a.name} is offline; your answer was not sent`), { code: "mac_offline" });
      if (e.code === "timeout") throw Object.assign(new Error(`${a.name} did not answer in time; your answer may not have reached it`), { code: "timeout" });
      throw Object.assign(new Error(e.message), { code: e.code });
    };

    tool("threads.send", "Type into a thread. Only the surface holding its lease may type; a free thread is taken on the first keystroke. A stopped thread is resumed first. On a box, the person's words for a paired Mac's thread go to that Mac (machine: its name, to pick one).",
      { type: "object", required: ["thread", "text"], properties: { thread: str, text: str, surface: str, machine: str,
        mode: { type: "string", enum: ["steer", "queue"], description: "While a turn runs: steer (the default) joins it at Claude's next step, as in Claude Code; queue waits for the turn to end, and can be taken back or edited until then." },
        images: { type: "array", items: { type: "object", required: ["media_type", "data"], properties: { media_type: { type: "string", enum: IMAGE_TYPES }, data: str } },
          description: `Pasted images, base64: at most ${IMAGES.count}, ${IMAGES.mb} MB each.` },
        model: { type: "string", description: "Switch the thread to this model first (as threads.model): the Capsule's Cmd-Return, deeper. A person's surface only." },
        effort: { type: "string", enum: EFFORTS, description: "Set this effort first (as threads.effort). A person's surface only." } } },
      // Only a person's words are queued for a session open in a terminal: a model's are refused.
      async (i, { caller, idempotencyKey }) => {
        guard(caller, "type into sessions");
        { const rec = sb.record(i.thread); await spendGate(caller, rec && rec.provider); }
        // Only the person's own callers reach a Mac; agents, MCP, guests and modules get the box's answer.
        if (wantsMacs(ctx, {}, caller) && !sb.knows(i.thread)) {
          const mac = await sendToMac(i, caller);
          if (mac) return mac;
        }
        if ((i.model || i.effort) && !queuesFor(caller)) throw Object.assign(new Error("only a person's surface switches a session's model or effort"), { code: "denied" });
        const had = (i.model || i.effort) ? sb.record(i.thread) : null;
        if (i.model && had && had.model !== i.model) await sb.switchModel(i.thread, i.model);
        if (i.effort && had && had.effort !== i.effort) await sb.switchEffort(i.thread, i.effort);
        return sb.send(i.thread, i.text, surfaceOf(i, caller), { queue: queuesFor(caller), wait: fromLink(caller), mode: i.mode === "queue" ? "queue" : "steer", images: imagesOf(i.images),
          ...(idempotencyKey ? { uuid: keyUuid(String(caller || ""), String(idempotencyKey)) } : {}) });
      });

    tool("threads.list", "Headless threads: running ones and those active in the last day (all: every one), newest first, with who holds each, how many questions are open, and live (a terminal has it open now).",
      { type: "object", properties: { agent: str, all: { type: "boolean" }, machines: { type: "string", enum: ["all", "local"] } } },
      async (i, { caller }) => {
        guard(caller, "list sessions");
        const { machines: _, ...q } = i;
        if (!wantsMacs(ctx, i, caller)) return sb.list(q);
        // On the box, for the person: the Macs' threads too, newest first, each labelled with its machine.
        const answers = await askMacs(ctx, "threads.list", q);
        return mergeRows(ctx, sb.list(q), answers, { compare: (a, b) => (b.last || 0) - (a.last || 0) });
      });

    // Every ask says what answering it takes: `presence: {required, covered, since}`. Answering is the
    // person's own business (the no-nag rule), so required is false; covered says whether this
    // device has a live presence session. Surfaces render from this, never from tool names.
    const withPresence = async (asks, peer) => {
      if (!asks.length) return asks;
      const r = await ctx.call("presence.covered", peer ? { peer } : {});
      const d = r.data || {};
      const c = { covered: Boolean(d.covered), since: d.since ?? null };
      return asks.map(a => ({ ...a, presence: { required: false, ...c } }));
    };

    tool("threads.get", "One thread: its record, its open permission questions, and its recent events (since: an event id).",
      { type: "object", required: ["thread"], properties: { thread: str, since: { type: "integer" }, limit: { type: "integer" } } },
      async (i, { caller, peer }) => {
        guard(caller, "read sessions");
        const t = sb.get(i.thread, i);
        return t && Array.isArray(t.asks) ? { ...t, asks: await withPresence(t.asks, peer) } : t;
      });

    tool("threads.lease", "Take the keyboard of a thread for a surface. Always succeeds, and says who had it; the other surfaces go read-only.",
      { type: "object", required: ["thread"], properties: { thread: str, surface: str } },
      async (i, { caller }) => { guard(caller, "take a session's keyboard"); return sb.lease(i.thread, surfaceOf(i, caller)); });

    tool("threads.release", "Give the keyboard back. Releasing a lease you do not hold changes nothing.",
      { type: "object", required: ["thread"], properties: { thread: str, surface: str } },
      async (i, { caller }) => { guard(caller, "release a session"); return sb.release(i.thread, surfaceOf(i, caller)); });

    tool("threads.asks", "Questions and permission asks waiting on the user, oldest first (kind: only questions or only permissions). Each has its kind, what a card shows (questions, or detail), who asks (agent, thread_name), where it sits in the session (anchor: tool_use_id and its ask.raised event id), what always allow is on offer (always, always_project), and what answering takes (presence: required, covered). A surface that reconnects reads these; events alone cannot say what is open now. On a box, for the person, the paired Macs' open asks too, labelled source and machine (machines: \"local\" for the box's own only).",
      { type: "object", properties: { thread: str, kind: { type: "string", enum: ["question", "permission"] }, machines: { type: "string", enum: ["all", "local"] } } },
      async (i, { caller, peer }) => {
        guard(caller, "read questions");
        const { machines: _, ...q } = i;
        const own = await withPresence(sb.asks.open(q.thread, q.kind).map(({ request_id, ...a }) => a), peer);
        if (!wantsMacs(ctx, i, caller)) return own;
        // On a box, for the person: the paired Macs' open asks too, each labelled with its machine,
        // so a surface that reconnects has one list to reconcile from. What answering one takes is
        // the box's rule, not the Mac's: a gated ask needs a fresh proof here (gatedOnMac), and the
        // box learns which are gated from this list as it does from the relayed ask.raised.
        const answers = await askMacs(ctx, "threads.asks", q);
        const covered = own.length ? own[0].presence : await withPresence([{}], peer).then(r => r[0].presence);
        for (const a of answers) if (a.ok && Array.isArray(a.data)) for (const r of a.data) if (r && typeof r.id === "string") rememberMacAsk(r.id, gatedAsk(r));
        return mergeRows(ctx, own, answers.map(a => a.ok && Array.isArray(a.data)
          ? { ...a, data: a.data.map(r => ({ ...r, presence: { ...covered, required: gatedAsk(r) } })) } : a),
        { compare: (x, y) => (Number(x.at) || 0) - (Number(y.at) || 0) });
      });

    tool("threads.answer", "Answer an ask: allow, deny, or always (allow, and stop asking where Claude Code offers it). A question is answered with allow and answers { [question]: chosen label(s) joined with \", \", or the typed text }, or declined with deny. Only a person's surface can answer; a model never approves a permission, its own or another session's. On a box, the person's answer to a paired Mac's ask goes to that Mac (machine: its name, when the box has not seen the ask).",
      { type: "object", required: ["ask", "decision"], properties: { ask: str, decision: { type: "string", enum: ["allow", "deny", "always"] }, message: str, surface: str, machine: str,
        answers: { type: "object", additionalProperties: { type: "string" } },
        scope: { type: "string", enum: ["project"], description: "With always: allow this tool from now on in the thread's project only (the ask's always_project)." } } },
      async (i, meta) => {
        const { caller, thread, peer } = meta;
        // A call vyred traced to a session never answers that session's own ask, whoever it says it is.
        const a = sb.asks.get(i.ask);
        if (a && thread && a.thread === thread) throw Object.assign(new Error("an ask is answered by the person, not from the session that raised it"), { code: "denied" });
        // Only the person's own callers reach a Mac (a module never: it passes no `machines`).
        if (!a && !thread && wantsMacs(ctx, {}, caller)) {
          const mac = await answerOnMac(i, caller, peer, meta);
          if (mac) return mac;
        }
        // device: which of the person's devices answered, when the call says (a paired device over
        // the relay, the owner's tailnet node), not only the surface it claims.
        const device = /^(device|tailnet):./.test(String(caller || "")) ? String(caller) : null;
        return sb.answer(i.ask, i.decision, surfaceOf(i, caller), i.message, i.answers, i.scope, device);
      },
      // A person's surfaces only. The loader refuses (code "denied") and hides the tool from every
      // other caller; callers is an allowlist, so "mcp" and "mcp:agent:<name>" are both out. The
      // Deck and the Capsule claim their own names over HTTP, so they are listed by name.
      // No presence proof: answering is the owner's own action on their own screen, and Vyre does
      // not nag (ADR 0024, "No nagging"). The allowlist keeps models, agents and guests out, and the
      // harness floor refuses a model's Bash that names this tool (core/presence PERSON_ONLY).
      // "link:box" is the person at the paired box, on a Mac: core/link runs it only after checking
      // the box's signed assertion for this ask and this answer (docs/adr/0021, "v2").
      ["cli", "local", "module", "deck", "capsule", "tailnet", "link:box"],
      // On a box, an answer that goes to a Mac and approves a floor tool there needs a fresh proof
      // (gatedOnMac). Every other answer asks nothing (the no-nag rule). A Mac declares no rule.
      ctx.config && ctx.config.role === "box" ? { presence: { when: i => Boolean(i && i.ask) && gatedOnMac(i), summary: () => "Answer a protected request on your Mac" } } : {});

    tool("threads.watch", "Tell me once when a thread finishes a turn, asks a question, or stops: emits thread.watched {watch, thread, reason, notify, note, summary} and clears itself. until: finished, asks or either (default).",
      { type: "object", required: ["thread"], properties: { thread: str, until: { type: "string", enum: ["finished", "asks", "either"] }, notify: str, note: str } },
      async (i, { caller }) => { guard(caller, "watch sessions"); return sb.watch(i, String(caller || "")); });

    tool("threads.unwatch", "Stop waiting on a watch.",
      { type: "object", required: ["watch"], properties: { watch: str } },
      async (i, { caller }) => { guard(caller, "watch sessions"); return sb.unwatch(i.watch); });

    tool("threads.interrupt", "Stop the turn a thread is running, as Escape does in Claude Code. The thread stays and takes the next message; open questions of that turn are cancelled.",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "interrupt sessions"); return sb.interrupt(i.thread); });

    tool("threads.unqueue", "Take back queued words before they are handed over: one (queued: the queued_id threads.send gave, or thread.queued's queued) or all of the thread's. Only a person's surface can.",
      { type: "object", required: ["thread"], properties: { thread: str, queued: { type: "integer" }, surface: str } },
      async (i, { caller }) => {
        guard(caller, "take back queued words");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface can take back queued words"), { code: "denied" });
        return sb.unqueue(i.thread, i.queued, surfaceOf(i, caller));
      });

    tool("threads.queue", "The words queued for a thread and not handed over yet, oldest first: queued (the row id), uuid, text, surface, at, request (a teammate's own request id, when its reply carries one).",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => {
        guard(caller, "read queued words");
        sb.must(i.thread);
        return { queued: /** @type {any[]} */ (sb.db.prepare("SELECT id, uuid, text, surface, at, request FROM threads_inbox WHERE thread = ? AND delivered_at IS NULL ORDER BY id").all(i.thread))
          .map(r => ({ queued: Number(r.id), uuid: r.uuid || null, text: String(r.text), surface: r.surface, at: r.at, request: r.request || null })) };
      });

    tool("threads.edit", "Change queued words before they are handed over (re-emits thread.queued with the same ids). Only a person's surface can.",
      { type: "object", required: ["thread", "queued", "text"], properties: { thread: str, queued: { type: "integer" }, text: str, surface: str } },
      async (i, { caller }) => {
        guard(caller, "edit queued words");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface can edit queued words"), { code: "denied" });
        return sb.edit(i.thread, i.queued, i.text, surfaceOf(i, caller));
      });

    tool("threads.send-now", "Send queued words now: they join the running turn at Claude's next step instead of waiting for it to end. Not for a session busy in a terminal.",
      { type: "object", required: ["thread", "queued"], properties: { thread: str, queued: { type: "integer" }, surface: str } },
      async (i, { caller }) => {
        guard(caller, "send queued words");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface can send queued words"), { code: "denied" });
        return sb.sendNow(i.thread, i.queued);
      });

    tool("threads.rewind", "Go back to a message, as a double Esc does in Claude Code: the session continues from just before it, and its words come back (text) to edit and send again. uuid: the message's (thread.turn's uuid). restore: conversation (the default), code (put back the files its tools changed since, keep the conversation) or both.",
      { type: "object", required: ["thread", "uuid"], properties: { thread: str, uuid: str, restore: { type: "string", enum: ["conversation", "code", "both"] } } },
      async (i, { caller }) => {
        guard(caller, "rewind sessions");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface can rewind a session"), { code: "denied" });
        return sb.rewind(i.thread, i.uuid, i.restore || "conversation");
      });

    tool("threads.model", "Switch a thread's model, as /model does in Claude Code: an alias (opus, sonnet, haiku) or a model id. A running thread switches at once; a stopped one when it next runs.",
      { type: "object", required: ["thread", "model"], properties: { thread: str, model: str } },
      async (i, { caller }) => {
        guard(caller, "switch models");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface switches a session's model"), { code: "denied" });
        return sb.switchModel(i.thread, i.model);
      });

    tool("threads.effort", "Set a thread's reasoning effort, as /effort does in Claude Code: low, medium, high, xhigh or max (the model's own limits apply); none goes back to the model's default. A running thread changes at once; a stopped one when it next runs.",
      { type: "object", required: ["thread"], properties: { thread: str, effort: { type: "string", enum: EFFORTS } } },
      async (i, { caller }) => {
        guard(caller, "set effort");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface sets a session's effort"), { code: "denied" });
        return sb.switchEffort(i.thread, i.effort ?? null);
      });

    tool("threads.commands", "The slash commands a running thread offers (Claude Code's own, the user's and the project's, and plugins'), for a composer's / menu. Send one as a message, e.g. \"/compact\".",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "read sessions"); return sb.commands(i.thread); });

    tool("threads.tasks", "A running thread's background tasks (shell commands run in the background, subagents): id, kind, title, status (running, completed, failed, killed), summary.",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "read sessions"); return sb.tasks(i.thread); });

    tool("threads.kill-task", "Stop one of a thread's background tasks.",
      { type: "object", required: ["thread", "task"], properties: { thread: str, task: str } },
      async (i, { caller }) => {
        guard(caller, "stop tasks");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface stops a session's tasks"), { code: "denied" });
        return sb.killTask(i.thread, i.task);
      });

    tool("threads.thinking", "Thinking on (the model decides how much) or off, for a running thread.",
      { type: "object", required: ["thread", "on"], properties: { thread: str, on: { type: "boolean" } } },
      async (i, { caller }) => {
        guard(caller, "switch thinking");
        if (!queuesFor(caller)) throw Object.assign(new Error("only a person's surface switches thinking"), { code: "denied" });
        return sb.thinking(i.thread, i.on);
      });

    tool("threads.shell", "Claude Code's ! mode: run a shell line in the thread's folder, as you, under the security floor. Its output shows here and goes to Claude with your next message. Only a person can.",
      { type: "object", required: ["thread", "command"], properties: { thread: str, command: str } },
      async (i, { caller, thread }) => {
        if (thread && thread === i.thread) throw Object.assign(new Error("a session does not run the person's shell lines"), { code: "denied" });
        return sb.shell(i.thread, i.command);
      }, ["cli", "local", "deck", "capsule"]);

    tool("threads.remember", "Claude Code's # mode: add a line to CLAUDE.md: the project's (project, the default), your own (user) or this folder's private one (local, CLAUDE.local.md). Vyre's own memory is separate.",
      { type: "object", required: ["thread", "text"], properties: { thread: str, text: str, scope: { type: "string", enum: ["project", "user", "local"] } } },
      async (i, { caller, thread }) => {
        if (thread && thread === i.thread) throw Object.assign(new Error("a session does not edit its own instructions"), { code: "denied" });
        return sb.remember(i.thread, i.text, i.scope || "project");
      }, ["cli", "local", "deck", "capsule"]);

    tool("threads.fork", "Continue a session as a copy: a new thread with the same conversation so far, in the same folder, that the original never sees. For a session busy in a terminal, the way to carry on from here without two keyboards on one transcript. at: a message's uuid (thread.turn's) - fork from just before that turn instead of from the live end, the other item in the rewind menu ('Fork from here' beside 'Restore').",
      { type: "object", required: ["thread"], properties: { thread: str, at: str, prompt: str, name: str, surface: str } },
      async (i, { caller }) => {
        guard(caller, "fork sessions");
        if (i.at) return sb.forkAt(i.thread, i.at, { prompt: i.prompt, name: i.name, surface: surfaceOf(i, caller) });
        return sb.launch({ fork: i.thread, prompt: i.prompt, name: i.name, surface: surfaceOf(i, caller) });
      });

    tool("threads.mode", "Put a running thread in a permission mode, as Shift+Tab does in Claude Code: default (ask), acceptEdits (edits without asking), plan (read and plan only) or bypassPermissions (\"Doesn't ask\": no questions; Vyre's security floor and the Gate still hold, and only in a session with Vyre's plugin). Only a person's surface can; no answer ever sets it.",
      { type: "object", required: ["thread", "mode"], properties: { thread: str, mode: { type: "string", enum: PERSON_MODES } } },
      async (i, { caller, thread }) => {
        if (thread && thread === i.thread) throw Object.assign(new Error("a session's mode is changed by the person, not from the session"), { code: "denied" });
        return sb.mode(i.thread, i.mode);
      },
      ["cli", "local", "deck", "capsule"]);

    tool("threads.stop", "Stop a headless thread. Its transcript stays; threads.send resumes it.",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "stop sessions"); return sb.stop(i.thread); });

    // For other modules (teammates, ADR 0031): put words in a thread that never steer: a new turn
    // when the thread is idle, else handed over when its running turn ends.
    ctx.tool("threads.post", {
      description: "Give a thread words from a module (a teammate's result): a turn of their own now if it is idle, else after its running turn. Never steers. request: the request this reply answers (core/team's own id), so a surface with two open asks to the same teammate can match it by id instead of by role, FIFO.", internal: true,
      input: { type: "object", required: ["thread", "text"], properties: { thread: str, text: str, kind: str, from: str, request: str } },
      run: async (i, { caller }) => sb.post(i.thread, i.text, String(i.from || caller || "module"), i.kind || "post", safeRequest(i.request)),
    });
    // For other modules only (agents): start or resume with an agent's credentials, scope and
    // instructions. Internal, so no surface or model can hand a thread an environment.
    ctx.tool("threads.quick", {
      description: "One question to a purpose's warm session (a lean one already started, so no start-up wait): memory (Vyre IQ), planner, helper and the like. A fresh session per question; the system text is fixed per spare, the question's material goes in prompt. Returns { text, ok, cost_usd, warm, ms, thread }.", internal: true,
      input: { type: "object", required: ["purpose", "prompt"], properties: { purpose: { type: "string", enum: ["memory", "planner", "learn", "helper", "job"] }, prompt: str, system: str, model: str, timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 } } },
      run: async i => sb.quick({ purpose: i.purpose, prompt: i.prompt, system: i.system || null, model: i.model || null, timeoutMs: i.timeout_ms || 60_000 }),
    });

    ctx.tool("threads.launch", {
      description: "Start or resume a thread for an agent, with its credentials set only in that child.", internal: true,
      input: { type: "object", properties: { cwd: str, project: str, prompt: str, name: str, model: str, surface: str, resume: str,
        // The agent's thinking effort (agents.effort), one of sessions.effort's values.
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        agent: str, agent_kind: str, auth: str, append: str, budget_usd: { type: "number" }, purpose: str, provider: str, env: { type: "object" }, fallback: { type: "object" }, scope: { type: "object" },
        effort: { type: "string", enum: EFFORTS },
        // For jobs (Learning's distillation): no plugin, so the job's own prompt never reaches the
        // hooks; no tools; none of the user's settings; and stop after the first answer.
        plugins: { type: "array", items: str }, plugin: { type: "boolean" }, tools: { type: "string", enum: ["none", "default"] }, settings: { type: "boolean" }, once: { type: "boolean" }, lean: { type: "boolean" } } },
      run: async i => sb.launch(i),
    });
    // For agents: usage per agent, and Vyre's own words in a thread (budget warnings, a halt).
    ctx.tool("threads.usage", {
      description: "Turns, time, tokens and cost per agent, and the last rate-limit report.", internal: true,
      input: { type: "object", properties: { agent: str, since: { type: "integer" } } },
      run: async i => sb.usage(i),
    });
    ctx.tool("threads.notice", {
      description: "Say something in a thread as Vyre.", internal: true,
      input: { type: "object", required: ["thread", "text"], properties: { thread: str, text: str } },
      run: async i => sb.notice(i.thread, i.text),
    });
    ctx.tool("threads.halt", {
      description: "Stop a thread with a reason, saying why in the thread first.", internal: true,
      input: { type: "object", required: ["thread", "reason"], properties: { thread: str, reason: str, text: str } },
      run: async i => sb.halt(i.thread, i.reason, i.text),
    });
    // For projects.catalog: which sessions a terminal has open now, for its live flag.
    ctx.tool("threads.live", {
      description: "Sessions open in a running claude process other than vyred's own threads.", internal: true,
      input: { type: "object", properties: {} },
      run: async () => ({ sessions: [...sb.sessions.live(sb.ours())] }),
    });
    // For the Harness: words queued for a session open in a terminal, handed over at its Stop or
    // next prompt, and the reply that turn gave.
    ctx.tool("threads.inbox", {
      description: "Words queued for this session, marked handed over (via stop or prompt).", internal: true,
      input: { type: "object", required: ["session"], properties: { session: str, via: { type: "string", enum: ["stop", "prompt"] } } },
      run: async i => sb.deliver(i.session, i.via || "stop"),
    });
    ctx.tool("threads.replied", {
      description: "The turn that answered handed-over words has ended: its last message is their reply.", internal: true,
      input: { type: "object", required: ["session"], properties: { session: str, text: str } },
      run: async i => sb.replied(i.session, i.text || ""),
    });
    // For agents.history: conversations with agents, from the event log.
    ctx.tool("threads.history", {
      description: "Exchanges with agents (a send and its replies), newest last.", internal: true,
      input: { type: "object", properties: { agent: str, limit: { type: "integer" }, before: { type: "integer" } } },
      run: async i => sb.history(i),
    });
    // For vyred only: is this caller the agent it names ({agent, key}), or in the session it names
    // ({session, key})? See the route in core/daemon.
    ctx.tool("threads.vouch", {
      description: "The live thread of this agent, or this bound session, that holds this key; or null.", internal: true,
      input: { type: "object", required: ["key"], properties: { agent: str, session: str, key: str } },
      run: async i => ({ thread: i.agent ? sb.vouch(i.agent, i.key) : i.session ? sb.sessions.vouch(i.session, i.key) : null }),
    });
    ctx.tool("threads.pids", {
      description: "The processes Claude sessions run in: vyred's own thread children and every live bound session. vyred refuses a person-only call from under any of them.", internal: true,
      input: { type: "object", properties: {} },
      run: async () => ({ pids: [...new Set([...sb.ours(), ...sb.sessions.pids()])], ...sb.groupIds() }),
    });
    // The SessionStart hook binds its session to the claude process it runs in (sessions.js).
    tool("threads.bind", "SessionStart: bind this session to its claude process, for a key the MCP server sends to say which session a call is from.",
      { type: "object", required: ["session", "pid"], properties: { session: str, pid: { type: "integer" } } },
      async i => sb.sessions.bind(i.session, i.pid), ["harness"]);
    registerClaim(ctx, sb);                                              // threads.claimed, threads.contend

    // An SDK install still running ends with vyred, and cleans up after itself (sdk.js).
    return { async stop() { offGithubCleanup(); for (const off of offs) off(); await abortInstalls(); await sb.stopAll(); } };
  },
};
