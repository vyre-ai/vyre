// @ts-check
// memory — the graph and the curator, as a module (docs/SPEC.md, section 7.4).
//
// The curator runs in the background: once on start for anything not yet read, and again
// shortly after Recall says a session was indexed. Start never waits for it, so a first run
// over a large history does not hold up vyred. Without Recall's tables there is nothing to
// read; every tool still answers, with nothing.

import { Curator } from "./curator.js";
import { Graph } from "./graph.js";

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
          if (result.changed) ctx.events.emit("memory.curated", { nodes: result.nodes, edges: result.edges, ms: result.ms });
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

    ctx.tool("memory.facts", {
      description: "What memory holds: facts about one thing (about), about what a project's sessions name (project_cwds), or the most-seen outside parties. Each fact has its source turn, age and confidence.",
      input: { type: "object", properties: { about: { type: "string" }, project_cwds: cwds, limit: { type: "integer" } } },
      run: async ({ about, project_cwds = [], limit = 20 }) => graph.facts({ about, project_cwds, limit: Math.min(200, Math.max(1, limit)) }),
    });
    ctx.tool("memory.relevant", {
      description: "The few facts worth adding to a prompt about this text, or [] when nothing in it is known. For the Enrich hook: precise, and fast.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, project_cwds: cwds, limit: { type: "integer" } } },
      run: async ({ text, project_cwds = [], limit = 5 }) => graph.relevant({ text, project_cwds, limit: Math.min(20, Math.max(1, limit)) }),
    });
    ctx.tool("memory.why", {
      description: "The turns that support a fact (its id, src|rel|dst) or where a thing came up (a name). Turns that no longer exist are counted as gone.",
      input: { type: "object", required: ["fact"], properties: { fact: { type: "string" }, limit: { type: "integer" } } },
      run: async ({ fact, limit = 10 }) => graph.why({ fact, limit: Math.min(50, Math.max(1, limit)) }),
    });
    const steer = mode => ({
      description: mode === "pin"
        ? "Pin a node so it ranks first wherever it is relevant, everywhere (scope '*') or in one project folder. off: true unpins."
        : "Mute a node so memory never offers it, everywhere (scope '*') or in one project folder. off: true unmutes.",
      input: { type: "object", required: ["node"], properties: { node: { type: "string" }, scope: { type: "string" }, off: { type: "boolean" } } },
      run: async ({ node, scope = "*", off = false }, { caller } = {}) => graph.steer({ node, scope, mode, off, who: caller || null }),
    });
    ctx.tool("memory.pin", steer("pin"));
    ctx.tool("memory.mute", steer("mute"));
    ctx.tool("memory.curate", {
      description: "Read any new turns and rebuild the graph now. full: true re-reads every turn. Returns counts.",
      input: { type: "object", properties: { full: { type: "boolean" } } },
      run: async ({ full = false }) => {
        if (running) await running.catch(() => {});
        return run({ full, force: true });
      },
    });
    ctx.tool("memory.stats", {
      description: "How much memory holds: nodes, edges, facts, evidence, by kind and role, and the last curator run.",
      input: { type: "object", properties: {} },
      run: async () => graph.stats(),
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
