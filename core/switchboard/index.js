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
import { translate, cut } from "./translate.js";
import { argsFor, userLine, answerLine, run as defaultRun } from "./runner.js";
import { Leases } from "./lease.js";
import { Asks } from "./asks.js";
import { register as registerClaim } from "./claim.js";
import { Sessions, SESSIONS_MIGRATION, alive } from "./sessions.js";
import { findSession, sessionInfo, openElsewhere } from "./adopt.js";
import { wantsMacs, askMacs, mergeRows } from "../modules/federate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
];


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

/** The events a watch waits for, and the reason each gives. */
const WATCHED = { "thread.finished": "finished", "ask.raised": "asked", "thread.stopped": "stopped" };

/** Launch options kept with a thread and reused on every resume. */
const KEPT = ["plugin", "plugins", "tools", "settings", "once"];

/** Partial text is sent at most this often per thread: 20 a second, not one event per token. */
export const TEXT_EVERY_MS = 50;
/**
 * A turn's partial text (thread.text with a delta) is deleted from the event log this long after
 * its thread.finished: the done text holds the whole message, and the grace lets a surface that
 * is still catching up on the SSE backlog see the deltas first. VYRE_TEXT_PRUNE_MS overrides it.
 */
export const TEXT_PRUNE_MS = 60_000;
const LIVE = ["starting", "working", "waiting", "idle"];

/**
 * The Harness plugin every thread loads. VYRE_HARNESS_DIR points elsewhere (tests, a user's own
 * copy); a missing plugin means the thread runs without Vyre's hooks rather than not at all.
 */
export function pluginDir() {
  const dir = process.env.VYRE_HARNESS_DIR || path.resolve(HERE, "..", "..", "harness");
  return fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}

/**
 * What a person approves when they answer an ask: the decision, the tool, where it goes, and the thread.
 * @param {Switchboard} sb @param {{ ask: string, decision: string }} i
 */
