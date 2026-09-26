// @ts-check
// bridge — everything the Capsule asks of vyred, in one place, in the main process.
//
// The window never talks to vyred. It asks this over IPC, and this asks vyred's API over the
// socket: the same tools the CLI, the Deck and Claude use (spec 9, "none reads the store
// directly"). That keeps the renderer sandboxed with no Node and no socket, and it means there
// is one copy of what is true (the waiting list, the reply streaming in) that any window, shown
// or re-shown, is handed whole.
//
// The switchboard (agents.*, threads.*) and the Gate (gate.*) are being built alongside this.
// Which of their tools exist is read from GET /v1/tools, and every feature that needs a missing
// one says so in words, rather than failing a call and showing nothing.

import { EventEmitter } from "node:events";
import * as route from "./route.js";
import * as st from "./state.js";

/** @typedef {{ call: (tool: string, input?: any, opts?: any) => Promise<any>, get: (route: string, opts?: any) => Promise<any> }} Client */

const MISSING = {
  agents: "The assistant and agents come with the switchboard, which this vyred is not running yet.",
  threads: "Driving a session needs the switchboard, which this vyred is not running yet.",
  gate: "Holds come from the Gate, which this vyred is not running yet.",
};

/** Words for an error, for the one line the Capsule shows. */
export function explain(err) {
  if (!err) return "";
  if (err.code === "unreachable") return "vyred is not running. Start it with vyre up.";
  if (err.code === "no_such_tool") {
    const mod = /no tool (\w+)\./.exec(err.message || "");
    return (mod && MISSING[mod[1]]) || err.message;
  }
  if (err.code === "denied") return `The rules stopped it: ${err.message}`;
  return err.message || err.code;
}

export class Bridge extends EventEmitter {
  /** @param {Client} client */
  constructor(client, { now = () => Date.now() } = {}) {
    super();
    this.client = client;
    this.now = now;
    /** @type {Set<string>} */
    this.tools = new Set();
    /** @type {route.Catalog} */
    this.catalog = { agents: null, projects: [], threads: [] };
    /** @type {st.Waiting[]} */
    this.waiting = [];
    /** @type {st.Reply|null} */
    this.reply = null;
    this.up = false;
    this.lease = /** @type {string|null} */ (null);
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
    const [agents, projects, recent] = await Promise.all([
      this.has("agents.list") ? this.client.call("agents.list") : null,
      this.client.call("projects.list"),
      this.client.call("projects.catalog", { limit: 30, human: true }),
    ]);
    const list = (projects && projects.data && projects.data.projects) || [];
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
    for (const x of (recent && recent.data && recent.data.sessions) || []) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      threads.push({ id: x.id, label: x.label || x.name || x.title || x.id.slice(0, 8), cwd: x.cwd, last: x.last, project: null, projectName: null });
    }
    const agentRows = agents && agents.data ? (Array.isArray(agents.data) ? agents.data : agents.data.agents || []) : null;
    this.catalog = {
      agents: agentRows ? agentRows.map(a => ({ name: String(a.name), kind: a.kind, doing: a.doing || a.status || null })) : null,
      projects: list.map(p => ({ slug: p.slug, name: p.name, org: p.org, home: p.home, threads: p.threads, last: p.last })),
      threads,
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
      agentThreads = rows.map(x => ({ id: x.id || x.thread, label: x.label || x.name || x.title || String(x.id || x.thread).slice(0, 8),
        last: x.last || x.at, project: x.project || null, projectName: x.projectName || x.project_name || null, agent: target.id }));
    }
    const r = route.destinations(target, text, this.catalog, { agentThreads, now: this.now() });
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
    return {
      ms: Math.max(1, this.now() - t0),
      answer: f[0] ? f[0].text : null,
      more: f.slice(1).map(x => x.text),
      sources: [
        ...f.filter(x => x.ref).map(x => ({ session: x.ref.session, seq: x.ref.seq, name: x.ref.name || x.source, quote: x.text, age: x.age || "" })),
        ...h.map(x => ({ session: x.session, seq: x.seq, name: x.name || x.title || x.session.slice(0, 8), quote: plain(x.snippet || x.text), age: route.age(x.ts, this.now()) })),
      ].filter((x, i, all) => all.findIndex(y => y.session === x.session) === i).slice(0, 3),
      error: facts.error && hits.error ? explain(hits.error) : null,
    };
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
   * Send, to exactly the destination the Capsule showed. Returns the thread the reply will stream
   * from, or an error in words.
   * @param {route.Destination} d @param {string} text
   */
  async send(d, text) {
    if (d.kind === "recall") return { error: "Nothing to send to: there is no assistant on this vyred yet. Memory has answered what it can." };
    let r;
    if (d.kind === "assistant" || d.kind === "agent") r = await this.client.call("agents.ask", { agent: d.agent, text, ...(d.kind === "agent" && d.fresh ? { new: true } : {}) });
    else if (d.kind === "new-thread") r = await this.client.call("threads.start", { project: d.project || undefined, cwd: d.cwd || undefined, prompt: text });
    else {
      // One keyboard per thread (floor rule 4). Take it before typing into the thread, and say
      // who has it if someone else does, rather than typing over them.
      const lease = await this.takeLease(d.thread || "");
      if (lease.error) return lease;
      r = await this.client.call("threads.send", { thread: d.thread, text });
    }
    if (r.error) return { error: explain(r.error) };
    const thread = String((r.data && (r.data.thread || r.data.id || r.data.session)) || d.thread || "");
    this.reply = thread ? st.reply(thread) : null;
    this.emit("change");
    return { thread };
  }

