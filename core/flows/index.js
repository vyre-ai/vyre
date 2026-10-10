// @ts-check
// flows: the tools over the Flows assembly the daemon builds (core/daemon/flows-host.js). With the kernel off there is no assembly and every tool says so; with it on, each call runs under
// the CALLER's own chain, from the kernel and nowhere else (`ctx.kernel.chain(meta)`): a session token's chain (an assistant acting through the session it was given, its person's chain narrowed to the
// assistant) or the chain the daemon proved for a person's own surface. A call with neither gets the module's own service chain from the kernel, which is not a caller, and is refused. This module never
// decides who a person is from a label ("mcp", "harness", "device:x"). Approving, pausing, resuming and removing a Kit are a person's own and name a person's chain, and approving also asks for the person's
// proof. The module decides nothing about authority: every record, task and send a Flow makes goes through the kernel.
import { bridgeWatchers } from "../../kernel/flows/watcher-bridge.js";
import { secretsIn } from "../../kernel/flows/no-secrets.js";
import { kitLibrary, kitFromLibrary } from "../../records/kits/library.js";
import { kernelKit, moduleKitProblems } from "../../records/kit-adapter.js";

const str = { type: "string" };
const open = { type: "object", additionalProperties: true, properties: { space: str } };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @type {Record<string, string>} */
const WHAT = {
  "flows.define": "Write a Flow, as text or in its stored form. Nothing runs until a person approves it.",
  "flows.approve": "Approve one version of a Flow, by its hash: a person, in their own name, and only what the card showed.",
  "flows.propose": "Ask an owner or admin to approve a stored Flow version, or a record-types change ({ what: \"types\", diff }). Nothing applies until they agree.",
  "flows.card": "The approval card for a Flow version: what it can do, what it needs, what changed.",
  "flows.get": "One Flow version as stored.",
  "flows.list": "The Flows of a Space.",
  "flows.code": "A Flow as code you can read and edit.",
  "flows.compile-text": "Check text as a Flow without storing it.",
  "flows.graph": "A Flow as a graph for the canvas.",
  "flows.simulate": "Replay recent events through a Flow without doing anything. With a Flow id and since, also compares with what it really did.",
  "flows.start": "Start a Flow now, with an input.",
  "flows.pause": "Pause a Flow (id), or every Flow (all: true), or drain (drain: true: finish what is running, start nothing). What arrives while paused is held, in order. A person's own.",
  "flows.resume": "Resume a paused Flow (id) or all of them (all: true). What was held runs now, in order; backlog: \"drop\" drops it instead and counts it. A person's own.",
  "flows.health": "One-line health of a Flow: last run, this week, next run, what needs a person, red if a Connection is red. No id lists all.",
  "flows.cheatsheet": "The whole Flows language on one page, generated from the code: triggers, step kinds, retries, checks, expressions, limits. Read it before writing a Flow.",
  "flows.from-chat": "Turn a chat's hand-made calls into a draft Flow: { name, calls: [{ tool, input }], variables?, propose? }. Never approved; propose also proposes it.",
  "flows.connections": "Which Flows use which Connections, with their health, so a red Connection shows what it stops. Name one Connection or list all.",
  "flows.kit.credentials": "Internal: the vault asks which approved Kit version a task is from and which Connections that version names for it, before it lends them to the task's doer ({ task } -> { approved, kit, version, credentials }). Only the vault may ask.",
  "flows.attention": "Runs that need a person (failed, paused, stuck, or a stage gate held), newest first: the Flow, step, plain reason, and whether loud or quiet.",
  "flows.settle": "Answer a run that needs attention: { run, action: retry | skip | stop | advance }. skip may carry `value` to use in place of the skipped step's output (a person's, not an assistant's); advance (a stage gate) takes `reason`. A person's own.",
  "flows.advance": "Move a record on before its stage's tasks are done: { run (the stage gate), reason }. The stage's owner or an admin, in their own name; the reason is on the gate's ledger.",
  "flows.patch": "Edit a Flow with small named ops, stored as a new draft: { id, base (version read), ops: [{ op: set|insert|replace|remove|move|trigger|meta, ... }] }.",
  "flows.test.save": "Save a test case: { id, name, event | input, expect }, or { id, from_run } to baseline a run. Failing cases block approval.",
  "flows.test.run": "Run every saved test case of a Flow (id, optional version) with nothing done for real, one line a case.",
  "flows.test.list": "The saved test cases of a Flow.",
  "flows.test.remove": "Remove a saved test case. A person's own.",
  "flows.timeline": "A run read back as a few lines, one per step: time, tries, check, who answered. step: one step in detail, secrets hidden.",
  "flows.diff": "What changed between two versions of a Flow (id, from, to), by step: added, removed, moved and changed steps, with a plain summary.",
  "flows.rollback": "Go back to an earlier version of a Flow (id, to) in one step: it is approved again by you, nothing is inherited from the old approval. Runs in flight keep their version; retry_failed: true moves failed runs that still match to it. A person's own.",
  "flows.describe": "A Flow (id) or run (run) in a few lines: trigger, one line per step, how it is doing; for a run, where it is.",
  "flows.control": "The Space's switch (running, paused or draining), how many runs are held and why, and how many events were dropped past the cap.",
  "flows.runs": "Recent runs of a Flow, newest first.",
  "flows.run": "One run: its trigger, its steps, what it did.",
  "flows.budget": "The Space's daily AI allowance for Flow steps and today's use. An owner or admin sets it with tokens_per_day, and context_tokens for record context.",
  "flows.retry": "Retry a failed or paused run from the stopped step. skip: true skips it (value: its replacement output); version: \"latest\" uses the active version.",
  "flows.cancel": "Stop a failed, paused or waiting run for good. Its record stays, marked cancelled. A person's own.",
  "flows.kit.card": "The install card for a Kit.",
  "flows.kit.propose": "Propose a Kit (types, templates, roles, Flows) for approval. The person is asked; nothing installs until they say yes.",
  "flows.kit.remove": "Remove a Kit. A person's own.",
  "flows.kit.list": "The Kits of a Space.",
  "flows.kit.test": "Dry-run a Kit read only on { kit, sample: { type, data } } or { kit, record }: tasks, briefs, checklists, holds, Flow effects.",
  "flows.kit.diff": "What updating an installed Kit to a given version would change: parts added, changed, removed, new abilities and risks. Read only.",
};
/** The Kit library ships with the build, so these two need no Space and no chain. */
const LIBRARY = {
  "flows.kit.library": "The Kits this build ships, before anything is installed: id, name, version, a plain description and what each adds.",
  "flows.kit.library.get": "One Kit from the library in the form flows.kit.card, flows.kit.diff and flows.kit.propose take.",
};
const PERSONAL = new Set(["flows.approve", "flows.rollback", "flows.pause", "flows.resume", "flows.kit.remove"]);
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
      if (!f) throw refuse("no such Space here (spaces.list shows yours)", "not_found");
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
      if (meta && typeof meta.token === "string") { chain = await f.chainForToken(meta.token); if (!chain) throw refuse("this session is not valid: sign in again", "denied"); }
      else { try { chain = await ctx.kernel.chain(meta); } catch { throw refuse("this call has no chain: call it from a signed-in session", "denied"); } }
      const first = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
      if (!first || !first.actor || first.actor.kind !== "person") throw refuse("a Flow is changed or run under a person's own chain or an assistant's session; this call carries neither", "denied");
      return chain;
    };
    const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent", "mcp", "harness"];
    for (const [name, description] of Object.entries(LIBRARY)) {
      ctx.tool(name, { description, input: { type: "object", additionalProperties: true, properties: { id: str } }, callers: CALLERS,
        run: async (/** @type {any} */ input) => {
          if (name === "flows.kit.library") return { kits: kitLibrary() };
          try { return { kit: kitFromLibrary(String(input && input.id || "")) }; } catch (e) { throw refuse(/** @type {Error} */ (e).message, "not_found"); }
        } });
    }
    for (const [name, description] of Object.entries(WHAT)) {
      ctx.tool(name, {
        description, input: open, callers: name === "flows.kit.propose" || name === "flows.attention" ? [...CALLERS, "module"] : name === "flows.kit.credentials" ? ["module"] : ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent", "mcp", "harness"],
        ...(name === "flows.approve" ? { presence: { summary: async (/** @type {any} */ i) => `Approve Flow ${String(i && i.id || "")} version ${String(i && i.version || "")}` } } : {}),
        ...(name === "flows.rollback" ? { presence: { summary: async (/** @type {any} */ i) => `Go back to version ${String(i && i.to || "")} of Flow ${String(i && i.id || "")}` } } : {}),
        run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
          const f = hostOf(input || {});
          // The approvals queue lists what needs attention as itself, with no person's chain on the call (it holds the person's queue); no other module may.
          // The vault lends a Connection to a task's doer only after flows says which approved Kit version names it; it holds no person's chain for that, and no other module may ask.
          if (name === "flows.kit.credentials" && !(meta && meta.caller === "module:vault")) throw refuse("only the vault asks which Connections a task's Kit names", "denied");
          const chain = (name === "flows.attention" && meta && meta.caller === "module:approvals") || name === "flows.kit.credentials" ? null : await chainOf(f, meta);
          if (PERSONAL.has(name) && !(chain.hops.length === 1 && chain.hops[0].actor.kind === "person")) throw refuse(`${name} is a person's own`, "denied");
          const { space: _space, module: fromModule, ...rest } = input || {};
          // A Kit may be given in the language's stored form as well as the kernel's. One that ships with an added module (`module` names it) is held to what a module may add.
          if (rest.kit && typeof rest.kit === "object" && /^flows\.kit\.(propose|card|diff)$/.test(name)) {
            rest.kit = kernelKit(rest.kit);
            // A Kit holds references, never values (R031-72): a proposal is stored whole, so a key anywhere in it would sit in the record, its change log and the approval card. Refused where it is, without repeating it.
            if (name === "flows.kit.propose") {
              const found = secretsIn(rest.kit);
              if (found.length) return { ok: false, errors: found.map(x => ({ path: `kit.${x.path}`, message: `this looks like ${x.kind}: a Kit never holds a key, a password or a token. Put it in the Vault and name the Connection instead (the Vault uses it; the Kit only names it)` })) };
            }
            if (typeof fromModule === "string" && fromModule) {
              const problems = moduleKitProblems(fromModule, rest.kit);
              if (problems.length) return { ok: false, errors: problems.map(message => ({ path: "kit", message })) };
            }
          }
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
