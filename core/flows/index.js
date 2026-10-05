// @ts-check
// flows: the tools over the Flows assembly the daemon builds (core/daemon/flows-host.js). With the kernel off there is no assembly and every tool says so; with it on, each call runs under
// the CALLER's own chain, from the kernel and nowhere else (`ctx.kernel.chain(meta)`): a session token's chain (an assistant acting through the session it was given, its person's chain narrowed to the
// assistant) or the chain the daemon proved for a person's own surface. A call with neither gets the module's own service chain from the kernel, which is not a caller, and is refused. This module never
// decides who a person is from a label ("mcp", "harness", "device:x"). Approving, pausing, resuming and removing a Kit are a person's own and name a person's chain, and approving also asks for the person's
// proof. The module decides nothing about authority: every record, task and send a Flow makes goes through the kernel.
import { bridgeWatchers } from "../../kernel/flows/watcher-bridge.js";

const str = { type: "string" };
const open = { type: "object", additionalProperties: true, properties: { space: str } };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @type {Record<string, string>} */
const WHAT = {
  "flows.define": "Write a Flow, as text or in its stored form. Nothing runs until a person approves it.",
  "flows.approve": "Approve one version of a Flow, by its hash: a person, in their own name, and only what the card showed.",
  "flows.propose": "Ask an owner or an admin to approve a draft: a stored Flow version, or a change to the record types ({ what: \"types\", diff }). It becomes one task in Now; nothing is applied until they say yes.",
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
  "flows.budget": "The Space's daily AI allowance for Flow steps and what is used today; an owner or an admin sets it with tokens_per_day, and with context_tokens how much of a record's world an agent is shown.",
  "flows.retry": "Retry a failed run. A person's own.",
  "flows.kit.card": "The install card for a Kit.",
  "flows.kit.propose": "Propose a Kit for approval: its types, templates, roles and Flows. A person, or their assistant for them; the person is asked and nothing installs until they say yes.",
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
    /**
     * The caller's own chain, from the kernel only. The kernel hands back a verified session token's chain, else the chain built from facts the daemon proved about the connection, else THIS
     * module's own service chain: that last one is not a caller, so a chain that does not begin with a person is refused.
     * @param {any} _f @param {any} meta
     */
    const chainOf = async (f, meta) => {
      if (!ctx.kernel || typeof ctx.kernel.chain !== "function") throw refuse("Flows run only where the kernel is on", "unavailable");
      let chain;
      // A session token is checked by the door of the Space the call is for (a hosted firm Space has its own); anything else is the kernel's own answer for this call.
      if (meta && typeof meta.token === "string") { chain = await f.chainForToken(meta.token); if (!chain) throw refuse("this session is not valid", "denied"); }
      else { try { chain = await ctx.kernel.chain(meta); } catch { throw refuse("this call has no chain", "denied"); } }
      const first = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
      if (!first || !first.actor || first.actor.kind !== "person") throw refuse("a Flow is changed or run under a person's own chain or an assistant's session; this call carries neither", "denied");
      return chain;
    };
    for (const [name, description] of Object.entries(WHAT)) {
      ctx.tool(name, {
        description, input: open, callers: ["cli", "local", "deck", "capsule", "mobile", "device", "space", "agent", "mcp", "harness"],
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
      // the daemon's event bus hands a listener the whole event ({ type, payload, ... }); the bridge reads the payload ({ name, items }), so give it that
      on: (/** @type {string} */ type, /** @type {any} */ fn) => ctx.events.on(type, (/** @type {any} */ ev) => fn(ev && ev.payload !== undefined ? ev.payload : ev)),
      call: async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await ctx.call(tool, input); return r && r.data !== undefined ? r.data : r; },
      log: (/** @type {string} */ m) => ctx.log(m) }) : null;
    return { async stop() { if (typeof stopBridge === "function") stopBridge(); } };
  },
};
