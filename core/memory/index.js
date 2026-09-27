// @ts-check
// memory — the graph and the curator, as a module (docs/SPEC.md, section 7.4).
//
// The curator runs in the background: once on start for anything not yet read, and again
// shortly after Recall says a session was indexed. Start never waits for it, so a first run
// over a large history does not hold up vyred. Without Recall's tables there is nothing to
// read; every tool still answers, with nothing.

import { Curator } from "./curator.js";
import { Graph, say } from "./graph.js";
import { floorPlan } from "./floor.js";
import fs from "node:fs";
import path from "node:path";
import { within } from "./teach.js";
import { Personal } from "./personal/store.js";
import { answerer } from "./personal/answer.js";
import { profile } from "./personal/profile.js";
import { createReader, claudeOnce } from "./personal/reader.js";

/** How long to wait after a session.indexed event before curating, so a burst of turns is one pass. */
const SETTLE_MS = 250;
/** Turns the personal pass reads before it yields to the event loop. */
const PERSONAL_BATCH = 2000;

const cwds = { type: "array", items: { type: "string" } };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // config.memory.relations: { prefers?, decided? } switches on the relations still under
    // evaluation (docs/adr/0007-intelligence.md, decision 2). Both are off by default.
    const curator = new Curator(ctx.store.db, { me: ctx.config.me, log: ctx.log, relations: ctx.config.memory?.relations });
    const graph = new Graph(ctx.store.db, curator);
    // Personal facts (docs/work/memory-iq.md): read after each curator pass, in batches that yield.
    const personal = new Personal(ctx.store.db, { log: ctx.log });
    /** Read every unread turn for personal facts, then derive if anything changed. */
    /** Names memory knew after the last pass: new ones send their older turns to the reader. */
    // Kept in memory_meta so a restart does not scan for every name again.
    const metaGet = ctx.store.db.prepare("SELECT v FROM memory_meta WHERE k = 'me_known'");
    const metaSet = ctx.store.db.prepare("INSERT OR REPLACE INTO memory_meta (k, v) VALUES ('me_known', ?)");
    let knownNames = new Set((() => { try { return JSON.parse(String(/** @type {any} */ (metaGet.get())?.v ?? "[]")); } catch { return []; } })());
    const personalPass = async ({ full = false } = {}) => {
      let turns = 0, claims = 0;
      while (!stopping) {
        const r = await personal.pass({ limit: PERSONAL_BATCH, stopped: () => stopping, full });
        full = false;
        turns += r.turns; claims += r.claims;
        if (!r.more) break;
        await new Promise(r => setImmediate(r));
      }
      const d = stopping ? { changed: false } : personal.derive();
      // A name just learned: the turns that mention it are read by the model too.
      if (!stopping) {
        const now = personal.known(), fresh = [...now].filter(w => !knownNames.has(w));
        knownNames = now;
        if (fresh.length) { personal.requeue(fresh); metaSet.run(JSON.stringify([...now])); }
      }
      // New user turns may wait for the reader: kept reads apply at once, the rest in a batch.
      if (turns && !stopping) { model.applyKept(); void model.pump(); }
      return { turns, claims, changed: d.changed };
    };
    // The fast model reads every user turn with a personal signal, once (personal/reader.js):
    // on events, at most a batch a minute, never while a user thread works, under a daily cap and
    // a one-time backfill allowance (config.memory.model). ctx.memoryRunner replaces `claude -p`
    // in tests and the evaluation; null there means reads are only replayed from what is kept.
    const jobs = () => {
      const root = ctx.paths && ctx.paths.root;
      if (!root) return null;
      const d = path.join(root, "memory-jobs");
      try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; } catch { return null; }
    };
    const model = createReader({
      db: ctx.store.db, personal, now: () => Date.now(), call: (tool, input) => ctx.call(tool, input), log: ctx.log, config: () => ctx.config,
      runner: ctx.memoryRunner !== undefined ? ctx.memoryRunner : jobs() ? claudeOnce({ cwd: /** @type {string} */ (jobs()) }) : null,
    });
    const modelOffs = [
      ctx.events.on("thread.stopped", () => void model.pump()),
      ctx.events.on("thread.finished", () => void model.pump()),
    ];
    let running = null, again = false, stopping = false, timer = null;
    // Rooms are stored, so a restart reuses the last list; they are read again from Projects on
    // the first pass and whenever a project or a pick changes.
    let roomsStale = true;

    /** One pass at a time. A request during a pass runs one more pass after it, not two. */
    const run = (opts = {}) => {
      if (running) { again = true; return running; }
      running = (async () => {
        let result;
        do {
          again = false;
          if (roomsStale) { roomsStale = false; await syncRooms().catch(e => ctx.log("could not read projects: " + e.message)); }
          result = await curator.curate({ ...opts, stopped: () => stopping });
          try { result.personal = await personalPass({ full: Boolean(opts.full) }); }
          catch (e) { ctx.log("personal facts failed: " + /** @type {Error} */ (e).message); }
          opts = {};
          if (result.changed) ctx.events.emit("memory.curated", { nodes: result.nodes, edges: result.edges, ms: result.ms, updated: curator.updated() });
        } while (again && !stopping);
        return result;
      })().finally(() => { running = null; });
      return running;
    };
    const soon = () => {
      if (stopping) return;
      clearTimeout(timer);
      timer = setTimeout(() => run().catch(e => ctx.log("curate failed: " + e.message)), SETTLE_MS);
      timer.unref?.();
    };

    // A rewritten transcript restarts its seq values, so everything read from it is dropped
    // before it is read again. A grown one only needs its new turns, which the cursor finds.
    const off = ctx.events.on("session.indexed", e => {
      const p = e.payload || {};
      if (p.rewritten && p.session) { curator.reset(String(p.session)); personal.reset(String(p.session)); }
      soon();
    });
    // A project made, changed or a thread picked changes the rooms.
    const offs = ["project.created", "project.changed", "thread.picked", "thread.unpicked"].map(type => ctx.events.on(type, () => { roomsStale = true; soon(); }));
    soon();

    // Projects, as the projects module knows them, for rooms and for an agent's grants. Memory
    // does not own projects; without the module there are simply no rooms. A project's picked
    // threads are its members too: projects.list gives their ids as picks (subagents already
    // folded to the parent); threads and picked there are counts. A list of ids under threads
    // is read as well, for callers that pass the room shape directly.
    const projectList = async () => {
      const r = await ctx.call("projects.list", {});
      if (r.error && r.error.code !== "no_such_tool") throw new Error(r.error.message);
      const list = r.error ? [] : (Array.isArray(r.data) ? r.data : r.data?.projects || []);
      const ids = p => (Array.isArray(p.picks) ? p.picks : Array.isArray(p.threads) ? p.threads : []).map(x => String(x && typeof x === "object" ? x.id : x));
      return list.filter(p => p && p.slug).map(p => ({ slug: String(p.slug), name: String(p.name || p.slug),
        folders: [...new Set([p.home, ...(p.workspaces || []), ...(p.folders || [])].filter(Boolean).map(String))], threads: ids(p) }));
    };
    /** Store the rooms. A change marks the curator dirty, so the pass that follows derives. */
    const syncRooms = async () => { curator.setRooms(await projectList()); };
    /**
     * What a caller may see. The user, from any surface or their own sessions, sees everything;
     * so does the assistant and an agent granted every project. Any other agent sees only its
     * projects' graphs, never the main graph (docs/SPEC.md, sections 7.4 and 10). When agents
     * cannot be checked, a named agent is refused rather than trusted.
     *
     * Who the agent is comes from the caller ("... agent:<name>", set by whatever runs the
     * agent) or from input.agent; if both are given they must agree. vyred lets a caller name an
     * agent only with the key of that agent's live thread, and inside an agent's thread the MCP
     * server and the hooks always name it ("mcp:agent:<name>", "harness:agent:<name>").
     */
    /** A refusal the caller can act on: vyred passes err.code through as the tool error's code. */
    const denied = message => Object.assign(new Error(message), { code: "denied" });
    const reach = async (agent, caller) => {
      const said = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(caller || ""))?.[1] || null;
      if (said && agent && said !== agent) throw denied(`the call came from agent ${said} but names agent ${agent}`);
      const who = said || agent || null;
      if (!who) return { all: true, agent: null, folders: [], slugs: new Set() };
      const r = await ctx.call("agents.list", {});
      if (r.error) throw new Error(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
      const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
      const a = list.find(x => x && x.name === who);
      if (!a) throw denied(`no agent ${who}`);
      if (a.kind === "assistant" || a.projects === "*") return { all: true, agent: who, folders: [], slugs: new Set() };
      const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
      const granted = (await projectList()).filter(p => mine.has(p.slug) || mine.has(p.name));
      return { all: false, agent: who, folders: granted.flatMap(p => p.folders), slugs: new Set(granted.map(p => p.slug)) };
    };
    const clean = cwds => (cwds || []).map(c => path.resolve(String(c)));
    /** The user's own surfaces. Only these, modules, and a verified all-projects agent read the main graph. */
    const OWNER = new Set(["deck", "cli", "local", "capsule"]);
    const owner = caller => OWNER.has(String(caller)) || String(caller).startsWith("module:");
    /**
     * The user on another of their devices: vyred's tailnet listener sets "tailnet:<login>" from
     * Tailscale's whois, and no caller can claim it. It reads as the owner does (graph, facts,
     * why, stats, corrections) but never corrects, merges or splits.
     */
    // An agent's own node ("tailnet:agent:<name>") is an agent, not the user on another device.
    const viaTailnet = caller => /^tailnet:(?!agent:)[^\s]+$/.test(String(caller || ""));
    const reader = caller => owner(caller) || viaTailnet(caller);
    /**
     * Throws unless the caller may read these folders' graph or this room (none: the main
     * graph). The main graph is for the user's own surfaces, modules, and the assistant or an
     * agent granted every project (docs/adr/0007-intelligence.md, decision 1): a session that
     * has not said who it is names its room or its project's folders. The unfiled room holds
     * whatever no project owns, so a named agent reads it only when granted every project.
     * An agent's grants are checked by project: a folder belongs to the most specific project
     * that holds it, so an agent granted ~/Work is not granted a project nested inside it.
     * @param {{ agent?: string, project_cwds?: string[], room?: string }} input
     * @param {{ whole?: boolean, tailnet?: boolean }} [opts]  whole: the call reads or steers everything by design;
     *   tailnet: a read the user's tailnet devices make as the owner
     */
    const guard = async ({ agent, project_cwds = [], room }, caller, { whole = false, tailnet = false } = {}) => {
      const r = await reach(agent, caller);
      const cwds = clean(project_cwds);
      const scoped = Boolean((room && room !== "*") || cwds.length);
      if (r.all) {
        if (!scoped && !whole && !r.agent && !(tailnet ? reader(caller) : owner(caller))) throw denied("the main graph is drawn for the Deck and the assistant; pass room (a project's slug, or unfiled) or project_cwds");
        return r;
      }
      if (room === "unfiled") throw denied(`the unfiled room is for the user and agents granted every project, not ${r.agent}`);
      if (!scoped) throw denied(`the main graph is for the assistant and agents granted every project; ask for one of ${r.agent}'s projects with room or project_cwds`);
      const sc = /** @type {{ room: string|null }} */ (graph.view(cwds, room && room !== "*" ? room : undefined));
      if (sc.room) {
        if (!r.slugs.has(sc.room)) throw denied(`${r.agent} is not granted ${sc.room}`);
        return r;
      }
      const outside = cwds.filter(c => !within(c, r.folders));
      if (outside.length) throw denied(`${r.agent} is not granted ${outside.join(", ")}`);
      return r;
    };
    const agentField = { agent: { type: "string" } };
    // A room by name: a project's slug, or "unfiled" for sessions in no project. project is the
    // same thing under the name the CLI's --project uses.
    const roomField = { room: { type: "string" }, project: { type: "string" } };
    /** The room an input names, if any. */
    const roomOf = input => input.room || input.project || undefined;

    ctx.tool("memory.graph", {
      description: "The graph as a floor plan for the Deck: one room per project, a shared room, nodes and edges, capped. project_cwds gives one project's graph; without it, the main graph (the assistant only). around/depth draw one node's neighbourhood. since returns { unchanged: true } when nothing moved.",
      input: { type: "object", properties: { project_cwds: cwds, ...roomField, around: { type: "string" }, depth: { type: "integer" }, limit: { type: "integer" }, since: { type: "integer" }, ...agentField } },
      run: async (input, { caller } = {}) => {
        input = { ...input, room: roomOf(input) };
        const r = await guard(input, caller, { tailnet: true });
        // The main graph is a drawing of every client at once. Beyond the rule above, only the
        // user's own surfaces (or a verified agent with every project) are given it: a session
        // that has not said who it is gets its project's graph, not everyone's.
        const main = !clean(input.project_cwds).length && (!input.room || input.room === "*" || input.room === "unfiled");
        if (main && !r.agent && !reader(caller)) {
          throw denied("the main graph is drawn for the Deck and the assistant; pass project_cwds for a project's graph");
        }
        const projects = await projectList();
        if (curator.setRooms(projects)) soon();
        return floorPlan(graph, { ...input, projects });
      },
    });
    ctx.tool("memory.facts", {
      description: "What memory holds: facts about one thing (about), about what a project's sessions name (project_cwds), or the most-seen outside parties. Each fact has its source turn, age and confidence. thread (a session id) gives the facts that thread's turns support instead, each with refs: [{seq}], the turns where it came up; with room, that project's facts, else the main graph's.",
      input: { type: "object", properties: { about: { type: "string" }, thread: { type: "string" }, project_cwds: cwds, ...roomField, limit: { type: "integer" }, ...agentField } },
      run: async ({ about, thread, project_cwds = [], limit, agent, ...rest }, { caller } = {}) => {
        const room = roomOf(rest);
        if (thread) {
          if (about || clean(project_cwds).length) throw new Error("thread is read on its own or with room, not with about or project_cwds");
          await guard({ agent, room }, caller, { tailnet: true });
          return graph.threadFacts({ thread, room, limit: Math.min(200, Math.max(1, limit ?? 50)) });
        }
        await guard({ agent, project_cwds, room }, caller, { tailnet: true });
        return graph.facts({ about, project_cwds, room, limit: Math.min(200, Math.max(1, limit ?? 20)) });
      },
    });
    ctx.tool("memory.relevant", {
      description: "The few facts worth adding to a prompt about this text, or [] when nothing in it is known. For the Enrich hook: precise, and fast.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, project_cwds: cwds, ...roomField, limit: { type: "integer" }, ...agentField } },
      // The owner on a phone reads it too: Find searches memory by meaning with it, account-wide,
      // as the Deck does on the Mac. A session still names its room.
      run: async ({ text, project_cwds = [], limit = 5, agent, ...rest }, { caller } = {}) => { const room = roomOf(rest); return (await guard({ agent, project_cwds, room }, caller, { tailnet: true }), graph.relevant({ text, project_cwds, room, limit: Math.min(20, Math.max(1, limit)) })); },
    });
    ctx.tool("memory.why", {
      description: "The turns that support a fact (its id, src|rel|dst) or where a thing came up (a name). Turns that no longer exist are counted as gone.",
      input: { type: "object", required: ["fact"], properties: { fact: { type: "string" }, limit: { type: "integer" }, project_cwds: cwds, ...roomField, ...agentField } },
      run: async ({ fact, limit = 10, project_cwds = [], agent, ...rest }, { caller } = {}) => { const room = roomOf(rest); return (await guard({ agent, project_cwds, room }, caller, { tailnet: true }), graph.why({ fact, project_cwds, room, limit: Math.min(50, Math.max(1, limit)) })); },
    });
    const steer = mode => ({
      description: mode === "pin"
        ? "Pin a node so it ranks first wherever it is relevant, everywhere (scope '*') or in one project folder. off: true unpins."
        : "Mute a node so memory never offers it, everywhere (scope '*') or in one project folder. off: true unmutes.",
      input: { type: "object", required: ["node"], properties: { node: { type: "string" }, scope: { type: "string" }, off: { type: "boolean" }, ...agentField } },
      run: async ({ node, scope = "*", off = false, agent }, { caller } = {}) => {
        // Steering everywhere is steering the main graph; steering one project needs that project,
        // and the node must be one its graph contains.
        const project_cwds = scope === "*" ? [] : [scope];
        const r = await guard({ agent, project_cwds }, caller, { whole: true });
        return graph.steer({ node, scope: scope === "*" ? "*" : clean([scope])[0], mode, off, who: r.agent ? `agent:${r.agent}` : caller || null, project_cwds: r.all ? [] : project_cwds });
      },
    });
    ctx.tool("memory.pin", steer("pin"));
    ctx.tool("memory.mute", steer("mute"));
    // What ctx.memory.teach(kind, fact) calls. Internal: only modules reach it, and the loader
    // has already checked that the kind is one the module declares under teaches.memory.
    ctx.tool("memory.teach", {
      internal: true,
      description: "A fact taught by another module, folded into the graph with that module as its source.",
      input: { type: "object", required: ["kind", "fact", "from"], properties: { kind: { type: "string" }, fact: { type: "object" }, from: { type: "string" } } },
      run: async ({ kind, fact, from }, { caller } = {}) => {
        // Provenance is who the loader says called, never what the input claims.
        if (caller !== `module:${from}`) throw new Error(`memory.teach from ${from} arrived as ${caller}`);
        const r = curator.teach(from, kind, fact);
        if (r.changed) soon();
        return r;
      },
    });
    // ---- the user's corrections (docs/adr/0007-intelligence.md, decision 4). Owner callers only:
    // a session never writes Memory; inside a turn Claude proposes a correction as a lesson.
    const OWNERS = ["deck", "cli", "local", "capsule"];
    /**
     * The registry reads "deck agent:kit" as a deck caller; for the user's own tools a caller
     * that names an agent is an agent, whatever surface carried it.
     * @param {(input: any, extra: { caller?: string }) => Promise<any>} run
     */
    const ownerOnly = run => async (input, extra = {}) => {
      if (/(?:^|[\s:])agent:/.test(String(extra.caller || ""))) throw denied("corrections are the user's: an agent proposes one as a lesson instead");
      return run(input, extra);
    };
    /** Writes: the registry's callers list, checked here too, so a tailnet caller never corrects. */
    const ownerWrite = run => ownerOnly(async (input, extra = {}) => {
      if (!owner(extra.caller)) throw denied(`corrections are made from the user's own surfaces, not ${plain(extra.caller || "an unnamed caller", 60)}`);
      return run(input, extra);
    });
    /** Reading corrections: the owner's surfaces, or the user on a tailnet device. Never an agent. */
    const readerOnly = (run, name = "memory.corrections") => ownerOnly(async (input, extra = {}) => {
      if (!reader(extra.caller)) throw denied(`${name} is for the user's own surfaces, not ${plain(extra.caller || "an unnamed caller", 60)}`);
      return run(input, extra);
    });
    /** The scope a correction applies in: a room's slug, or '*' for everywhere. */
    const scopeOf = input => {
      const room = roomOf(input);
      if (!room || room === "*") return { scope: "*", sc: null };
      return { scope: room, sc: graph.view([], room) };
    };
    /** When a thing stopped being true: ms, or a date the user typed. */
    const when = at => {
      if (at == null || at === "") return null;
      const ms = typeof at === "number" ? at : /^\d+$/.test(String(at)) ? Number(at) : Date.parse(String(at));
      if (!Number.isFinite(ms)) throw new Error(`at: ${JSON.stringify(at)} is not a date`);
      return ms;
    };
    /** Derive now, so what the user said shows in the next read. */
    const settle = async () => { if (running) await running.catch(() => {}); await run({ force: true }); };
    const corrected = (c, prior) => ctx.events.emit("memory.corrected", {
      // Ids, kinds and numbers only: no labels, node ids, addresses, notes or session ids.
      id: Number(c.id), action: String(c.action), rel: c.rel ?? null, scope: c.scope === "*" ? "all" : "project",
      prior_source: prior ? String(prior.origin || "extract") : null, prior_rule: prior?.rule ?? null,
      prior_confidence: prior ? Number(prior.confidence) : null,
    });
    // ---- presence (ADR 0004): what the user is asked to approve, one line of plain text. The
    // registry on main ignores the field today; security's enforces it. A summary never throws:
    // it reads labels from the main graph when it can, and falls back to what was typed.
    /** Plain text, one line, under 400 characters: no control characters, quotes kept simple. */
    const plain = (x, max = 120) => {
      const t = String(x ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
      return t.length > max ? t.slice(0, max - 3) + "..." : t;
    };
    /** A node's label from its id or name, else the text without its kind prefix ("title:cto" -> "cto"). */
    const labelOf = x => {
      const v = String(x ?? "");
      try { const n = graph.node(v) || graph.resolve(v); if (n) return String(n.label); } catch {}
      return v.replace(/^[a-z]+:/, "").replace(/#.*$/, "");
    };
    const where = input => { const room = roomOf(input); return room && room !== "*" ? `(in ${plain(room, 60)})` : "(everywhere)"; };
    const summary = fn => input => {
      let text;
      try { text = fn(input || {}); } catch { text = "a memory change"; }
      return plain(text, 399);
    };
    const factOf = input => {
      const [a, r, b] = input.fact ? String(input.fact).split("|") : [input.subject, input.rel, input.object];
      return `"${plain(say(String(r || "?"), plain(labelOf(a)), plain(labelOf(b))), 160)}"`;
    };
    const correctSummary = summary(input => {
      const f = factOf(input), w = where(input);
      switch (input.action) {
        case "wrong": return `Correct: ${f} is wrong ${w}`;
        case "ended": return `Correct: ${f} ended${input.at != null && input.at !== "" ? " " + plain(input.at, 40) : ""} ${w}`;
        case "replace": return `Correct: ${f} -> "${plain(input.object, 80)}" ${w}`;
        case "confirm": return `Confirm: ${f} ${w}`;
        case "add": return `Add: ${f} ${w}`;
        default: return `Correct: ${f} ${w}`;
      }
    });
    const mergeSummary = summary(input => `Merge: "${plain(labelOf(input.node), 80)}" into "${plain(labelOf(input.into), 80)}" (everywhere)`);
    const splitSummary = summary(input => input.other
      ? `Split: "${plain(labelOf(input.node), 80)}" and "${plain(labelOf(input.other), 80)}" are two (everywhere)`
      : `Split: "${plain(labelOf(input.node), 80)}" ${where(input)} is someone else`);

    ctx.tool("memory.correct", {
      callers: OWNERS,
      presence: { summary: correctSummary },
      description: "Correct a fact: wrong (never true), ended (stopped being true at `at`), replace (ended, and `object` is true instead), confirm (sure, no decay), add (a new fact). fact is src|rel|dst from memory.facts, or give subject, rel and object. room or project scopes it to one project; otherwise everywhere. Answers at once with the correction and pending: true, and memory.curated follows when the graph has it; wait: true answers after, with the fact as it now reads.",
      input: { type: "object", required: ["action"], properties: { fact: { type: "string" }, subject: { type: "string" }, rel: { type: "string" }, object: { type: "string" },
        action: { type: "string", enum: ["wrong", "ended", "replace", "confirm", "add"] }, at: {}, note: { type: "string" }, wait: { type: "boolean" }, ...roomField } },
      run: ownerWrite(async (input, { caller } = {}) => {
        const { scope, sc } = scopeOf(input);
        const t = graph.target(input, sc);
        const c = curator.correct({ action: input.action, src: t.src, rel: t.rel, dst: t.dst, object: t.object, at: when(input.at), scope, note: input.note ?? null, who: String(caller || "") });
        corrected(c, t.row);
        // Every room is derived again, which on a large history takes a while. The Deck does not
        // wait: memory.curated says when the graph has it. wait: true (the CLI) waits and
        // answers with the fact as it now reads.
        if (!input.wait) { run({ force: true }).catch(e => ctx.log("curate failed: " + e.message)); return { correction: c, pending: true }; }
        await settle();
        return { correction: c, facts: graph.facts({ about: t.src, room: sc?.room ?? undefined, limit: 20 }).facts.filter(f => f.rel === t.rel) };
      }),
    });
    // No callers list: the registry compares the whole "tailnet:<login>" string, so readerOnly
    // checks the owner surfaces and tailnet callers itself.
    ctx.tool("memory.corrections", {
      description: "What the user has corrected, merged or split, newest first. room or project: that project's and the ones for everywhere. all: include undone ones.",
      input: { type: "object", properties: { all: { type: "boolean" }, ...roomField } },
      run: readerOnly(async input => curator.corrections({ scope: roomOf(input), all: Boolean(input.all) })),
    });
    // Personal facts are the user's, not a project's: owner surfaces and the user's tailnet
    // devices read them; agents never do.
    ctx.tool("memory.me", {
      description: "What memory knows about the user and the people and things in their life: facts like \"your wife is Jordan\", each with confidence, how many conversations said it and whether it still holds. about names one of them (\"my wife\", \"Jordan\", \"car\"); without it, the strongest facts.",
      input: { type: "object", properties: { about: { type: "string" }, limit: { type: "integer" } } },
      run: readerOnly(async ({ about, limit }) => {
        const n = Math.min(200, Math.max(1, limit ?? 50));
        if (about) {
          const a = personal.about(String(about));
          return { about: a ? { ...a.entity, aliases: a.aliases } : null, facts: a ? [...a.links, ...a.facts].slice(0, n) : [] };
        }
        return { about: null, facts: personal.facts({ limit: n }) };
      }, "memory.me"),
    });
    // One line about the user's life from what they have said (docs/work/memory-iq.md). Personal
    // facts are the user's, not a project's: the user's surfaces, their tailnet devices, modules,
    // and the assistant or an agent granted every project ask it; a project's agent is refused.
    /**
     * Personal facts are the user's, not a project's: the user's surfaces, their tailnet devices,
     * modules, and the assistant or an agent granted every project. A project's agent is refused.
     */
    // A bare "mcp" caller is the user's own Claude Code session, and "mcp:thread:<id>" a session
    // Vyre runs for the user (ADR 0030; an agent's says mcp:agent:<name>), so both ask about the
    // user's life as the user's surfaces do.
    const ownSession = caller => /^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(String(caller));
    const personalOnly = async (input, caller, name) => {
      const r = await reach(input.agent, caller);
      if (r.agent ? !r.all : !(reader(caller) || ownSession(caller))) {
        throw denied(r.agent ? `personal facts are not a project's: ${r.agent} is granted only some projects` : `${name} is for the user's own surfaces and agents granted every project, not ${plain(caller || "an unnamed caller", 60)}`);
      }
    };
    const answer = answerer({ personal, graph, db: ctx.store.db, me: ctx.config.me || null, call: (tool, input) => ctx.call(tool, input),
      scratch: ctx.paths?.root ? path.join(String(ctx.paths.root), "capsule", "ask") : null });
    ctx.tool("memory.answer", {
      description: "Answer a question about the user's own life in one line (\"Your wife is Jordan.\", \"You drive a blue Volvo XC40.\") from personal facts, the graph, then the user's own words. Returns { answer, confidence, kind: fact|said|null, from (conversations), facts, sources, via: fact|meaning|keyword|null, ms }; answer is null when memory does not know. sources: true lists more of the turns it came from.",
      input: { type: "object", properties: { q: { type: "string" }, question: { type: "string", description: "the same as q" }, project_cwds: cwds, ...roomField, sources: { type: "boolean" }, ...agentField } },
      run: async (input, { caller } = {}) => {
        await personalOnly(input, caller, "memory.answer");
        return answer({ q: String(input.q ?? input.question ?? ""), project_cwds: clean(input.project_cwds), sources: Boolean(input.sources) });
      },
    });
    ctx.tool("memory.profile", {
      description: "The user's durable facts as short lines for a system prompt (\"Your wife is Jordan.\", \"You drive a blue Volvo XC40.\"): only what still holds at confidence 0.5 or more, and nothing sensitive (no dates, account-like numbers, addresses or health). Returns { facts: [{ text, kind: person|place|vehicle|work|client|preference|other, weight, id, rel, from }] }, strongest first.",
      input: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, ...agentField } },
      run: async (input, { caller } = {}) => {
        await personalOnly(input, caller, "memory.profile");
        if (running) await running.catch(() => {});
        return profile(personal, { limit: input.limit ?? 12 });
      },
    });
    // Told outright, by the person or their assistant: kept at once, no prompt (the no-nag rule).
    ctx.tool("memory.remember", {
      description: "Keep a fact the user or their assistant states outright (\"my wife is Jordan\", \"I moved to Lisbon\"). No confirmation. It is read like a conversation at confidence 0.95 and kept as a note either way, so memory.answer finds a line no rule reads by its words. room is kept as where it was said; personal facts are not a project's. Returns { id, text, facts: [{ id, subject, rel, object, confidence }] }.",
      input: { type: "object", properties: { text: { type: "string" }, room: { type: "string" }, ...agentField } },
      run: async (input, { caller } = {}) => {
        await personalOnly(input, caller, "memory.remember");
        if (running) await running.catch(() => {});
        const r = personal.remember(String(input.text ?? ""), { room: typeof input.room === "string" && input.room ? input.room : null, who: caller ? plain(caller, 60) : null });
        ctx.events.emit("memory.remembered", { id: r.id, facts: r.facts.length });
        return { id: r.id, text: r.text, facts: r.facts.map(f => ({ id: f.id, subject: f.subject, rel: f.rel, object: f.object, confidence: f.confidence })) };
      },
    });
    ctx.tool("memory.uncorrect", {
      callers: OWNERS,
      description: "Undo a correction, merge or split by its id. It stays listed as undone.",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: ownerWrite(async ({ id }) => { const c = curator.uncorrect(id); await settle(); return c; }),
    });
    ctx.tool("memory.merge", {
      callers: OWNERS,
      presence: { summary: mergeSummary },
      description: "Two nodes are one: everything said about the first is said about the second (into).",
      input: { type: "object", required: ["node", "into"], properties: { node: { type: "string" }, into: { type: "string" } } },
      run: ownerWrite(async ({ node, into }, { caller } = {}) => {
        const a = graph.resolve(node), b = graph.resolve(into);
        if (!a) throw new Error(`nothing in memory matches "${node}"`);
        if (!b) throw new Error(`nothing in memory matches "${into}"`);
        if (a.id === b.id) throw new Error("that is one node already");
        const c = curator.correct({ action: "merge", src: String(a.id), dst: String(b.id), who: String(caller || "") });
        ctx.events.emit("memory.merged", { id: Number(c.id), scope: "all" });
        await settle();
        return { correction: c, into: graph.facts({ about: String(b.id), limit: 20 }).about };
      }),
    });
    ctx.tool("memory.split", {
      callers: OWNERS,
      presence: { summary: splitSummary },
      description: "One node is two: with room or project, the one that project's sessions name is someone else (two different people with one name); with other, two nodes that were merged are kept apart.",
      input: { type: "object", required: ["node"], properties: { node: { type: "string" }, other: { type: "string" }, ...roomField } },
      run: ownerWrite(async (input, { caller } = {}) => {
        const n = graph.resolve(input.node);
        if (!n) throw new Error(`nothing in memory matches "${input.node}"`);
        const room = roomOf(input);
        let c;
        if (input.other) {
          const o = graph.resolve(input.other) || graph.node(String(input.other));
          const other = o ? String(o.id) : String(input.other);
          c = curator.correct({ action: "split", src: String(n.id), dst: other, who: String(caller || "") });
        } else {
          if (!room || room === "*") throw new Error("split needs room (the project whose one is someone else) or other");
          graph.view([], room);
          c = curator.correct({ action: "split", src: String(n.id), object: room, who: String(caller || "") });
        }
        ctx.events.emit("memory.split", { id: Number(c.id), scope: room && !input.other ? "project" : "all" });
        await settle();
        return { correction: c };
      }),
    });
    ctx.tool("memory.curate", {
      description: "Read any new turns and rebuild the graph now. full: true re-reads every turn. Returns counts.",
      input: { type: "object", properties: { full: { type: "boolean" }, ...agentField } },
      run: async ({ full = false, agent }, { caller } = {}) => {
        await guard({ agent }, caller, { whole: true });
        if (running) await running.catch(() => {});
        return run({ full, force: true });
      },
    });
    // The reader's usage line, and "read now" for the person (spends from the same caps).
    ctx.tool("memory.read", {
      callers: OWNERS,
      description: "The fast model's reading of your turns for personal facts: spend today and on the one-time backfill, turns waiting, cost per 1,000 turns. now: true reads what is waiting at once, within the caps.",
      input: { type: "object", properties: { now: { type: "boolean" }, max_runs: { type: "integer", minimum: 1, maximum: 1000 } } },
      run: ownerWrite(async ({ now = false, max_runs = 50 }) => {
        if (running) await running.catch(() => {});
        const r = now ? await model.drain({ maxRuns: max_runs }) : null;
        return { ...(r ? { ran: r } : {}), status: model.status() };
      }),
    });
    ctx.tool("memory.stats", {
      description: "How much memory holds: nodes, edges, facts, evidence, by kind and role, and the last curator run.",
      input: { type: "object", properties: { ...agentField } },
      // Counts over everything are the main graph's.
      run: async ({ agent }, { caller } = {}) => (await guard({ agent }, caller, { tailnet: true }), { ...graph.stats(), personal: { ...personal.stats(), model: model.status() } }),
    });

    return {
      async stop() {
        stopping = true;
        clearTimeout(timer);
        off();
        for (const o of offs) o();
        for (const o of modelOffs) if (typeof o === "function") o();
        model.stop();
        if (running) await running.catch(() => {});
      },
    };
  },
};