  /** @param {string} thread */
  async takeLease(thread) {
    if (!this.has("threads.lease")) return { error: explain({ code: "no_such_tool", message: "no tool threads.lease" }) };
    const r = await this.client.call("threads.lease", { thread, surface: "capsule" });
    if (r.error) return { error: explain(r.error) };
    const holder = r.data && (r.data.holder || r.data.surface);
    if (holder && holder !== "capsule") return { error: `${holder} has the keyboard in this thread. It is read only here until they hand it back.` };
    this.lease = thread;
    return { ok: true };
  }

  /** Hand the keyboard back when the Capsule closes. */
  async releaseLease() {
    if (!this.lease || !this.has("threads.release")) return;
    const thread = this.lease; this.lease = null;
    await this.client.call("threads.release", { thread, surface: "capsule" });
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
      for (const x of a.data ? (Array.isArray(a.data) ? a.data : a.data.asks || []) : []) rows.push(st.fromAsk({ type: "ask.raised", at: x.at, thread: x.thread, project: x.project, payload: x }, s => this.projectName(s)));
    } else {
      const raised = await this.client.get("/v1/events?type=ask.raised&limit=1000");
      const answered = await this.client.get("/v1/events?type=ask.answered&limit=1000");
      const done = new Set(((answered.data) || []).map(e => String((e.payload || {}).ask || (e.payload || {}).id)));
      for (const e of raised.data || []) if (!done.has(String((e.payload || {}).ask || (e.payload || {}).id))) rows.push(st.fromAsk(e, s => this.projectName(s)));
    }
    this.waiting = st.waiting(rows);
  }

  /**
   * Answer a waiting item. Nothing is removed on optimism: the item goes when vyred says it was
   * answered (ask.answered, gate.approved), so a yes that never arrived still shows as waiting.
   * @param {st.Waiting} w @param {"allow"|"deny"|"send"|"discard"} decision @param {string} [text] an edited draft
   */
  async answer(w, decision, text) {
    let r;
    if (w.source === "gate") {
      if (decision === "send" || decision === "allow") r = await this.client.call("gate.approve", { id: w.id, ...(text ? { text } : {}) });
      else r = await this.client.call("gate.reject", { id: w.id });
    } else {
      r = await this.client.call("threads.answer", { ask: w.id, decision: decision === "send" ? "allow" : decision === "discard" ? "deny" : decision });
    }
    if (r.error) return { error: explain(r.error) };
    // Some answers come back without an event (an older Gate); re-read so the list stays true.
    await this.loadWaiting();
    this.emit("change");
    return { ok: true };
  }

  /** One event from the stream. */
  onEvent(e) {
    const w = st.applyWaiting(this.waiting, e, s => this.projectName(s));
    const r = this.reply ? st.applyReply(this.reply, e) : null;
    const changed = w !== this.waiting || r !== this.reply;
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
      has: { agents: this.has("agents.list"), threads: this.has("threads.send"), gate: this.has("gate.held"), recall: this.has("recall.search") },
      assistant: ((this.catalog.agents || []).find(a => a.kind === "assistant") || {}).name || null,
      waiting: this.waiting.map(w => ({ ...w, age: route.age(w.at, this.now()) })),
      reply: this.reply ? { thread: this.reply.thread, text: st.replyText(this.reply), tools: this.reply.tools, finished: this.reply.finished, ok: this.reply.ok, error: this.reply.error, lease: this.reply.lease } : null,
    };
  }
}

/** The tool a destination needs. */
function needs(d) {
  if (d.kind === "assistant" || d.kind === "agent") return "agents.ask";
  if (d.kind === "new-thread") return "threads.start";
  if (d.kind === "thread") return "threads.send";
  return null;
}

/** Recall marks matches «like this»; the Capsule shows plain words. */
const plain = s => String(s || "").replace(/[«»]/g, "");
