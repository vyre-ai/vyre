// @ts-check
// bridge — everything the Capsule asks of vyred, in one place, in the main process.
//
// The window never talks to vyred. It asks this over IPC, and this asks vyred's API over the
// socket: the same tools the CLI, the Deck and Claude use (spec 9, "none reads the store
// directly"). That keeps the renderer sandboxed with no Node and no socket, and it means there
// is one copy of what is true (the waiting list, the reply streaming in) that any window, shown
// or re-shown, is handed whole.
//
// The switchboard (core/switchboard, module `threads`, and core/agents) and the Gate (gate.*) are
// optional modules. Which of their tools exist is read from GET /v1/tools, and every feature that
// needs a missing one says so in words, rather than failing a call and showing nothing.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as route from "./route.js";
import * as st from "./state.js";
import * as glass from "./glass.js";

/** @typedef {{ call: (tool: string, input?: any, opts?: any) => Promise<any>, get: (route: string, opts?: any) => Promise<any> }} Client */

const MISSING = {
  agents: "The assistant and agents come with the switchboard, which this vyred is not running yet.",
  threads: "Driving a session needs the switchboard, which this vyred is not running yet.",
  gate: "Holds come from the Gate, which this vyred is not running yet.",
};

const s = v => (v == null ? "" : String(v));

/** Words for an error, for the one line the Capsule shows. */
export function explain(err) {
  if (!err) return "";
  if (err.code === "unreachable") return "vyred is not running. Start it with vyre up.";
  if (err.code === "no_such_tool") {
    const mod = /no tool (\w+)\./.exec(err.message || "");
    return (mod && MISSING[mod[1]]) || err.message;
  }
  if (err.code === "denied") return `The rules stopped it: ${err.message}`;
  // threads.send knows only the sessions the switchboard runs; a terminal's own session is not one.
  if (/^no thread /.test(err.message || "")) return "That session is not one vyred runs, so it cannot be typed into from here. Open it where it runs, or start a new thread.";
  return err.message || err.code;
}

export class Bridge extends EventEmitter {
  /**
   * `home` is vyred's home, where quick questions get a folder to run in. By default it is the
   * folder holding vyred's socket, else VYRE_HOME, else ~/.vyre: the same place main.js uses.
   * @param {Client & { socket?: string }} client @param {{ now?: () => number, home?: string }} [opts]
   */
  constructor(client, { now = () => Date.now(), home } = {}) {
    super();
    this.client = client;
    this.now = now;
    this.home = home || homeOf(client.socket) || process.env.VYRE_HOME || path.join(os.homedir(), ".vyre");
    /** @type {Map<string, string>} quick threads this Capsule started, and the model each runs */
    this.quick = new Map();
    /** @type {Set<string>} quick threads with a process that may still be running */
    this.running = new Set();
    /** @type {Set<string>} threads this Capsule stopped: their thread.stopped is not the reply failing */
    this.stopping = new Set();
    /** The Capsule was closed: a quick thread still answering is stopped once its turn ends. */
    this.reap = false;
    /** Stop was pressed before the reply's thread was known. */
    this.cancelWanted = false;
    /** @type {{ text: string, answer: string|null, sources: any[], confidence: number|null, answerAge: string|null }|null} the last memory answer, for the reply beside it */
    this.lastRecall = null;
    /** @type {Set<string>} */
    this.tools = new Set();
    /** @type {glass.Catalog} route's catalog, plus the paired box's address */
    this.catalog = { agents: null, projects: [], threads: [] };
    /** @type {st.Waiting[]} */
    this.waiting = [];
    /** @type {st.Reply|null} */
    this.reply = null;
    this.up = false;
    this.lease = /** @type {string|null} */ (null);
    /**
     * A reply whose thread id is not known yet (agents.ask, threads.start): the first thread.sent
     * from this surface names it. The switchboard emits thread.sent right after the words reach
     * the child, before any of its output, so nothing of the reply comes before it.
     */
    this.pending = false;
    /** @type {st.Dm|null} the open DM, if any: nothing is fetched or folded for a DM that is not open */
    this.chat = null;
    /** @type {any[]|null} events heard while the open DM's history loads, folded in after it */
    this.dmBuffer = null;
    /** Bumped on every open and close, so a slow history never lands in a DM that has moved on. */
    this.dmSeq = 0;
    this.pendingSeq = 0;
    /** The newest event id heard on the stream. */
    this.lastEvent = 0;
  }

  /** Who is asking, for a waiting row: the agent whose thread it is, else the thread's name. */
  who(thread) {
    if (!thread) return null;
    const a = (this.catalog.agents || []).find(x => x.thread === thread);
    if (a) return a.name;
    const t = (this.catalog.threads || []).find(x => x.id === thread);
    return t ? t.label : null;
  }

  has(tool) { return this.tools.has(tool); }

  /** A project's name from its slug, for the lines people read. */
  projectName(slug) { return ((this.catalog.projects || []).find(p => p.slug === slug) || {}).name || slug; }

