// @ts-check
// memory — the graph and the curator, as a module (docs/SPEC.md, section 7.4).
//
// The curator runs in the background: once on start for anything not yet read, and again
// shortly after Recall says a session was indexed. Start never waits for it, so a first run
// over a large history does not hold up vyred. Without Recall's tables there is nothing to
// read; every tool still answers, with nothing.

import { Curator } from "./curator.js";
import { Graph } from "./graph.js";
import { floorPlan } from "./floor.js";
import path from "node:path";
import { within } from "./teach.js";

/** How long to wait after a session.indexed event before curating, so a burst of turns is one pass. */
const SETTLE_MS = 250;

const cwds = { type: "array", items: { type: "string" } };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // config.memory.relations: { prefers?, decided? } switches on the relations still under
    // evaluation (docs/adr/0007-intelligence.md, decision 2). Both are off by default.
    const curator = new Curator(ctx.store.db, { me: ctx.config.me, log: ctx.log, relations: ctx.config.memory?.relations });
    const graph = new Graph(ctx.store.db, curator);
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
      if (p.rewritten && p.session) curator.reset(String(p.session));
      soon();
    });
    // A project made, changed or a thread picked changes the rooms.
    const offs = ["project.created", "project.changed", "thread.picked", "thread.unpicked"].map(type => ctx.events.on(type, () => { roomsStale = true; soon(); }));
    soon();

    // Projects, as the projects module knows them, for rooms and for an agent's grants. Memory
    // does not own projects; without the module there are simply no rooms. Picked threads are
    // read when the list carries their ids (threads or picked as a list); counts are ignored.
    const projectList = async () => {
      const r = await ctx.call("projects.list", {});
      if (r.error && r.error.code !== "no_such_tool") throw new Error(r.error.message);
      const list = r.error ? [] : (Array.isArray(r.data) ? r.data : r.data?.projects || []);
      const ids = p => (Array.isArray(p.threads) ? p.threads : Array.isArray(p.picked) ? p.picked : []).map(x => String(x && typeof x === "object" ? x.id : x));
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
    const reach = async (agent, caller) => {
      const said = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(caller || ""))?.[1] || null;
      if (said && agent && said !== agent) throw new Error(`the call came from agent ${said} but names agent ${agent}`);
      const who = said || agent || null;
      if (!who) return { all: true, agent: null, folders: [] };
      const r = await ctx.call("agents.list", {});
      if (r.error) throw new Error(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
      const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
      const a = list.find(x => x && x.name === who);
      if (!a) throw new Error(`no agent ${who}`);
      if (a.kind === "assistant" || a.projects === "*") return { all: true, agent: who, folders: [] };
      const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
      return { all: false, agent: who, folders: (await projectList()).filter(p => mine.has(p.slug) || mine.has(p.name)).flatMap(p => p.folders) };
    };
    const clean = cwds => (cwds || []).map(c => path.resolve(String(c)));
    /**
     * Throws unless the caller may read these folders' graph or this room (none: the main
     * graph). The unfiled room holds whatever no project owns, so it is read like the main
     * graph: by the user and by agents granted every project.
     */
    const guard = async ({ agent, project_cwds = [], room }, caller) => {
      const r = await reach(agent, caller);
      if (r.all) return r;
      if (room === "unfiled") throw new Error(`the unfiled room is for the user and agents granted every project, not ${r.agent}`);
      const known = room && room !== "*" ? curator.rooms().find(p => p.slug === room) : null;
      if (room && room !== "*" && !known) throw new Error(`no project ${room}`);
      const want = known ? known.folders : clean(project_cwds);
      if (!want.length) throw new Error(`the main graph is for the assistant and agents granted every project; ask for one of ${r.agent}'s projects with project_cwds`);
      const outside = want.filter(c => !within(c, r.folders));
      if (outside.length) throw new Error(`${r.agent} is not granted ${outside.join(", ")}`);
      return r;
    };
    /** The user's own surfaces. Only these, and a verified all-projects agent, draw the main graph. */
    const OWNER = new Set(["deck", "cli", "local"]);
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
        const r = await guard(input, caller);
        // The main graph is a drawing of every client at once. Beyond the rule above, only the
        // user's own surfaces (or a verified agent with every project) are given it: a session
        // that has not said who it is gets its project's graph, not everyone's.
        const main = !clean(input.project_cwds).length && (!input.room || input.room === "*" || input.room === "unfiled");
        if (main && !r.agent && !OWNER.has(String(caller)) && !String(caller).startsWith("module:")) {
          throw new Error("the main graph is drawn for the Deck and the assistant; pass project_cwds for a project's graph");
        }
        const projects = await projectList();
        if (curator.setRooms(projects)) soon();
        return floorPlan(graph, { ...input, projects });
      },
    });
    ctx.tool("memory.facts", {
      description: "What memory holds: facts about one thing (about), about what a project's sessions name (project_cwds), or the most-seen outside parties. Each fact has its source turn, age and confidence.",
      input: { type: "object", properties: { about: { type: "string" }, project_cwds: cwds, ...roomField, limit: { type: "integer" }, ...agentField } },
      run: async ({ about, project_cwds = [], limit = 20, agent, ...rest }, { caller } = {}) => { const room = roomOf(rest); return (await guard({ agent, project_cwds, room }, caller), graph.facts({ about, project_cwds, room, limit: Math.min(200, Math.max(1, limit)) })); },
    });
    ctx.tool("memory.relevant", {
      description: "The few facts worth adding to a prompt about this text, or [] when nothing in it is known. For the Enrich hook: precise, and fast.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, project_cwds: cwds, ...roomField, limit: { type: "integer" }, ...agentField } },
      run: async ({ text, project_cwds = [], limit = 5, agent, ...rest }, { caller } = {}) => { const room = roomOf(rest); return (await guard({ agent, project_cwds, room }, caller), graph.relevant({ text, project_cwds, room, limit: Math.min(20, Math.max(1, limit)) })); },
    });
    ctx.tool("memory.why", {
      description: "The turns that support a fact (its id, src|rel|dst) or where a thing came up (a name). Turns that no longer exist are counted as gone.",
      input: { type: "object", required: ["fact"], properties: { fact: { type: "string" }, limit: { type: "integer" }, project_cwds: cwds, ...roomField, ...agentField } },
      run: async ({ fact, limit = 10, project_cwds = [], agent, ...rest }, { caller } = {}) => { const room = roomOf(rest); return (await guard({ agent, project_cwds, room }, caller), graph.why({ fact, project_cwds, room, limit: Math.min(50, Math.max(1, limit)) })); },
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
        const r = await guard({ agent, project_cwds }, caller);
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
    ctx.tool("memory.correct", {
      callers: OWNERS,
      description: "Correct a fact: wrong (never true), ended (stopped being true at `at`), replace (ended, and `object` is true instead), confirm (sure, no decay), add (a new fact). fact is src|rel|dst from memory.facts, or give subject, rel and object. room or project scopes it to one project; otherwise everywhere.",
      input: { type: "object", required: ["action"], properties: { fact: { type: "string" }, subject: { type: "string" }, rel: { type: "string" }, object: { type: "string" },
        action: { type: "string", enum: ["wrong", "ended", "replace", "confirm", "add"] }, at: {}, note: { type: "string" }, ...roomField } },
      run: async (input, { caller } = {}) => {
        const { scope, sc } = scopeOf(input);
        const t = graph.target(input, sc);
        const c = curator.correct({ action: input.action, src: t.src, rel: t.rel, dst: t.dst, object: t.object, at: when(input.at), scope, note: input.note ?? null, who: String(caller || "") });
        corrected(c, t.row);
        await settle();
        return { correction: c, facts: graph.facts({ about: t.src, room: sc?.room ?? undefined, limit: 20 }).facts.filter(f => f.rel === t.rel) };
      },
    });
    ctx.tool("memory.corrections", {
      callers: OWNERS,
      description: "What the user has corrected, merged or split, newest first. room or project: that project's and the ones for everywhere. all: include undone ones.",
      input: { type: "object", properties: { all: { type: "boolean" }, ...roomField } },
      run: async input => curator.corrections({ scope: roomOf(input), all: Boolean(input.all) }),
    });
    ctx.tool("memory.uncorrect", {
      callers: OWNERS,
      description: "Undo a correction, merge or split by its id. It stays listed as undone.",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => { const c = curator.uncorrect(id); await settle(); return c; },
    });
    ctx.tool("memory.merge", {
      callers: OWNERS,
      description: "Two nodes are one: everything said about the first is said about the second (into).",
      input: { type: "object", required: ["node", "into"], properties: { node: { type: "string" }, into: { type: "string" } } },
      run: async ({ node, into }, { caller } = {}) => {
        const a = graph.resolve(node), b = graph.resolve(into);
        if (!a) throw new Error(`nothing in memory matches "${node}"`);
        if (!b) throw new Error(`nothing in memory matches "${into}"`);
        if (a.id === b.id) throw new Error("that is one node already");
        const c = curator.correct({ action: "merge", src: String(a.id), dst: String(b.id), who: String(caller || "") });
        ctx.events.emit("memory.merged", { id: Number(c.id), scope: "all" });
        await settle();
        return { correction: c, into: graph.facts({ about: String(b.id), limit: 20 }).about };
      },
    });
    ctx.tool("memory.split", {
      callers: OWNERS,
      description: "One node is two: with room or project, the one that project's sessions name is someone else (two different people with one name); with other, two nodes that were merged are kept apart.",
      input: { type: "object", required: ["node"], properties: { node: { type: "string" }, other: { type: "string" }, ...roomField } },
      run: async (input, { caller } = {}) => {
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
      },
    });
    ctx.tool("memory.curate", {
      description: "Read any new turns and rebuild the graph now. full: true re-reads every turn. Returns counts.",
      input: { type: "object", properties: { full: { type: "boolean" }, ...agentField } },
      run: async ({ full = false, agent }, { caller } = {}) => {
        await guard({ agent }, caller);
        if (running) await running.catch(() => {});
        return run({ full, force: true });
      },
    });
    ctx.tool("memory.stats", {
      description: "How much memory holds: nodes, edges, facts, evidence, by kind and role, and the last curator run.",
      input: { type: "object", properties: { ...agentField } },
      // Counts over everything are the main graph's.
      run: async ({ agent }, { caller } = {}) => (await guard({ agent }, caller), graph.stats()),
    });

    return {
      async stop() {
        stopping = true;
        clearTimeout(timer);
        off();
        for (const o of offs) o();
        if (running) await running.catch(() => {});
      },
    };
  },
};
