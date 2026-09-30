// @ts-check
// watchers: the watcher runtime, as a module (docs/SPEC.md, section 7.6).
//
// A runtime, not a set of integrations: Claude writes each watcher through the write-a-watcher
// skill, and this runs it. Projects, the vault and Memory are used through ctx and are not listed
// under requires, so the runtime starts without them: a watcher that needs a vault item fails its
// run with "the vault is not running", and filed items wait for Memory rather than being lost.
// Each fetch names the watcher, and the vault releases only against a grant for that watcher.

import { isPerson } from "../../lib/caller.js";
import { DUTY_NAME } from "./duty.js";
import { testHooks } from "../../lib/sandbox/index.js";
import { Runtime, MIGRATIONS } from "./runtime.js";

/**
 * How often vyred looks for due watchers. Cron is minute-grained, so a tick faster than that
 * finds nothing new; docs/SPEC.md section 2, principle 8 caps idle polling at once a minute, so
 * this sits right at that floor rather than four times past it.
 */
const TICK_MS = 60_000;

const str = { type: "string" };

/** Deleting or running a watcher on demand: a duty by teammates' module or the person, any other only by the person. */
function owned(name, caller) {
  if (DUTY_NAME.test(String(name))) return dutyCaller(caller);
  if (!isPerson(caller)) throw Object.assign(new Error("deleting, running or resuming a watcher is the person's; an agent asks them"), { code: "denied" });
}