  /** What vyred can do, and everything `@` can name. Cheap enough to run on every open. */
  async refresh() {
    const t = await this.client.get("/v1/tools");
    if (t.error) { this.up = false; this.catalog = { agents: null, projects: [], threads: [] }; this.waiting = []; this.emit("change"); return { up: false, why: explain(t.error) }; }
    this.up = true;
    this.tools = new Set(t.data.map(x => x.name));
    const [agents, projects, recent, headless] = await Promise.all([
      this.has("agents.list") ? this.client.call("agents.list") : null,
      this.client.call("projects.list"),
      this.client.call("projects.catalog", { limit: 30, human: true }),
      this.has("threads.list") ? this.client.call("threads.list") : null,
    ]);
    const list = (projects && projects.data && projects.data.projects) || [];
    const nameOf = slug => ((list.find(p => p.slug === slug) || {}).name) || slug;
    /** @type {route.Thread[]} */
    const threads = [];
    const seen = new Set();
    // Threads in projects carry the project's name, which is how the user thinks of them.
    const per = await Promise.all(list.map(p => this.client.call("projects.threads", { project: p.slug, limit: 20 })));
    list.forEach((p, i) => {
      for (const x of (per[i] && per[i].data) || []) {
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        threads.push({ id: x.id, label: x.label || x.name || x.title || x.id.slice(0, 8), cwd: x.cwd, last: x.last, project: p.slug, projectName: p.name });
      }
    });
    // The switchboard's own threads (running, or active in the last day): the ones threads.send
    // can type into. threads.list rows are {id, name, cwd, project, agent, status, last, holder}.
    for (const x of (headless && Array.isArray(headless.data) ? headless.data : [])) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      threads.push({ id: x.id, label: x.name || folderOf(x.cwd) || x.id.slice(0, 8), cwd: x.cwd, last: x.last, project: x.project || null,
        projectName: x.project ? nameOf(x.project) : null, agent: x.agent || null });
    }
    for (const x of (recent && recent.data && recent.data.sessions) || []) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      threads.push({ id: x.id, label: x.label || x.name || x.title || x.id.slice(0, 8), cwd: x.cwd, last: x.last, project: null, projectName: null });
    }
    const agentRows = agents && agents.data ? (Array.isArray(agents.data) ? agents.data : agents.data.agents || []) : null;
    this.catalog = {
      agents: agentRows ? agentRows.map(a => ({ name: String(a.name), kind: a.kind, doing: a.doing || a.status || null, thread: a.thread || null, computer: Boolean(a.computer) })) : null,
      projects: list.map(p => ({ slug: p.slug, name: p.name, org: p.org, home: p.home, threads: p.threads, last: p.last,
        people: Array.isArray(p.people) ? p.people.filter(x => x && x.name).map(x => ({ name: String(x.name) })) : [] })),
      threads,
      // The paired box's address, for Glass (glass.js); null when there is none, never a guess.
      box: await glass.address(this.client, this.has("link.status")),
    };
    await this.loadWaiting();
    this.emit("change");
    return { up: true };
  }

  /** @param {string} q */
  complete(q) { return route.complete(q, this.catalog); }

  /**
   * What the box means right now: an @ being typed (and its completions), or not. The page asks
   * rather than parsing for itself, so there is one rule for what `@` means.
   * @param {string} text @param {number} caret
   */
  mention(text, caret) {
    const m = route.mention(text, caret);
    return { ...m, items: m.completing === null ? [] : this.complete(m.completing) };
  }

  /**
   * Where Enter will send. For an agent, its own threads decide which one the words belong to.
   * @param {route.Candidate|null} target @param {string} text
   */
  async destinations(target, text) {
    let agentThreads = [];
    if (target && target.kind === "agent" && this.has("agents.threads")) {
      const r = await this.client.call("agents.threads", { agent: target.id });
      const rows = r.data ? (Array.isArray(r.data) ? r.data : r.data.threads || []) : [];
      agentThreads = rows.map(x => ({ id: x.id || x.thread, label: x.name || x.label || x.title || String(x.id || x.thread).slice(0, 8),
        last: x.last || x.started, project: x.project || null, projectName: x.project ? this.projectName(x.project) : null, agent: target.id }));
    }
    const r = route.destinations(target, text, this.catalog, { agentThreads, now: this.now(), quick: this.has("threads.start") });
    // Each option carries how it reads, so the page draws it without a copy of the rules.
    const d = { ...r, options: r.options.map(o => ({ ...o, show: route.describe(o) })) };
    // Say up front when the chosen destination cannot be reached from this vyred, not after Enter.
    const need = d.options[0] && needs(d.options[0]);
    return { ...d, unavailable: need && !this.has(need) ? explain({ code: "no_such_tool", message: `no tool ${need}` }) : null };
  }

  /**
   * Memory first. Answers from what the user has already said, on this Mac, with no model: the
   * fastest honest answer there is, and the one that works with no network (floor rule 9).
   * @param {string} text
   */
  async recall(text, { project_cwds } = /** @type {{ project_cwds?: string[] }} */ ({})) {
    const t0 = this.now();
    const scope = project_cwds && project_cwds.length ? { project_cwds } : {};
    const [facts, hits] = await Promise.all([
      this.client.call("memory.relevant", { text, limit: 3, ...scope }),
      this.client.call("recall.search", { q: text, limit: 3, per_session: 1, ...scope }),
    ]);
    // Memory ranks by the thing named ("Dana"). The rest of the question says which fact about
    // it is wanted ("email"), so a fact that shares those words comes first.
    const asked = route.words(text);
    const f = (facts.data || []).filter(x => (x.score ?? x.confidence ?? 0) >= 0.5)
      .map(x => ({ x, s: (x.score ?? x.confidence ?? 0) + 0.5 * route.words(x.text).filter(w => asked.includes(w) && !route.words(x.matched).includes(w)).length }))
      .sort((a, b) => b.s - a.s).map(({ x }) => x);
    const h = hits.data || [];
    // memory.relevant gives each fact a confidence (0..1) and an age ("3 weeks"); the page shows
    // both beside a memory answer. A transcript hit is only a quote: it has no confidence, and it
    // shows as what was said ("You said, 2 weeks ago: ..."), never as if it were a fact.
    const out = {
      ms: Math.max(1, this.now() - t0),
      answer: f[0] ? f[0].text : null,
      confidence: f[0] ? confidenceOf(f[0]) : null,
      answerAge: f[0] ? s(f[0].age) || null : null,
      more: f.slice(1).map(x => x.text),
      sources: [
        ...f.filter(x => x.ref).map(x => ({ kind: "fact", session: x.ref.session, seq: x.ref.seq, name: x.ref.name || x.source, quote: x.text, age: x.age || "", confidence: confidenceOf(x) })),
        ...h.map(x => ({ kind: "quote", role: x.role === "assistant" ? "assistant" : "user", session: x.session, seq: x.seq, name: x.name || x.title || x.session.slice(0, 8),
          quote: plain(x.snippet || x.text), age: route.age(x.ts, this.now()), confidence: null })),
      ].filter((x, i, all) => all.findIndex(y => y.session === x.session) === i).slice(0, 3),
      error: facts.error && hits.error ? explain(hits.error) : null,
    };
    out.memo = memoItems(out);
    // Kept for the reply to the same words, which the page shows beside what memory said. A quick
    // question sends the model exactly this, the lines on screen and nothing more (quickAppend):
    // the answer and its three sources. The rest of memory never leaves this Mac from here.
    this.lastRecall = { text: String(text).trim(), answer: out.answer, sources: out.sources, confidence: out.confidence, answerAge: out.answerAge };
    return out;
  }

  /** A new reply, carrying the model it runs on and what memory said about the same words. */
  fresh(thread, text, model = null) {
    const m = this.lastRecall && this.lastRecall.text === String(text).trim() && (this.lastRecall.answer || this.lastRecall.sources.length)
      ? { answer: this.lastRecall.answer, sources: this.lastRecall.sources, confidence: this.lastRecall.confidence, answerAge: this.lastRecall.answerAge } : null;
    return { ...st.reply(thread), model, memory: m };
  }

  /** The folder quick questions run in, made on first use. It holds nothing of the user's. */
  scratch() {
    const dir = path.join(this.home, "capsule", "ask");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * The turn a recalled answer came from, with its neighbours: anything Vyre tells the user, it
   * can show the source of (floor rule 7).
   * @param {{ session: string, seq?: number }} ref
   */
  async source(ref) {
    const r = await this.client.call("recall.thread", { session: ref.session, from: Math.max(0, (ref.seq || 0) - 1), limit: 3 });
    if (r.error) return { error: explain(r.error) };
    const s = r.data.session || {};
    return { name: s.name || s.title || String(ref.session).slice(0, 8), cwd: s.cwd || null, seq: ref.seq ?? null,
      turns: (r.data.turns || []).map(x => ({ seq: x.seq, role: x.role, text: String(x.text || "").slice(0, 1200), age: route.age(x.ts, this.now()) })) };
  }

  /**
   * Send, to exactly the destination the Capsule showed. Returns the thread the reply will
   * stream from, or an error in words. `take` takes the keyboard from whoever holds it, and is only ever the user's choice.
   * @param {route.Destination} d @param {string} text @param {{ take?: boolean }} [opts]
   */
  async send(d, text, opts = {}) {
    // Words sent into the open DM show in it at once, pending until thread.sent says they arrived.
    const key = this.dmPend(d, text);
    const r = await this.sendTo(d, text, opts);
    if (key && this.chat) {
      if (r.error) this.chat = st.dmDrop(this.chat, key);
      else if (r.thread && !this.chat.thread && !this.dmBuffer) this.chat = { ...this.chat, thread: String(r.thread) };
      this.emit("change");
    }
    return r;
  }

  /** @param {route.Destination} d @param {string} text @param {{ take?: boolean }} [opts] */
  async sendTo(d, text, { take = false } = {}) {
    this.reap = false;
    this.cancelWanted = false;
    if (d.kind === "quick") return this.ask(d, text);
    if (d.kind === "recall") return { error: "Nothing to send to: there is no assistant on this vyred yet. Memory has answered what it can." };
    if (d.kind === "assistant" || d.kind === "agent") {
      // wait:false returns once the words are in the agent's thread, and the reply follows on the
      // stream. Waiting for the answer would hold the call for up to ten minutes. The first
      // thread.sent from this surface names the thread if the stream beats the call's answer.
      // agents.ask has no take: the keyboard of the agent's current thread is taken first, and
      // only when the user chose to.
      const current = ((this.catalog.agents || []).find(a => a.name === d.agent) || {}).thread;
      if (take && current) {
        const l = await this.client.call("threads.lease", { thread: current, surface: "capsule" });
        if (l.error) return { error: explain(l.error) };
      }
      this.reply = this.fresh("", text);
      this.pending = true;
      this.emit("change");
      const r = await this.client.call("agents.ask", { agent: d.agent, text, surface: "capsule", wait: false });
      this.pending = false;
      const x = (r && r.data) || {};
      if (r.error || x.ok === false) {
        this.reply = null;
        this.emit("change");
        if (r.error) return { error: explain(r.error) };
        // Refused by the lease: agents.ask says so in a note, and threads.get says who holds it.
        const holder = x.thread ? await this.holder(String(x.thread)) : null;
        if (holder && holder !== "capsule") return { error: `${holder} has the keyboard in ${d.agent}'s thread.`, holder };
        return { error: x.note || `${d.agent} did not get it.` };
      }
      const thread = String(x.thread || (this.reply && this.reply.thread) || "");
      if (this.reply && !this.reply.thread) this.reply = { ...this.reply, thread };
      // agents.ask with wait:false keeps the keyboard; it goes back when the Capsule closes.
      if (thread) this.lease = thread;
      this.emit("change");
      if (this.cancelWanted && thread) await this.stopThread(thread);
      return { thread };
    }
    let r;
    if (d.kind === "new-thread") {
      // threads.start answers after the first words are typed, so the reply may already be
      // streaming: its thread.sent names the thread.
      this.reply = this.fresh("", text);
      this.pending = true;
      this.emit("change");
      r = await this.client.call("threads.start", { project: d.project || undefined, cwd: d.cwd || undefined, prompt: text, surface: "capsule" });
      this.pending = false;
      if (r.error) { this.reply = null; this.emit("change"); return { error: explain(r.error) }; }
      const thread = String(r.data.id);
      // The surface that starts a thread holds its keyboard; it goes back when the Capsule closes.
      this.lease = thread;
      if (this.reply && !this.reply.thread) this.reply = { ...this.reply, thread };
      this.emit("change");
      return { thread };
    } else {
      // One keyboard per thread (floor rule 4). A free thread is taken by typing into it; one
      // someone else holds is theirs until the user chooses to take it.
      if (take) {
        const l = await this.client.call("threads.lease", { thread: d.thread, surface: "capsule" });
        if (l.error) return { error: explain(l.error) };
      }
      // The reply is listened for before the words go: the child can answer before the call does.
      const before = this.reply;
      this.reply = this.fresh(String(d.thread), text, this.quick.get(String(d.thread)) || null);
      r = await this.client.call("threads.send", { thread: d.thread, text, surface: "capsule" });
      // Busy in a terminal: the words wait for its turn to end (the Harness hands them over at
      // Stop), and its reply comes back on this thread like any other.
      if (!r.error && r.data && r.data.queued) {
        this.reply = { ...this.reply, queued: { name: String(r.data.name || d.threadLabel || "The session"), delivered: false } };
        this.emit("change");
        return { thread: String(d.thread), queued: true, note: r.data.note || null };
      }
      if (r.error || (r.data && r.data.sent === false)) this.reply = before;
      if (!r.error && r.data && r.data.sent === false) {
        // {sent:false, holder, note}; the note names a tool, so the Capsule says it in words.
        const holder = r.data.holder || null;
        return { error: holder ? `${holder} has the keyboard in this thread.` : r.data.note || "This thread could not be typed into.", holder };
      }
      if (!r.error) this.lease = String(d.thread);
      if (!r.error && this.quick.has(String(d.thread))) this.running.add(String(d.thread));
    }
    if (r.error) return { error: explain(r.error) };
    const thread = String((r.data && r.data.thread) || d.thread);
    this.emit("change");
    return { thread };
  }

  /**
   * A question straight to a model, in a thread of its own: Claude Code on `d.model`, in the
   * Capsule's scratch folder, so it starts with no project and none of the user's files around it.
   * The reply streams like any thread's; a follow-up is a {kind: "thread"} send to the same thread.
   * @param {route.Destination} d @param {string} text
   */
  async ask(d, text) {
    const model = d.model || "haiku";
    let cwd;
    try { cwd = this.scratch(); } catch (e) { return { error: `Could not make the Capsule's folder: ${/** @type {Error} */ (e).message}` }; }
    this.reply = this.fresh("", text, model);
    this.pending = true;
    this.emit("change");
    // Lean: no plugin, no tools, no MCP servers, no settings. A question needs none of them, and
    // they were most of what an answer cost (switchboard measured $0.027 against $0.013 lean).
    // What memory showed for these words goes with it, so "which car do I own" is answered from
    // the user's own notes rather than a shrug.
    const r = await this.client.call("threads.start", { prompt: String(text).trim(), append: quickAppend(this.reply && this.reply.memory), lean: true, model, cwd, surface: "capsule",
      name: "Capsule: " + String(text).trim().replace(/\s+/g, " ").slice(0, 40) });
    this.pending = false;
    if (r.error) { this.reply = null; this.emit("change"); return { error: explain(r.error) }; }
    const thread = String(r.data.id);
    this.quick.set(thread, model);
    this.running.add(thread);
    this.lease = thread;
    if (this.reply && !this.reply.thread) this.reply = { ...this.reply, thread };
    this.emit("change");
    if (this.cancelWanted) await this.stopThread(thread);
    return { thread };
  }

  /**
   * Stop the reply streaming now. A thread is stopped with threads.stop (its transcript stays, and
   * the next send resumes it); for the assistant or an agent that stops their thread's process
   * too, which is the only interrupt the switchboard offers. Without threads.stop the Capsule only
   * stops following, and says so. Either way the reply is finished with the error "stopped".
   */
  async cancel() {
    const r = this.reply;
    if (!r || r.finished) return { ok: false, note: "Nothing is answering now." };
    this.reply = st.cancel(r);
    this.emit("change");
    if (!r.thread) { this.cancelWanted = true; return { ok: true, stopped: false, note: "Stopped. The thread is stopped as soon as it is known." }; }
    return this.stopThread(r.thread);
  }

  /** threads.stop, marking the stop as ours so its thread.stopped is not read as a failure. */
  async stopThread(thread) {
    this.cancelWanted = false;
    if (!this.has("threads.stop")) return { ok: true, stopped: false, note: "Stopped following. The reply carries on in its thread; this vyred cannot stop it from here." };
    this.stopping.add(thread);
    const s = await this.client.call("threads.stop", { thread });
    this.running.delete(thread);
    if (s.error) { this.stopping.delete(thread); return { ok: true, stopped: false, note: `Stopped following. ${explain(s.error)}` }; }
    const stopped = Boolean(s.data && s.data.stopped);
    if (!stopped) this.stopping.delete(thread);                          // it was not running: no thread.stopped will come
    return { ok: true, stopped };
  }

  /** Who holds a thread's keyboard now, or null. */
  async holder(thread) {
    if (!this.has("threads.get")) return null;
    const r = await this.client.call("threads.get", { thread, limit: 1 });
    return (r.data && r.data.thread && r.data.thread.holder) || null;
  }

  /**
   * The Capsule closed: hand the keyboard back, and stop the quick threads it started, so no
   * Claude Code process idles while it is hidden. One still answering finishes its turn first
   * (onEvent stops it then). A follow-up later resumes the thread from its transcript.
   */
  async releaseLease() {
    if (this.lease && this.has("threads.release")) {
      const thread = this.lease; this.lease = null;
      await this.client.call("threads.release", { thread, surface: "capsule" });
    }
    this.reap = true;
    const busy = this.reply && !this.reply.finished ? this.reply.thread : null;
    await Promise.all([...this.running].filter(t => t !== busy).map(t => this.stopThread(t)));
  }

  /**
   * Everything waiting now. Gate holds come from gate.held. Open questions come from
   * threads.asks when the switchboard offers it, and otherwise from the event log: asks raised
   * and not yet answered. A Capsule that was closed must still see a question raised meanwhile,
   * which is why this is not the live stream alone.
   */
  async loadWaiting() {
    const rows = [];
    if (this.has("gate.held")) {
      const g = await this.client.call("gate.held");
      for (const h of g.data ? (Array.isArray(g.data) ? g.data : g.data.held || []) : []) rows.push(st.fromHeld(h));
    }
    if (this.has("threads.asks")) {
      const a = await this.client.call("threads.asks");
      for (const x of a.data ? (Array.isArray(a.data) ? a.data : a.data.asks || []) : []) {
        // Only questions still open; an answered one stays in the table with its decision.
        if (x.decision || (x.state && !["open", "pending", "waiting"].includes(x.state))) continue;
        // threads.asks rows are {id, thread, tool, summary, destination, reason, at, state}: no
        // project and no agent, so both come from the thread as the catalog knows it.
        const t = (this.catalog.threads || []).find(y => y.id === x.thread);
        rows.push(st.fromAsk({ type: "ask.raised", at: x.at, thread: x.thread, project: x.project || (t && t.project) || null,
          payload: { ...x, agent: x.agent || this.who(x.thread) } }, s => this.projectName(s)));
      }
    } else {
      const raised = await this.client.get("/v1/events?type=ask.raised&limit=1000");
      const answered = await this.client.get("/v1/events?type=ask.answered&limit=1000");
      const done = new Set(((answered.data) || []).map(e => String((e.payload || {}).ask || (e.payload || {}).id)));
      for (const e of raised.data || []) if (!done.has(String((e.payload || {}).ask || (e.payload || {}).id))) rows.push(st.fromAsk(this.named(e), s => this.projectName(s)));
    }
    // Lessons Vyre proposed and the user has not answered (core/learn). Quiet: they wait here and
    // never ask for attention. No learn module, no lessons, and nothing pretends otherwise.
    if (this.has("learn.lessons")) {
      const l = await this.client.call("learn.lessons", { status: "proposed" });
      for (const x of Array.isArray(l.data) ? l.data : []) if (x && (!x.status || x.status === "proposed")) rows.push(st.fromLesson(x, s => this.projectName(s)));
    }
    this.waiting = st.waiting(rows);
  }

  /**
   * The words of a hold, for the card. gate.held carries a summary only; gate.get has the draft
   * (for mail, `{subject, body}`) and where it is going. What was edited and failed to send is
   * `final`, which is what Send would send again.
   * @param {string} id
   */
  async held(id) {
    const r = await this.client.call("gate.get", { id });
    if (r.error) return { error: explain(r.error) };
    const g = r.data || {};
    const c = g.final || g.draft || {};
    const to = (Array.isArray(g.to) ? g.to : [g.to]).filter(Boolean).join(", ");
    // Mail reads as To, Subject and a body, each editable. Anything else (an http call) is shown
    // as the Gate summarised it and approved as it is.
    const mail = typeof c.subject === "string" || typeof c.body === "string";
    return { draft: mail ? { to, subject: s(c.subject), body: s(c.body) } : null, summary: g.summary || "",
      via: g.via || null, kind: g.kind || null, error: g.error || null };
  }

  /**
   * Answer a waiting item. Nothing is removed on optimism: the item goes when vyred says it was
   * answered (ask.answered, gate.approved, lesson.learned, lesson.retired), so a yes that never
   * arrived still shows as waiting.
   *
   * A proposed lesson is accepted (learn.accept) or declined (learn.retire). "allow" and "send"
   * mean accept, "deny" and "discard" decline, so the card's usual buttons work. Both are meant to
   * need a person's signed click (ADR 0004); a refusal for want of one is said in words and the
   * lesson stays waiting.
   * @param {st.Waiting} w @param {"allow"|"deny"|"send"|"discard"|"accept"|"decline"} decision
   * @param {{ to?: string[], subject?: string, body?: string }} [edited] what the user changed in a draft
   */
  async answer(w, decision, edited) {
    let r;
    if (w.source === "lesson") {
      const yes = decision === "accept" || decision === "allow" || decision === "send";
      const tool = yes ? "learn.accept" : "learn.retire";
      if (!this.has(tool)) return { error: "Lessons come from core/learn, which this vyred is not running." };
      r = await this.client.call(tool, { id: Number(w.id) });
      if (r.error) return { error: lessonRefused(r.error, yes, w.id) };
    } else if (w.source === "gate") {
      // `by` is left to the Gate: it records the caller, which is this surface.
      if (decision === "send" || decision === "allow") r = await this.client.call("gate.approve", { id: w.id, ...(edited ? { edited } : {}) });
      else r = await this.client.call("gate.reject", { id: w.id });
      // A send the user approved and the sender refused goes back to held with its error: say so,
      // and leave the card up so they can send it again.
      if (!r.error && r.data && r.data.state === "failed") return { error: `Not sent: ${r.data.error || "the sender failed"}. It is still held; Send tries again.` };
    } else {
      r = await this.client.call("threads.answer", { ask: w.id, decision: decision === "send" ? "allow" : decision === "discard" ? "deny" : decision, surface: "capsule" });
      if (!r.error && r.data && r.data.answered === false) return { error: r.data.note || "That question was already answered or withdrawn." };
    }
    if (r.error) return { error: explain(r.error) };
    // Some answers come back without an event (an older Gate); re-read so the list stays true.
    await this.loadWaiting();
    this.emit("change");
    return { ok: true };
  }

  /** A pending message in the open DM when these words go to it; its key, or null. */
  dmPend(d, text) {
    const c = this.chat;
    if (!c || !d) return null;
    const mine = ((d.kind === "assistant" || d.kind === "agent") && d.agent === c.agent) || (d.kind === "thread" && c.thread && d.thread === c.thread);
    if (!mine) return null;
    const key = `p${++this.pendingSeq}`;
    this.chat = st.dmPending(c, key, text, this.now());
    this.emit("change");
    return key;
  }

  /** An agent's name from what the user typed: "assistant" is whichever agent is the assistant. */
  agentRow(rows, agent) {
    return rows.find(x => x.name === agent) || (agent === "assistant" ? rows.find(x => x.kind === "assistant") : null) || null;
  }

  /** An open ask from the table as a waiting row, named like the global list's. */
  askRow(x, agent, project) {
    return st.fromAsk({ type: "ask.raised", at: x.at, thread: x.thread, project: project || null, payload: { ...x, agent } }, s => this.projectName(s));
  }

  /** The DM's state from vyred: the agent's current thread (agents.list), then its events (threads.get). */
  async loadDm(agent, limit) {
    if (!this.has("agents.list")) return { error: explain({ code: "no_such_tool", message: "no tool agents.list" }) };
    const list = await this.client.call("agents.list");
    if (list.error) return { error: explain(list.error) };
    const rows = Array.isArray(list.data) ? list.data : (list.data && list.data.agents) || [];
    const a = this.agentRow(rows, agent);
    if (!a) return { error: agent === "assistant" ? "There is no assistant on this vyred yet." : `There is no agent called ${agent}.` };
    const d = st.dm(a.name, a.thread || null, limit);
    if (!a.thread) return { dm: d };
    const r = await this.client.call("threads.get", { thread: a.thread, limit: 1000 });
    if (r.error) return { error: explain(r.error) };
    const project = r.data && r.data.thread ? r.data.thread.project : null;
    return { dm: st.dmHistory(d, r.data, x => this.askRow(x, a.name, project), s => this.projectName(s)) };
  }

  /**
   * A DM with an agent, read once: `{agent, thread, messages, asks, busy, holder}`, or `{error}`.
   * `agent` is a name, or "assistant". Nothing stays open; openDm is the live one.
   * @param {string} agent @param {{ limit?: number }} [opts]
   */
  async dm(agent, { limit = 30 } = {}) {
    const r = await this.loadDm(String(agent || ""), limit);
    return r.error ? { error: r.error } : st.dmView(/** @type {st.Dm} */ (r.dm));
  }

  /**
   * Open a DM: its history now, then every event of its thread folded in until closeDm. The
   * snapshot carries it as `dm`. Opening another DM replaces this one.
   * @param {string} agent @param {{ limit?: number }} [opts]
   */
  async openDm(agent, { limit = 30 } = {}) {
    const seq = ++this.dmSeq;
    const name = String(agent || "");
    const known = this.agentRow(this.catalog.agents || [], name);
    const after = this.lastEvent;
    this.chat = { ...st.dm(known ? known.name : name, known ? known.thread : null, limit), loading: true };
    this.dmBuffer = [];
    this.emit("change");
    const r = await this.loadDm(name, limit);
    if (seq !== this.dmSeq) return { error: "closed" };
    const heard = this.dmBuffer || [];
    const pending = (this.chat ? this.chat.messages : []).filter(m => m.pending);
    this.dmBuffer = null;
    if (r.error) { this.chat = null; this.emit("change"); return { error: r.error }; }
    let d = st.dmCarry(/** @type {st.Dm} */ (r.dm), pending, after);
    for (const e of heard) d = /** @type {st.Dm} */ (st.applyDm(d, e.type === "ask.raised" ? this.named(e) : e, s => this.projectName(s)));
    this.chat = d;
    this.emit("change");
    return st.dmView(d);
  }

  /** Close the DM: it is forgotten, and nothing more is folded or fetched for it. */
  closeDm() {
    this.dmSeq++;
    const was = this.chat;
    this.chat = null;
    this.dmBuffer = null;
    if (was) this.emit("change");
    return { ok: true };
  }

  /** An ask.raised event with who is asking filled in. */
  named(e) {
    const p = e.payload || {};
    if (p.agent) return e;
    const thread = e.thread || p.thread;
    // A thread started since the catalog was read: the open DM knows whose it is.
    const agent = this.who(thread) || (this.chat && thread && this.chat.thread === String(thread) ? this.chat.agent : null);
    return { ...e, payload: { ...p, agent } };
  }

  /** One event from the stream. */
  onEvent(e) {
    if (typeof e.id === "number" && e.id > this.lastEvent) this.lastEvent = e.id;
    // The open DM: held back while its history loads, folded in after.
    let dmChanged = false;
    if (this.chat && this.dmBuffer) this.dmBuffer.push(e);
    else if (this.chat) {
      const next = st.applyDm(this.chat, e.type === "ask.raised" ? this.named(e) : e, s => this.projectName(s));
      dmChanged = next !== this.chat && dmVisible(this.chat, next);
      this.chat = next;
    }
    // An agent's reply whose thread was not known when it was sent: the first sign of it on the
    // stream names it. A thread this Capsule typed into, or one started for that agent.
    if (this.pending && this.reply && !this.reply.thread && e.thread && e.type === "thread.sent" && (e.payload || {}).surface === "capsule") {
      this.reply = { ...this.reply, thread: String(e.thread) };
      this.pending = false;
    }
    const w = st.applyWaiting(this.waiting, e.type === "ask.raised" ? this.named(e) : e, s => this.projectName(s));
    // A thread this Capsule stopped (Stop, or closing) has not failed; its reply stands as it was.
    const ours = e.type === "thread.stopped" && this.stopping.delete(String(e.thread));
    if (e.type === "thread.stopped") this.running.delete(String(e.thread));
    const r = this.reply && !ours ? st.applyReply(this.reply, e) : this.reply;
    // Closed while it answered: now that the turn is done, nothing of it runs while hidden.
    if (e.type === "thread.finished" && this.reap && this.running.has(String(e.thread))) this.stopThread(String(e.thread)).catch(() => {});
    const changed = w !== this.waiting || r !== this.reply || dmChanged;
    this.waiting = w;
    this.reply = r;
    if (changed) this.emit("change");
    if (e.type === "ask.raised" || e.type === "gate.held") this.emit("attention", e);
    if (/^(project|thread)\.(created|changed|picked|unpicked|started)$/.test(e.type) || e.type === "agent.created") this.emit("stale");
  }

  /** What the window is handed: everything it paints, and nothing it could act on without asking. */
  snapshot() {
    return {
      up: this.up,
      has: { agents: this.has("agents.list"), threads: this.has("threads.send"), gate: this.has("gate.held"), recall: this.has("recall.search"),
        quick: this.has("threads.start"), stop: this.has("threads.stop") },
      assistant: ((this.catalog.agents || []).find(a => a.kind === "assistant") || {}).name || null,
      waiting: this.waiting.map(w => ({ ...w, age: route.age(w.at, this.now()) })),
      // What counts toward the Beacon dot and the tray badge: proposed lessons are quiet.
      waitingLoud: st.loud(this.waiting),
      reply: this.reply ? { thread: this.reply.thread, text: st.replyText(this.reply), tools: this.reply.tools, finished: this.reply.finished,
        ok: this.reply.ok, error: this.reply.error, lease: this.reply.lease, model: this.reply.model || null, notice: this.reply.notice || null,
        queued: this.reply.queued || null,
        cost: this.reply.cost, ms: this.reply.ms,
        memory: this.reply.memory ? { ...this.reply.memory, memo: memoItems(this.reply.memory) } : null } : null,
      dm: this.chat ? st.dmView(this.chat) : null,
    };
  }
}

