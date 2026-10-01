// @ts-check
// watchers: the watcher runtime, as a module (docs/SPEC.md, section 7.6).
//
// A runtime, not a set of integrations: Claude writes each watcher through the write-a-watcher
// skill, and this runs it. Projects, the vault and Memory are used through ctx and are not listed
// under requires, so the runtime starts without them: a watcher that needs a vault item fails its
// run with "the vault is not running", and filed items wait for Memory rather than being lost.
// Each fetch names the watcher, and the vault releases only against a grant for that watcher.

import { findWall } from "./spawner-wall.js";
import { actTarget } from "./targets.js";
import * as folderMod from "./folder.js";
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

/** The wall is probed once per vyred. @type {Promise<any>|null} */
let cachedWall = null;

const str = { type: "string" };

/** Deleting, running or resuming a watcher on demand is the person's (reach person); a duty is managed by the teammates module through watchers.duty.*, or by the person. */
function owned(name, caller) {
  if (DUTY_NAME.test(String(name))) return dutyCaller(caller);
  if (!isPerson(caller)) throw Object.assign(new Error("deleting, running or resuming a watcher is the person's; an agent asks them"), { code: "denied" });
}

/** The duty tools act on duties only. */
function dutyName(name) {
  if (!DUTY_NAME.test(String(name))) throw Object.assign(new Error("watchers.duty.* acts on a teammate's duty (a name starting duty-)"), { code: "bad_input" });
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
      request: async input => { const r = await ctx.call("vault.request", input); if (r.error) throw new Error(r.error.message || r.error.code || "the vault refused the request"); return r.data; },
      spend: { check: async () => { const r = await ctx.call("spend.check", {}); return r.error ? { ok: false, line: "the spend ledger is not answering" } : r.data; } },
      log: ctx.log, netOptions: () => (process.env.NODE_TEST_CONTEXT ? testHooks.net : {}), wall: () => (process.env.NODE_TEST_CONTEXT ? testHooks.wall : undefined), findWall: () => (cachedWall ||= findWall()), forgetWall: () => { cachedWall = null; },
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
      description: "Turn on a watcher exactly as it was last dry-run (pass the card's hash). Runs once now, then on its schedule. For a model it runs only when the person's own words asked for it, after they have seen the card.",
      input: { type: "object", required: ["name"], properties: { name: str, hash: str } },
      run: async (i) => rt.create(i.name, { hash: i.hash || null }),
    });

    // A teammate's standing duty is a watcher the teammates module manages for a person who turned it on (CHAT 09:21).
    // Its own tools, reach modules, so a model's "asked" gate on watchers.create never stands in a teammate's way.
    ctx.tool("watchers.duty.create", {
      description: "Create and turn on a teammate's standing duty: name duty-<role>-<id>, project, owner {kind: teammate, teammate}, when (an event like thread.finished, a schedule like daily 07:00, or push gmail), instruction, act. The teammates module's call, for a duty a person turned on.",
      input: { type: "object", required: ["name", "project", "owner", "when", "instruction"], properties: { name: str, project: str, owner: { type: "object" }, when: str, instruction: str, act: { type: "boolean" } } },
      run: async (i, { caller } = {}) => { dutyCaller(caller); return rt.createDuty(i); },
    });
    ctx.tool("watchers.duty.update", {
      description: "Change a teammate's duty: when, instruction or act. It keeps its cursor and stays on or paused as it was. The teammates module's call.",
      input: { type: "object", required: ["name"], properties: { name: str, when: str, instruction: str, act: { type: "boolean" } } },
      run: async (i, { caller } = {}) => { dutyCaller(caller); return rt.updateDuty(i); },
    });
    ctx.tool("watchers.duty.delete", { description: "Stop and forget a teammate's duty; its folder goes and its filed items stay. The teammates module's call.", input: named, run: async ({ name }, { caller } = {}) => { dutyCaller(caller); dutyName(name); return rt.remove(name); } });
    ctx.tool("watchers.duty.run", { description: "Run a teammate's turned-on duty now and return what happened. The teammates module's call.", input: named, run: async ({ name }, { caller } = {}) => { dutyCaller(caller); dutyName(name); return rt.run(name); } });
    ctx.tool("watchers.duty.resume", { description: "Resume a paused duty of a teammate that a person turned on. The teammates module's call.", input: { type: "object", required: ["name"], properties: { name: str, hash: str } }, run: async ({ name, hash }, { caller } = {}) => { dutyCaller(caller); dutyName(name); return rt.resume(name, { hash: hash || null }); } });
    ctx.tool("watchers.delete", { description: "Stop and forget a watcher; a duty's folder goes too and its filed items stay.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.remove(name); } });
    ctx.tool("watchers.run", { description: "Run a turned-on watcher now and return what happened.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.run(name); } });
    // What an asked call acts on, for the registry's gate (reach asked, target): the keys lib/said/watchers.js records.
    ctx.tool("watchers.act.target", { description: "For the gate: the key an asked watchers call acts on. watchers.create: <name>@<hash> of the code the card showed (no hash, no key); watchers.preset: <project>/<kind>.", input: { type: "object" },
      run: async call => actTarget(call, { read: name => folderMod.read(ctx.paths.watchers, name) }) });
    ctx.tool("watchers.card", {
      description: "What to show before a watcher is turned on: its three lines (when, check, do), what it reads, whether it can act and what it costs, worked out from the folder itself, plus the hash to pass back to watchers.create so the tap turns on exactly this code. No network, no model.",
      input: named,
      run: async ({ name }) => rt.card(name),
    });
    ctx.tool("watchers.preset", {
      description: "Write a watcher for a common source from a few fields, left off with its card. kind \"mail\": project, credential (the Google api-credential in the vault), connection (default gmail), instruction (what counts as important, optional); files short quoted notes for the important mail a Gmail push announces. kind \"calendar\": project, credential, calendar (default primary), match (words to look for, optional), days (default 14), when (default hourly); files a note for each new or changed matching event. kind \"repo\": project, repo (owner/name), credential (a GitHub api-credential, optional for a public repo), match, only (issues, pulls or both), when (default every 30 minutes). kind \"slack\": project, credential, channel (the channel id), match, when (default every 15 minutes). kind \"feed\": project, url, match, when (default hourly). None sends or changes anything. The answer carries the grant command the person runs once, then watchers.create {name, hash} turns it on.",
      input: { type: "object", required: ["kind", "project"], properties: { kind: str, project: str, credential: str, connection: str, instruction: str, dailyUsd: { type: "number" }, calendar: str, match: { type: "array", items: str }, days: { type: "integer" }, when: str, label: str, repo: str, only: str, channel: str, url: str } },
      // Reach "asked": for a model it runs only on the person's own words; it writes a draft and never turns it on.
      run: async i => rt.createPreset(i),
    });
    ctx.tool("watchers.pause", { description: "Stop a watcher running until it is resumed.", input: named, run: async ({ name }) => rt.pause(name) });
    ctx.tool("watchers.resume", { description: "Resume a paused watcher, clearing its failure count. The person's (or teammates' for a duty): an agent cannot undo a pause the person made.", input: { type: "object", required: ["name"], properties: { name: str, hash: str } }, run: async ({ name, hash }, { caller } = {}) => { owned(name, caller); return rt.resume(name, { hash: hash || null }); } });
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