export function answerSummary(sb, i) {
  const a = /** @type {any} */ (sb.asks.get(i.ask));
  if (!a) return `${i.decision} permission question ${i.ask}`;
  const t = sb.record(a.thread);
  const where = a.destination ? ` to ${a.destination}` : "";
  return `${i.decision === "allow" ? "Allow" : "Deny"} ${a.tool}${where}${a.summary ? `: ${a.summary}` : ""} (thread ${t && t.name ? t.name : String(a.thread).slice(0, 8)})`;
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
   *           transcripts?: string[], naming?: (id: string, ours: number[]) => number[], isClaude?: (pid: number) => boolean }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.db = deps.db;
    this.leases = new Leases(deps.db);
    this.asks = new Asks(deps.db);
    /** @type {Map<string, any>} live sessions: id -> { proc, launch, message, pending, timer, lastPrompt } */
    this.live = new Map();
    this.run = deps.run || defaultRun;
    this.bin = deps.bin || process.env.VYRE_CLAUDE_BIN || "claude";
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
    const stale = this.db.prepare(`SELECT id FROM threads_runs WHERE status IN (${LIVE.map(() => "?").join(",")})`).all(...LIVE);
    for (const r of stale) {
      this.db.prepare("UPDATE threads_runs SET status = 'stopped', stopped_reason = 'vyred restarted', pid = NULL WHERE id = ?").run(r.id);
      for (const a of this.asks.open(String(r.id))) this.closeAsk(a, "cancelled", "vyred restarted");
    }
  }

  /**
   * Emit, without letting a payload that looks like a secret take the thread down. The event log
   * refuses such payloads (spec 6); what Claude typed or ran can contain a token, so the text
   * is withheld and the event still goes out, saying so.
   */
  emit(type, payload, thread, project) {
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
      for (const [k, v] of Object.entries(payload)) safe[k] = typeof v === "string" && k !== "tool" && k !== "id" && k !== "ask" ? "[withheld: looked like a credential]" : v;
      return this.deps.emit(type, safe, where);
    }
  }

  record(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM threads_runs WHERE id = ?").get(id));
    if (!r) return null;
    const holder = this.leases.holder(id);
    return { id: r.id, name: r.name, cwd: r.cwd, project: r.project, agent: r.agent, status: r.status, model: r.model,
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
  }

  /** Where a thread runs: the folder given, else the project's home. */
  async where({ cwd, project }) {
    let slug = null, home = null;
    if (project) {
      const list = await this.deps.call("projects.list", {});
      const p = (list.data?.projects || []).find(x => x.slug === project || String(x.name).toLowerCase() === String(project).toLowerCase());
      if (!p) throw new Error(`no project ${project}`);
      slug = p.slug; home = p.home;
    }
    const dir = cwd ? path.resolve(cwd) : home;
    if (!dir) throw new Error("a thread needs a folder: give cwd or project");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    if (!slug) { const of = await this.deps.call("projects.of", { cwd: dir }); slug = of.data?.slug || null; }
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
    if (o.lean) o = { ...o, plugin: false, tools: "none", settings: false };
    if (o.resume) {
      rec = this.must(o.resume);
      id = rec.id;
      if (this.live.has(id)) { if (o.prompt) this.write(id, o.prompt); return this.record(id); }
      const row = /** @type {any} */ (this.db.prepare("SELECT opts FROM threads_runs WHERE id = ?").get(id));
      if (row && row.opts) o = { ...JSON.parse(String(row.opts)), ...o };
    } else {
      const w = await this.where(o);
      id = crypto.randomUUID();
      const now = Date.now();
      this.db.prepare(`INSERT INTO threads_runs (id, name, cwd, project, agent, agent_kind, status, model, auth, started_at, last_at)
        VALUES (?,?,?,?,?,?, 'starting', ?,?,?,?)`).run(id, o.name || null, w.cwd, w.project, o.agent || null, o.agent_kind || null,
        o.model || null, o.auth || "ambient", now, now);
      const kept = Object.fromEntries(KEPT.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
      if (Object.keys(kept).length) this.db.prepare("UPDATE threads_runs SET opts = ? WHERE id = ?").run(JSON.stringify(kept), id);
      rec = this.must(id);
    }
    this.spawn(id, { ...o, cwd: rec.cwd, resume: Boolean(o.resume) });
    const payload = { name: rec.name, cwd: rec.cwd, project: rec.project, agent: rec.agent, headless: true, resumed: Boolean(o.resume) };
    this.emit("thread.started", payload, id, rec.project);
    // The surface that started it gets the keyboard. A prompt given at launch by a module (an
    // agent asked something) is typed without taking the lease, so no surface is locked out.
    if (o.surface) this.lease(id, o.surface);
    if (o.prompt) {
      if (o.surface) await this.send(id, o.prompt, o.surface);
      else { this.write(id, o.prompt); this.emit("thread.sent", { text: cut(o.prompt, 2000), surface: o.agent ? `agent:${o.agent}` : null }, id, rec.project); }
    }
    return this.record(id);
  }

  spawn(id, o) {
    const env = { ...process.env, VYRE_HOME: this.deps.root, VYRE_THREAD: id };
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
    const rec = this.must(id);
    // Learned skills load with the Harness; a job without the plugin gets only what it names.
    const plugins = [...(o.plugin === false ? [] : learnedDirs(this.deps.root, rec.project, rec.agent)), ...(o.plugins || [])];
    const args = argsFor({ id, resume: o.resume, plugin: o.plugin === false ? null : pluginDir(), plugins, model: o.model || rec.model, name: rec.name,
      append: o.append, budgetUsd: o.budget_usd, tools: o.tools === "none" ? "none" : null, settings: o.settings === false ? false : undefined });
    const state = { launch: o, key, message: "", pending: "", timer: null, lastPrompt: o.lastPrompt || null, switching: false, proc: null };
    this.live.set(id, state);
    state.proc = this.run({
      bin: this.bin, args, cwd: rec.cwd, env,
      onMessage: m => this.onMessage(id, state, m),
      onExit: (code, signal, stderr) => this.onExit(id, state, code, signal, stderr),
    });
    this.set(id, { status: "starting", pid: state.proc.pid || null, stopped_reason: null });
  }

  onMessage(id, st, m) {
    const t = translate(m);
    const rec = this.record(id);
    const project = rec ? rec.project : null;
    if (t.model) this.set(id, { model: t.model, status: rec && rec.status === "starting" ? "idle" : rec ? rec.status : "idle" });
    if (t.message !== undefined) { this.flush(id, st); st.message = t.message; }
    if (t.delta) {
      st.pending += t.delta;
      if (!st.timer) st.timer = setTimeout(() => this.flush(id, st), TEXT_EVERY_MS);
    }
    for (const e of t.events) {
      if (e.type === "thread.text") this.flush(id, st);                // the whole text lands after its last delta
      if (e.type === "thread.finished") {
        this.flush(id, st);
        const cost = Number(e.payload.cost_usd) || 0;
        this.db.prepare("UPDATE threads_runs SET cost_usd = cost_usd + ?, turns = turns + 1, last_at = ? WHERE id = ?").run(cost, Date.now(), id);
        const tk = e.payload.tokens || {};
        this.db.prepare(`INSERT INTO threads_turns (thread, agent, auth, at, ok, cost_usd, duration_ms, input, output, cache_read, cache_write)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, rec ? rec.agent : null, rec ? rec.auth || "ambient" : "ambient", Date.now(), e.payload.ok ? 1 : 0, cost,
          Number(e.payload.duration_ms) || 0, Number(tk.input) || 0, Number(tk.output) || 0, Number(tk.cache_read) || 0, Number(tk.cache_write) || 0);
        if (this.asks.open(id).length === 0) this.set(id, { status: "idle" });
        // A one-shot thread (a job, not a conversation) ends with its first answer.
        if (st.launch.once && !st.stopping) { st.done = true; st.stopping = true; setImmediate(() => st.proc.stop()); }
      }
      if (e.type === "thread.tool" && e.payload.phase === "started") this.set(id, { status: "working" });
      const ev = this.emit(e.type, e.payload, id, project);
      if (e.type === "thread.finished" && ev) this.schedulePrune(id, ev.id);
    }
    if (t.ask) {
      const a = this.asks.raise({ thread: id, request_id: t.ask.request_id, tool: t.ask.tool, summary: t.ask.summary, destination: t.ask.destination, reason: t.ask.reason ? cut(t.ask.reason) : null });
      st.inputs = st.inputs || new Map();
      st.inputs.set(a.id, t.ask.input);                                    // kept in memory only, to hand back on allow
      this.set(id, { status: "waiting" });
      this.emit("ask.raised", { ask: a.id, tool: a.tool, summary: a.summary, destination: a.destination, reason: a.reason, holder: rec ? rec.holder : null }, id, project);
    }
    if (t.cancel) {
      const a = this.asks.byRequest(id, t.cancel);
      if (a) this.closeAsk(a, "cancelled", "claude");
    }
    if (t.limit) this.limit(id, st, t.limit, project);
    if (t.limited && st.launch.fallback && !st.switching) this.fallback(id, st);
  }

  /**
   * Claude Code reported the subscription's rate limit: kept on the thread, emitted as
   * thread.limit, and said in the thread when it is a warning or a refusal (once per status).
   */
  limit(id, st, l, project) {
    this.db.prepare("UPDATE threads_runs SET last_limit = ? WHERE id = ?").run(JSON.stringify({ ...l, at: Date.now() }), id);
    this.emit("thread.limit", l, id, project);
    if (l.status === "allowed" || st.limitStatus === l.status) { st.limitStatus = l.status; return; }
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
    if (!st.pending) return;
    const delta = st.pending; st.pending = "";
    const rec = this.record(id);
    this.emit("thread.text", { message: st.message, delta }, id, rec ? rec.project : null);
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
    if (st.switching || this.live.get(id) !== st) return;               // replaced (fallback): not an end
    this.live.delete(id);
    const reason = st.haltReason || (st.done ? "done" : st.stopping ? "stopped" : code === 0 ? "exited" : `exited ${code ?? signal}${stderr ? ": " + cut(stderr, 160) : ""}`);
    this.set(id, { status: "stopped", pid: null, stopped_reason: reason });
    for (const a of this.asks.open(id)) this.closeAsk(a, "cancelled", "thread stopped");
    const rec = this.record(id);
    this.emit("thread.stopped", { code: code ?? null, reason }, id, rec ? rec.project : null);
  }

  closeAsk(a, decision, by) {
    if (!this.asks.close(a.id, decision, by)) return false;
    const rec = this.record(a.thread);
    this.emit("ask.answered", { ask: a.id, decision, by: by || null, tool: a.tool, summary: a.summary || null }, a.thread, rec ? rec.project : null);
    return true;
  }

  write(id, text) {
    const st = this.live.get(id);
    st.lastPrompt = text;
    st.proc.write(userLine(text, id));
    this.set(id, { status: "working" });
  }

  /** Our children's pids: a session bound to one of these is ours, not open elsewhere. */
  ours() { return [...this.live.values()].map(st => st.proc && st.proc.pid).filter(Boolean); }

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
   * process has it open, since one transcript takes one writer.
   */
  async send(id, text, surface) {
    if (!this.live.has(id)) {
      if (!this.record(id)) await this.adopt(id);
      const why = this.elsewhere(id);
      if (why) return { sent: false, open_elsewhere: true, note: `This session is open somewhere else: ${why}. Only one keyboard can type into it, so close it there or type there.` };
    }
    const rec = this.must(id);
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
    this.write(id, text);
    this.emit("thread.sent", { text: cut(text, 2000), surface }, id, rec.project);
    return { sent: true, thread: id };
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

  /** Answer a permission question. The ask id is the capability; the decision reaches Claude Code first, then the row closes. */
  answer(askId, decision, by, message) {
    const a = this.asks.get(askId);
    if (!a) throw new Error(`no ask ${askId}`);
    if (a.state !== "open") return { ask: askId, answered: false, note: `already ${a.state}${a.decision ? " (" + a.decision + ")" : ""}` };
    const st = this.live.get(a.thread);
    if (!st) { this.closeAsk(a, "cancelled", "thread stopped"); return { ask: askId, answered: false, note: "the thread has stopped" }; }
    const input = st.inputs && st.inputs.get(askId);
    st.proc.write(answerLine(a.request_id, decision, input, message));
    st.inputs && st.inputs.delete(askId);
    this.closeAsk(a, decision, by);
    if (this.asks.open(a.thread).length === 0) this.set(a.thread, { status: "working" });
    return { ask: askId, answered: true, decision };
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
    return rows.map(r => this.record(String(r.id)));
  }

  /** A thread with its recent events, its open asks and who holds it. What a surface opening it needs. */
  get(id, { since = 0, limit = 200 } = {}) {
    const rec = this.must(id);
    const events = this.db.prepare("SELECT * FROM events WHERE thread = ? AND id > ? ORDER BY id DESC LIMIT ?").all(id, since, Math.min(1000, limit))
      .reverse().map(e => ({ id: e.id, at: e.at, type: e.type, payload: JSON.parse(String(e.payload)) }));
    return { thread: rec, asks: this.asks.open(id), events };
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
        AND (type = 'thread.sent' OR (type = 'thread.text' AND json_extract(payload, '$.done') = 1 AND json_extract(payload, '$.notice') IS NULL))
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
        AND json_extract(payload, '$.done') = 1 ORDER BY id DESC LIMIT 1`).get(thread));
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

  async stopAll() {
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
    for (const job of [...this.prunes]) job.run();                     // no surface is left to catch up
  }
}

const str = { type: "string" };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const sb = new Switchboard({
      db: ctx.store.db, call: ctx.call, root: ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "",
      transcripts: (ctx.config && ctx.config.transcripts) || [],
      emit: (type, payload, where) => ctx.events.emit(type, payload, where), log: ctx.log,
      prune: (thread, before) => ctx.events.prune("thread.text", { thread, before, has: "delta" }),
    });
    sb.recover();

    /**
     * Guard every tool. Inside an agent's own thread (caller mcp:agent:<name>) only the assistant
     * may drive sessions; other agents stay inside their own work.
     */
    const guard = (caller, what) => {
      const agent = agentOf(caller);
      if (agent && sb.kindOf(agent) !== "assistant") throw new Error(`only the assistant can ${what}; ${agent} is an agent`);
    };
    const surfaceOf = (input, caller) => String(input.surface || caller || "vyre");
    const tool = (name, description, input, run, callers, extra = {}) => ctx.tool(name, { description, input, run, callers, ...extra });

    tool("threads.start", "Start a headless Claude Code session in a folder or a project's home, owned by vyred so it outlives every surface. The calling surface gets the keyboard. Returns the thread; its id is the Claude Code session id.",
      { type: "object", properties: { project: str, cwd: str, prompt: str, name: str, model: str, surface: str, append: str,
        lean: { type: "boolean", description: "A one-question thread: no Vyre plugin, no tools, no MCP servers, none of the user's settings. Cheap to start." } } },
      async (i, { caller }) => { guard(caller, "start sessions"); return sb.launch({ ...i, surface: surfaceOf(i, caller) }); });

    tool("threads.send", "Type into a thread. Only the surface holding its lease may type; a free thread is taken on the first keystroke. A stopped thread is resumed first.",
      { type: "object", required: ["thread", "text"], properties: { thread: str, text: str, surface: str } },
      async (i, { caller }) => { guard(caller, "type into sessions"); return sb.send(i.thread, i.text, surfaceOf(i, caller)); });

    tool("threads.list", "Headless threads: running ones and those active in the last day (all: every one), newest first, with who holds each and how many questions are open.",
      { type: "object", properties: { agent: str, all: { type: "boolean" }, machines: { type: "string", enum: ["all", "local"] } } },
      async (i, { caller }) => {
        guard(caller, "list sessions");
        const { machines: _, ...q } = i;
        if (!wantsMacs(ctx, i, caller)) return sb.list(q);
        // On the box, for the person: the Macs' threads too, newest first, each labelled with its machine.
        const answers = await askMacs(ctx, "threads.list", q);
        return mergeRows(ctx, sb.list(q), answers, { compare: (a, b) => (b.last || 0) - (a.last || 0) });
      });

    tool("threads.get", "One thread: its record, its open permission questions, and its recent events (since: an event id).",
      { type: "object", required: ["thread"], properties: { thread: str, since: { type: "integer" }, limit: { type: "integer" } } },
      async (i, { caller }) => { guard(caller, "read sessions"); return sb.get(i.thread, i); });

    tool("threads.lease", "Take the keyboard of a thread for a surface. Always succeeds, and says who had it; the other surfaces go read-only.",
      { type: "object", required: ["thread"], properties: { thread: str, surface: str } },
      async (i, { caller }) => { guard(caller, "take a session's keyboard"); return sb.lease(i.thread, surfaceOf(i, caller)); });

    tool("threads.release", "Give the keyboard back. Releasing a lease you do not hold changes nothing.",
      { type: "object", required: ["thread"], properties: { thread: str, surface: str } },
      async (i, { caller }) => { guard(caller, "release a session"); return sb.release(i.thread, surfaceOf(i, caller)); });

    tool("threads.asks", "Permission questions waiting on the user, oldest first. A surface that reconnects reads these; events alone cannot say what is open now.",
      { type: "object", properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "read questions"); return sb.asks.open(i.thread).map(({ request_id, ...a }) => a); });

    tool("threads.answer", "Answer a permission question: allow or deny. Only a person's surface can answer; a model never approves a permission, its own or another session's.",
      { type: "object", required: ["ask", "decision"], properties: { ask: str, decision: { type: "string", enum: ["allow", "deny"] }, message: str, surface: str } },
      async (i, { caller }) => sb.answer(i.ask, i.decision, surfaceOf(i, caller), i.message),
      // A person's surfaces only. The loader refuses (code "denied") and hides the tool from every
      // other caller; callers is an allowlist, so "mcp" and "mcp:agent:<name>" are both out. The
      // Deck and the Capsule claim their own names over HTTP, so they are listed by name.
      ["cli", "local", "module", "deck", "capsule"],
      // And a person must be there right now (presence proof, ADR 0004): the summary is what they
      // read in the Touch ID dialog or at the terminal before the answer goes through.
      { presence: { summary: i => answerSummary(sb, i) } });

    tool("threads.watch", "Tell me once when a thread finishes a turn, asks a question, or stops: emits thread.watched {watch, thread, reason, notify, note, summary} and clears itself. until: finished, asks or either (default).",
      { type: "object", required: ["thread"], properties: { thread: str, until: { type: "string", enum: ["finished", "asks", "either"] }, notify: str, note: str } },
      async (i, { caller }) => { guard(caller, "watch sessions"); return sb.watch(i, String(caller || "")); });

    tool("threads.unwatch", "Stop waiting on a watch.",
      { type: "object", required: ["watch"], properties: { watch: str } },
      async (i, { caller }) => { guard(caller, "watch sessions"); return sb.unwatch(i.watch); });

    tool("threads.stop", "Stop a headless thread. Its transcript stays; threads.send resumes it.",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "stop sessions"); return sb.stop(i.thread); });

    // For other modules only (agents): start or resume with an agent's credentials, scope and
    // instructions. Internal, so no surface or model can hand a thread an environment.
    ctx.tool("threads.launch", {
      description: "Start or resume a thread for an agent, with its credentials set only in that child.", internal: true,
      input: { type: "object", properties: { cwd: str, project: str, prompt: str, name: str, model: str, surface: str, resume: str,
        agent: str, agent_kind: str, auth: str, append: str, budget_usd: { type: "number" }, env: { type: "object" }, fallback: { type: "object" }, scope: { type: "object" },
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
    // The SessionStart hook binds its session to the claude process it runs in (sessions.js).
    tool("threads.bind", "SessionStart: bind this session to its claude process, for a key the MCP server sends to say which session a call is from.",
      { type: "object", required: ["session", "pid"], properties: { session: str, pid: { type: "integer" } } },
      async i => sb.sessions.bind(i.session, i.pid), ["harness"]);
    registerClaim(ctx, sb);                                              // threads.claimed, threads.contend

    return { async stop() { await sb.stopAll(); } };
  },
};