/** Whether a fold changed anything the page draws (not only the event cursor). */
const dmVisible = (a, b) => a.messages !== b.messages || a.asks !== b.asks || a.busy !== b.busy || a.holder !== b.holder || a.thread !== b.thread;

/** A fact's confidence as 0..1, or null when memory gave none. */
const confidenceOf = x => (typeof x.confidence === "number" && Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : null);

/**
 * Why accepting or declining a lesson did not happen, in words. learn.accept and learn.retire are
 * meant to need presence, a signed proof that a person clicked (ADR 0004); a refusal for want of
 * it says where the click can be made instead.
 */
function lessonRefused(err, yes, id) {
  const m = String((err && err.message) || "");
  if (/presence|signed|passkey|person/i.test(m) || (err && err.code === "presence")) {
    return `Vyre needs proof that a person ${yes ? "accepted" : "declined"} this, which the Capsule cannot give yet. Do it in the Deck, or with vyre learn ${yes ? "accept" : "retire"} ${id}. It is still waiting.`;
  }
  return explain(err);
}

/** The tool a destination needs. */
function needs(d) {
  if (d.kind === "assistant" || d.kind === "agent") return "agents.ask";
  if (d.kind === "new-thread" || d.kind === "quick") return "threads.start";
  if (d.kind === "thread") return "threads.send";
  return null;
}

