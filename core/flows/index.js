// @ts-check
// flows: the tools over the Flows assembly the daemon builds (core/daemon/flows-host.js). With the kernel off there is no assembly and every tool says so; with it on, each call runs under
// the CALLER's own chain: a person on their own surface acts as the Space's owner; an assistant acts through the session token it was given (its person's chain, narrowed to the
// assistant); anything else has no chain and is refused. Approving, pausing, resuming and removing a Kit are a person's own and name a person's chain, and approving also asks for the person's
// proof. The module decides nothing about authority: every record, task and send a Flow makes goes through the kernel.
import { isPerson } from "../../lib/caller.js";
import { bridgeWatchers } from "../../kernel/flows/watcher-bridge.js";

const str = { type: "string" };
const open = { type: "object", additionalProperties: true, properties: { space: str } };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @type {Record<string, string>} */
const WHAT = {
  "flows.define": "Write a Flow, as text or in its stored form. Nothing runs until a person approves it.",
  "flows.approve": "Approve one version of a Flow, by its hash: a person, in their own name, and only what the card showed.",
  "flows.card": "The approval card for a Flow version: what it can do, what it needs, what changed.",
  "flows.get": "One Flow version as stored.",
  "flows.list": "The Flows of a Space.",
  "flows.code": "A Flow as code you can read and edit.",
  "flows.compile-text": "Check text as a Flow without storing it.",
  "flows.graph": "A Flow as a graph for the canvas.",
  "flows.simulate": "Replay recent events through a Flow without doing anything.",
  "flows.start": "Start a Flow now, with an input.",
  "flows.pause": "Pause a Flow. A person's own.",
  "flows.resume": "Resume a paused Flow. A person's own.",
  "flows.runs": "Recent runs of a Flow, newest first.",
  "flows.run": "One run: its trigger, its steps, what it did.",
  "flows.retry": "Retry a failed run. A person's own.",
  "flows.kit.card": "The install card for a Kit.",
  "flows.kit.propose": "Propose a Kit for approval: its types, templates, roles and Flows. A person's own.",
  "flows.kit.remove": "Remove a Kit. A person's own.",
  "flows.kit.list": "The Kits of a Space.",
};
const PERSONAL = new Set(["flows.approve", "flows.pause", "flows.resume", "flows.kit.remove"]);
/** The kit tools keep their names inside the assembly (kernel/flows), so a tool of this module maps to it. */
const INNER = (/** @type {string} */ n) => n.replace(/^flows\.kit\./, "kits.");

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const hostOf = (/** @type {any} */ input) => {
      const h = ctx.flowsHost;
      if (!h) throw refuse("Flows run only where the kernel is on", "unavailable");
      const space = typeof input.space === "string" && input.space ? input.space : ctx.kernel && ctx.kernel.space;
      const f = space && h.get(space);
      if (!f) throw refuse("no such Space here", "not_found");
      return f;
    };
    /** The caller's own chain: a session token's, else the owner's for a person on their own surface. @param {any} f @param {any} meta */
    const chainOf = async (f, meta) => {
      if (meta && typeof meta.token === "string") { const c = await f.chainForToken(meta.token); if (c) return c; throw refuse("this session is not valid", "denied"); }
      if (isPerson(meta)) return f.personChain();
      throw refuse("a Flow is changed or run under a person's own chain or an assistant's session", "denied");
    };
    for (const [name, description] of Object.entries(WHAT)) {
      ctx.tool(name, {
        description, input: open, callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "mcp", "harness"],
        ...(name === "flows.approve" ? { presence: { summary: async (/** @type {any} */ i) => `Approve Flow ${String(i && i.id || "")} version ${String(i && i.version || "")}` } } : {}),
        run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
          const f = hostOf(input || {});
          const chain = await chainOf(f, meta);
          if (PERSONAL.has(name) && !(chain.hops.length === 1 && chain.hops[0].actor.kind === "person")) throw refuse(`${name} is a person's own`, "denied");
          const { space: _space, ...rest } = input || {};
          return f.flows.tools[INNER(name)](chain, rest);
        },
      });
    }
    // A watcher that finds something new starts the Flows armed on it, once per item (kernel/flows/watcher-bridge.js reads the items back as this module, so a Flow sees what that
    // tool lets this caller see). The watchers module is the home's own, so this is the home's own Space.
    const stopBridge = ctx.flowsHost && ctx.kernel ? bridgeWatchers({
      runner: { watcherItem: async (/** @type {any} */ w) => { const f = ctx.flowsHost.get(ctx.kernel.space); if (!f) return; return f.flows.watcherItem(w); } },
      on: (/** @type {string} */ type, /** @type {any} */ fn) => ctx.events.on(type, fn),
      call: async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await ctx.call(tool, input); return r && r.data !== undefined ? r.data : r; },
      log: (/** @type {string} */ m) => ctx.log(m) }) : null;
    return { async stop() { if (typeof stopBridge === "function") stopBridge(); } };
  },
};