/** Duties are made and changed by teammates' module, for a person who turned them on, or by the person. */
function dutyCaller(caller) {
  if (caller === "module:team" || isPerson(caller)) return;
  throw Object.assign(new Error("a duty is created and changed by the teammates module or the person, not by an agent or a model session"), { code: "denied" });
}
const named = { type: "object", required: ["name"], properties: { name: str } };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const rt = new Runtime({
      db: ctx.store.db, dir: ctx.paths.watchers,
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      call: ctx.call, fetch: (name, watcher, field) => ctx.vault.fetch(name, { watcher, ...(field ? { field } : {}) }),
      teach: (kind, fact) => ctx.memory.teach(kind, fact),
      ask: async (prompt, o) => {
        // threads.quick, no tools (internal, module-only). Its cost reaches core/spend on its own, from the quick session's thread.finished.
        const r = await ctx.call("threads.quick", { purpose: "helper", prompt: String(prompt), timeout_ms: 30_000 });
        if (r.error || !r.data || r.data.ok === false) throw new Error((r.error && r.error.message) || "no model answered");
        return { text: String(r.data.text || ""), usd: Number(r.data.cost_usd) || 0, provider: r.data.provider };
      },
      spend: { check: async () => { const r = await ctx.call("spend.check", {}); return r.error ? { ok: false, line: "the spend ledger is not answering" } : r.data; } },
      log: ctx.log, netOptions: () => (process.env.NODE_TEST_CONTEXT ? testHooks.net : {}),
      listen: (type, fn) => ctx.events.on(type, fn),
    });
    rt.subscribe();

    ctx.tool("watchers.list", {
      description: "Every watcher: drafts Claude wrote, and those turned on, with state (draft, on, paused, changed, invalid), schedule, next and last run, and items filed. dir is the folder watchers are written in.",
      input: { type: "object", properties: {} },
      run: async () => rt.list(),
    });
    ctx.tool("watchers.test", {
      description: "Dry-run a watcher folder once, from since (default null), filing nothing. Returns the items it would emit and its logs, or what to fix. Required before watchers.create. For a watcher that runs on an event, event is a real event's payload to run it on (for hook.received, { route, id } from hooks.list); it must match the watcher's where.",
      input: { type: "object", required: ["name"], properties: { name: str, since: {}, event: { type: "object" } } },
      run: async ({ name, since = null, event = null }, { caller } = {}) => {
        // A dry run on a hook.received hands the watcher a webhook's body, which an agent may
        // not read (hooks.delivery refuses agents); the watcher's logs and items would show it.
        if (event && /(?:^|[\s:])agent:/.test(String(caller || ""))) throw new Error("a dry run on a real event is the owner's; an agent dry-runs without event");
        return rt.test(name, { since, event });
      },
    });
    ctx.tool("watchers.create", {
      description: "Turn on a watcher exactly as it was last dry-run. Runs once now, then on its schedule. Only after the user has seen the dry run's items and agreed. With owner, when and instruction it creates a teammate's standing duty instead (teammates' call only): when is an event like thread.finished, a schedule like daily 07:00, or push gmail.",
      input: { type: "object", required: ["name"], properties: { name: str, hash: str, project: str, owner: { type: "object" }, when: str, instruction: str, act: { type: "boolean" } } },
      run: async (i, { caller } = {}) => {
        if (i.owner === undefined && i.when === undefined && i.instruction === undefined) return rt.create(i.name, { hash: i.hash || null });
        dutyCaller(caller);
        for (const k of ["project", "owner", "when", "instruction"]) if (i[k] === undefined) throw new Error(`a duty needs ${k}`);
        return rt.createDuty(i);
      },
    });
    ctx.tool("watchers.update", {
      description: "Change a teammate's duty: when, instruction or act. It keeps its cursor and stays on or paused as it was. Teammates' call only.",
      input: { type: "object", required: ["name"], properties: { name: str, when: str, instruction: str, act: { type: "boolean" } } },
      run: async (i, { caller } = {}) => { dutyCaller(caller); return rt.updateDuty(i); },
    });
    ctx.tool("watchers.delete", { description: "Stop and forget a watcher; a duty's folder goes too and its filed items stay.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.remove(name); } });
    ctx.tool("watchers.run", { description: "Run a turned-on watcher now and return what happened.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.run(name); } });
    ctx.tool("watchers.card", {
      description: "What to show before a watcher is turned on: its three lines (when, check, do), what it reads, whether it can act and what it costs, worked out from the folder itself, plus the hash to pass back to watchers.create so the tap turns on exactly this code. No network, no model.",
      input: named,
      run: async ({ name }) => rt.card(name),
    });
    ctx.tool("watchers.pause", { description: "Stop a watcher running until it is resumed.", input: named, run: async ({ name }) => rt.pause(name) });
    ctx.tool("watchers.resume", { description: "Resume a paused watcher, clearing its failure count. The person's (or teammates' for a duty): an agent cannot undo a pause the person made.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.resume(name); } });
    ctx.tool("watchers.logs", {
      description: "A watcher's recent runs, newest first: when, why (schedule, retry, create, hook, event, test), items seen and filed, error and log lines.",
      input: { type: "object", required: ["name"], properties: { name: str, limit: { type: "integer" } } },
      run: async ({ name, limit = 10 }) => rt.logs(name, Math.min(200, Math.max(1, limit))),
    });
    ctx.tool("watchers.items", {
      description: "Items watchers have filed, newest first: for one watcher (name), one project (project slug), or all.",
      input: { type: "object", properties: { name: str, project: str, limit: { type: "integer" } } },
      run: async ({ name, project, limit = 50 }) => rt.items({ name, project, limit: Math.min(500, Math.max(1, limit)) }),
    });
    // What POST /v1/watchers/<name>/hook calls. A hook tool is reachable only through that route
    // and is never listed; the token is what guards it.
    ctx.tool("watchers.hook", {
      hook: true,
      description: "A webhook call for a watcher whose schedule is webhook.",
      input: { type: "object", required: ["name"], properties: { name: str, token: str, body: {} } },
      run: async ({ name, token, body }) => rt.hook(name, token, body),
    });

    const timer = setInterval(() => rt.tick(), TICK_MS);
    timer.unref?.();
    rt.tick();
    return { async stop() { clearInterval(timer); await rt.stop(); } };
  },
};
