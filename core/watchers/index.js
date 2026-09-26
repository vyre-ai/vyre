// @ts-check
// watchers: the watcher runtime, as a module (docs/SPEC.md, section 7.6).
//
// A runtime, not a set of integrations: Claude writes each watcher through the write-a-watcher
// skill, and this runs it. Projects, the vault and Memory are used through ctx and are not listed
// under requires, so the runtime starts without them: a watcher that needs a vault item fails its
// run with "the vault is not running", and filed items wait for Memory rather than being lost.
// Each fetch names the watcher, and the vault releases only against a grant for that watcher.

import { Runtime, MIGRATIONS } from "./runtime.js";

/**
 * How often vyred looks for due watchers. Cron is minute-grained, so a tick faster than that
 * finds nothing new; docs/SPEC.md section 2, principle 8 caps idle polling at once a minute, so
 * this sits right at that floor rather than four times past it.
 */
const TICK_MS = 60_000;

const str = { type: "string" };
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
      log: ctx.log,
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
      description: "Turn on a watcher exactly as it was last dry-run. Runs once now, then on its schedule. Only after the user has seen the dry run's items and agreed.",
      input: named,
      run: async ({ name }) => rt.create(name),
    });
    ctx.tool("watchers.pause", { description: "Stop a watcher running until it is resumed.", input: named, run: async ({ name }) => rt.pause(name) });
    ctx.tool("watchers.resume", { description: "Resume a paused watcher, clearing its failure count.", input: named, run: async ({ name }) => rt.resume(name) });
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