/** The words a quick question is sent as: the user's own, then how to answer. */
export const QUICK_APPEND = "Answer briefly, in markdown. You have no tools here; if the question needs the user's files or accounts, say so in one line.";

/** "2 weeks ago", "just now", or "" for an age route.age or Memory gave. */
export const ago = age => (!age ? "" : age === "now" ? "just now" : `${age} ago`);

/**
 * What a memory box shows, line by line: the distilled fact first (when memory.relevant has one),
 * then each source on screen, a fact as itself and a transcript quote as who said it and when.
 * The page draws these items and quickAppend sends these same items, so what the model is told
 * is exactly what the user can see, and no more.
 * @param {{ answer: string|null, answerAge?: string|null, confidence?: number|null, sources: any[] }|null|undefined} m
 * @returns {{ kind: "fact"|"quote", text: string, age: string, who?: "You"|"Claude", confidence?: number|null, source: any }[]}
 */
export function memoItems(m) {
  if (!m) return [];
  const out = [];
  const srcs = (m.sources || []).slice(0, 3);
  if (m.answer) out.push({ kind: /** @type {const} */ ("fact"), text: m.answer, age: s(m.answerAge), confidence: m.confidence ?? null,
    source: srcs.find(x => x.kind !== "quote" && x.quote === m.answer) || null });
  for (const x of srcs) {
    if (x.kind === "quote") out.push({ kind: /** @type {const} */ ("quote"), who: x.role === "assistant" ? "Claude" : "You", text: s(x.quote), age: s(x.age), source: x });
    else if (x.quote && x.quote !== m.answer) out.push({ kind: /** @type {const} */ ("fact"), text: s(x.quote), age: s(x.age), confidence: x.confidence ?? null, source: x });
  }
  return /** @type {any} */ (out);
}

