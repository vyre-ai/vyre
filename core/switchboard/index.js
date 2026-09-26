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

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
];

/** Partial text is sent at most this often per thread: 20 a second, not one event per token. */
export const TEXT_EVERY_MS = 50;
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
 * Who a caller is, for the checks below. The MCP server calls as "mcp", or "mcp:agent:<name>"
 * inside an agent's own thread.
 */
const agentOf = caller => { const m = /^mcp:agent:(.+)$/.exec(String(caller || "")); return m ? m[1] : null; };

export class Switchboard {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, emit: (type: string, payload: any, where?: any) => any,
   *           call: (tool: string, input: any) => Promise<any>, root: string, log: (m: string) => void,
   *           run?: typeof defaultRun, bin?: string }} deps
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
    if (o.resume) {
      rec = this.must(o.resume);
      id = rec.id;
      if (this.live.has(id)) { if (o.prompt) this.write(id, o.prompt); return this.record(id); }
    } else {
      const w = await this.where(o);
      id = crypto.randomUUID();
      const now = Date.now();
      this.db.prepare(`INSERT INTO threads_runs (id, name, cwd, project, agent, agent_kind, status, model, auth, started_at, last_at)
        VALUES (?,?,?,?,?,?, 'starting', ?,?,?,?)`).run(id, o.name || null, w.cwd, w.project, o.agent || null, o.agent_kind || null,
        o.model || null, o.auth || "ambient", now, now);
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
    if (o.agent) { env.VYRE_AGENT = o.agent; env.VYRE_AGENT_KIND = o.agent_kind || "agent"; }
    else { delete env.VYRE_AGENT; delete env.VYRE_AGENT_KIND; }
    // An agent's context is limited to its projects; the Harness reads these (brief, Enrich,
    // recall.search through MCP). "*" is the assistant's: every project.
    if (o.scope) { env.VYRE_PROJECTS = o.scope.projects === "*" ? "*" : o.scope.projects.join(","); env.VYRE_SCOPE_CWDS = JSON.stringify(o.scope.cwds || []); }
    else { delete env.VYRE_PROJECTS; delete env.VYRE_SCOPE_CWDS; }
    const rec = this.must(id);
    const args = argsFor({ id, resume: o.resume, plugin: pluginDir(), model: o.model || rec.model, name: rec.name, append: o.append, budgetUsd: o.budget_usd });
    const state = { launch: o, message: "", pending: "", timer: null, lastPrompt: o.lastPrompt || null, switching: false, proc: null };
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
        if (this.asks.open(id).length === 0) this.set(id, { status: "idle" });
      }
      if (e.type === "thread.tool" && e.payload.phase === "started") this.set(id, { status: "working" });
      this.emit(e.type, e.payload, id, project);
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
    if (t.limited && st.launch.fallback && !st.switching) this.fallback(id, st);
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
    const reason = st.stopping ? "stopped" : code === 0 ? "exited" : `exited ${code ?? signal}${stderr ? ": " + cut(stderr, 160) : ""}`;
    this.set(id, { status: "stopped", pid: null, stopped_reason: reason });
    for (const a of this.asks.open(id)) this.closeAsk(a, "cancelled", "thread stopped");
    const rec = this.record(id);
    this.emit("thread.stopped", { code: code ?? null, reason }, id, rec ? rec.project : null);
  }

  closeAsk(a, decision, by) {
    if (!this.asks.close(a.id, decision, by)) return false;
    const rec = this.record(a.thread);
    this.emit("ask.answered", { ask: a.id, decision, by: by || null }, a.thread, rec ? rec.project : null);
    return true;
  }

  write(id, text) {
    const st = this.live.get(id);
    st.lastPrompt = text;
    st.proc.write(userLine(text, id));
    this.set(id, { status: "working" });
  }

  /** Type into a thread. The lease decides who may; a stopped thread is resumed first. */
  async send(id, text, surface) {
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

  /** The kind of agent a caller is, from the threads it runs. Unknown is not the assistant. */
  kindOf(agent) {
    const r = /** @type {any} */ (this.db.prepare("SELECT agent_kind FROM threads_runs WHERE agent = ? ORDER BY last_at DESC LIMIT 1").get(agent));
    return r ? r.agent_kind : null;
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
  }
}

const str = { type: "string" };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const sb = new Switchboard({
      db: ctx.store.db, call: ctx.call, root: ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "",
      emit: (type, payload, where) => ctx.events.emit(type, payload, where), log: ctx.log,
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
    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run });

    tool("threads.start", "Start a headless Claude Code session in a folder or a project's home, owned by vyred so it outlives every surface. The calling surface gets the keyboard. Returns the thread; its id is the Claude Code session id.",
      { type: "object", properties: { project: str, cwd: str, prompt: str, name: str, model: str, surface: str } },
      async (i, { caller }) => { guard(caller, "start sessions"); return sb.launch({ ...i, surface: surfaceOf(i, caller) }); });

    tool("threads.send", "Type into a thread. Only the surface holding its lease may type; a free thread is taken on the first keystroke. A stopped thread is resumed first.",
      { type: "object", required: ["thread", "text"], properties: { thread: str, text: str, surface: str } },
      async (i, { caller }) => { guard(caller, "type into sessions"); return sb.send(i.thread, i.text, surfaceOf(i, caller)); });

    tool("threads.list", "Headless threads: running ones and those active in the last day (all: every one), newest first, with who holds each and how many questions are open.",
      { type: "object", properties: { agent: str, all: { type: "boolean" } } },
      async (i, { caller }) => { guard(caller, "list sessions"); return sb.list(i); });

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
      async (i, { caller }) => {
        if (String(caller).startsWith("mcp")) throw new Error("permission questions are answered by the user, not by a model");
        return sb.answer(i.ask, i.decision, surfaceOf(i, caller), i.message);
      });

    tool("threads.stop", "Stop a headless thread. Its transcript stays; threads.send resumes it.",
      { type: "object", required: ["thread"], properties: { thread: str } },
      async (i, { caller }) => { guard(caller, "stop sessions"); return sb.stop(i.thread); });

    // For other modules only (agents): start or resume with an agent's credentials, scope and
    // instructions. Internal, so no surface or model can hand a thread an environment.
    ctx.tool("threads.launch", {
      description: "Start or resume a thread for an agent, with its credentials set only in that child.", internal: true,
      input: { type: "object", properties: { cwd: str, project: str, prompt: str, name: str, model: str, surface: str, resume: str,
        agent: str, agent_kind: str, auth: str, append: str, budget_usd: { type: "number" }, env: { type: "object" }, fallback: { type: "object" }, scope: { type: "object" } } },
      run: async i => sb.launch(i),
    });
    registerClaim(ctx, sb);                                              // threads.claimed, threads.contend

    return { async stop() { await sb.stopAll(); } };
  },
};
