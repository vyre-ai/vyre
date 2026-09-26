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
    const curator = new Curator(ctx.store.db, { me: ctx.config.me, log: ctx.log });
    const graph = new Graph(ctx.store.db, curator);
    let running = null, again = false, stopping = false, timer = null;

    /** One pass at a time. A request during a pass runs one more pass after it, not two. */
    const run = (opts = {}) => {
      if (running) { again = true; return running; }
      running = (async () => {
        let result;
        do {
          again = false;
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
    soon();

    // Projects, as the projects module knows them, for rooms and for an agent's grants. Memory
    // does not own projects; without the module there are simply no rooms.
    const projectList = async () => {
      const r = await ctx.call("projects.list", {});
      const list = r.error ? [] : (Array.isArray(r.data) ? r.data : r.data?.projects || []);
      return list.filter(p => p && p.slug).map(p => ({ slug: String(p.slug), name: String(p.name || p.slug),
        folders: [...new Set([p.home, ...(p.workspaces || []), ...(p.folders || [])].filter(Boolean).map(String))] }));
    };
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
    /** Throws unless the caller may read these folders' graph (none: the main graph). */
    const guard = async ({ agent, project_cwds = [] }, caller) => {
      const r = await reach(agent, caller);
      if (r.all) return r;
      const want = clean(project_cwds);
      if (!want.length) throw new Error(`the main graph is for the assistant and agents granted every project; ask for one of ${r.agent}'s projects with project_cwds`);
      const outside = want.filter(c => !within(c, r.folders));
      if (outside.length) throw new Error(`${r.agent} is not granted ${outside.join(", ")}`);
      return r;
    };
    /** The user's own surfaces. Only these, and a verified all-projects agent, draw the main graph. */
    const OWNER = new Set(["deck", "cli", "local"]);
    const agentField = { agent: { type: "string" } };

    ctx.tool("memory.graph", {
      description: "The graph as a floor plan for the Deck: one room per project, a shared room, nodes and edges, capped. project_cwds gives one project's graph; without it, the main graph (the assistant only). around/depth draw one node's neighbourhood. since returns { unchanged: true } when nothing moved.",
      input: { type: "object", properties: { project_cwds: cwds, around: { type: "string" }, depth: { type: "integer" }, limit: { type: "integer" }, since: { type: "integer" }, ...agentField } },
      run: async (input, { caller } = {}) => {
        const r = await guard(input, caller);
        // The main graph is a drawing of every client at once. Beyond the rule above, only the
        // user's own surfaces (or a verified agent with every project) are given it: a session
        // that has not said who it is gets its project's graph, not everyone's.
        const main = !clean(input.project_cwds).length;
        if (main && !r.agent && !OWNER.has(String(caller)) && !String(caller).startsWith("module:")) {
          throw new Error("the main graph is drawn for the Deck and the assistant; pass project_cwds for a project's graph");
        }
        return floorPlan(graph, { ...input, projects: await projectList() });
      },
    });
    ctx.tool("memory.facts", {
      description: "What memory holds: facts about one thing (about), about what a project's sessions name (project_cwds), or the most-seen outside parties. Each fact has its source turn, age and confidence.",
      input: { type: "object", properties: { about: { type: "string" }, project_cwds: cwds, limit: { type: "integer" }, ...agentField } },
      run: async ({ about, project_cwds = [], limit = 20, agent }, { caller } = {}) => (await guard({ agent, project_cwds }, caller), graph.facts({ about, project_cwds, limit: Math.min(200, Math.max(1, limit)) })),
    });
    ctx.tool("memory.relevant", {
      description: "The few facts worth adding to a prompt about this text, or [] when nothing in it is known. For the Enrich hook: precise, and fast.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, project_cwds: cwds, limit: { type: "integer" }, ...agentField } },
      run: async ({ text, project_cwds = [], limit = 5, agent }, { caller } = {}) => (await guard({ agent, project_cwds }, caller), graph.relevant({ text, project_cwds, limit: Math.min(20, Math.max(1, limit)) })),
    });
    ctx.tool("memory.why", {
      description: "The turns that support a fact (its id, src|rel|dst) or where a thing came up (a name). Turns that no longer exist are counted as gone.",
      input: { type: "object", required: ["fact"], properties: { fact: { type: "string" }, limit: { type: "integer" }, project_cwds: cwds, ...agentField } },
      run: async ({ fact, limit = 10, project_cwds = [], agent }, { caller } = {}) => (await guard({ agent, project_cwds }, caller), graph.why({ fact, project_cwds, limit: Math.min(50, Math.max(1, limit)) })),
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
        if (running) await running.catch(() => {});
      },
    };
  },
};