/** The memory items as the model reads them, one line each. @param {Parameters<typeof memoItems>[0]} m */
export function memoLines(m) {
  return memoItems(m).map(x => x.kind === "quote"
    ? `${x.who === "Claude" ? "Claude said" : "The user said"}${x.age ? `, ${ago(x.age)}` : ""}: "${x.text}"`
    : `${x.text}${x.age ? ` (noted ${ago(x.age)})` : ""}`);
}

/**
 * QUICK_APPEND, then what the user's own notes say about the question, when memory showed any.
 * Only the lines on screen go (memoItems of the reply's memory); nothing else is read for it.
 * @param {{ answer: string|null, answerAge?: string|null, sources: any[] }|null|undefined} m
 */
export function quickAppend(m) {
  const lines = memoLines(m);
  if (!lines.length) return QUICK_APPEND;
  return `${QUICK_APPEND}\n\nWhat the user's own notes say:\n${lines.map(l => `- ${l}`).join("\n")}\n\n` +
    `If these answer the question, answer from them and say when the user said it, like "a Honda Civic (you said so 2 weeks ago)". They may be old or partial; say so if it matters.`;
}

/** vyred's home from its socket, when the socket sits in it (config/socketPath: <home>/vyred.sock). */
const homeOf = socket => (socket && path.basename(socket) === "vyred.sock" ? path.dirname(socket) : null);

const folderOf = cwd => (cwd ? String(cwd).split("/").filter(Boolean).pop() || null : null);

/** Recall marks matches «like this»; the Capsule shows plain words. */
const plain = s => String(s || "").replace(/[«»]/g, "");
