// @ts-check
// watchers: the watcher runtime, as a module (docs/SPEC.md, section 7.6).
//
// A runtime, not a set of integrations: Claude writes each watcher through the write-a-watcher
// skill, and this runs it. Projects, the vault and Memory are used through ctx and are not listed
// under requires, so the runtime starts without them: a watcher that needs a vault item fails its
// run with "the vault is not running", and filed items wait for Memory rather than being lost.
// Each fetch names the watcher, and the vault releases only against a grant for that watcher.

import { findWall } from "./spawner-wall.js";
import { createTarget, presetTarget } from "./targets.js";
import { ShownLog } from "./shown.js";
import { scopeFor } from "./scope.js";
import { PRESET_KINDS } from "./presets.js";
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
    // An agent sees only the projects it is granted: the registry puts meta.reach on a call to a tool with a projectArg
    // (fail closed: no answer means no projects). A person, a teammate's module and a hook have no meta.reach and see all.
    const projectOf = name => { const f = folderMod.read(ctx.paths.watchers, name); return f.spec ? f.spec.project : (rt.row(name) || {}).project || null; };
    const projectOfCwd = cwd => ctx.call("projects.of", { cwd }).then(r => (r.data && r.data.slug) || null);
    const projectOfThread = thread => ctx.call("threads.get", { thread, limit: 1 }).then(r => (r.data && r.data.thread && r.data.thread.project) || null);
    const mustSee = async (meta, name) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); if (!can(projectOf(name))) throw Object.assign(new Error(`no watcher ${name}`), { code: "not_found" }); };
    const shown = new ShownLog();
    /** A card served to a thread is remembered as shown, with the hash it carried. */
    const remember = (meta, card) => { const thread = meta && /** @type {any} */ (meta).thread; if (thread && card && card.hash) shown.record(thread, { name: card.name, hash: card.hash, title: card.lines && card.lines.do || null, state: card.state, project: card.project }); };

    ctx.tool("watchers.list", {
      description: "Every watcher: drafts Claude wrote, and those turned on, with state (draft, on, paused, changed, invalid), schedule, next and last run, and items filed. dir is the folder watchers are written in.",
      input: { type: "object", properties: { project: str } },
      run: async (i, meta = {}) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); const l = rt.list(); return { ...l, watchers: l.watchers.filter(w => can(w.project) && (!i.project || w.project === i.project)) }; },
    });
    ctx.tool("watchers.test", {
      description: "Dry-run a watcher folder once, from since (default null), filing nothing. Returns the items it would emit and its logs, or what to fix. Required before watchers.create. For a watcher that runs on an event, event is a real event's payload to run it on (for hook.received, { route, id } from hooks.list); it must match the watcher's where.",
      input: { type: "object", required: ["name"], properties: { name: str, since: {}, event: { type: "object" } } },
      run: async ({ name, since = null, event = null }, meta = {}) => {
        const { caller } = meta;
        // A dry run on a hook.received hands the watcher a webhook's body, which an agent may
        // not read (hooks.delivery refuses agents); the watcher's logs and items would show it.
        if (event && /(?:^|[\s:])agent:/.test(String(caller || ""))) throw new Error("a dry run on a real event is the owner's; an agent dry-runs without event");
        await mustSee(meta, name);
        return rt.test(name, { since, event });
      },
    });
    ctx.tool("watchers.create", {
      description: "Turn on a watcher exactly as it was last dry-run. Runs once now, then on its schedule. Only after the user has seen the dry run's items and agreed.",
      input: named,
      run: async ({ name }, meta = {}) => { await mustSee(meta, name); const c = rt.card(name); remember(meta, c); return c; },
    });
    ctx.tool("watchers.preset", {
      description: "Write a watcher for a common source from a few fields, left off with its card. kind \"mail\": project, credential (the Google api-credential in the vault), connection (default gmail), instruction (what counts as important, optional); files short quoted notes for the important mail a Gmail push announces. kind \"calendar\": project, credential, calendar (default primary), match (words to look for, optional), days (default 14), when (default hourly); files a note for each new or changed matching event. kind \"repo\": project, repo (owner/name), credential (a GitHub api-credential, optional for a public repo), match, only (issues, pulls or both), when (default every 30 minutes). kind \"slack\": project, credential, channel (the channel id), match, when (default every 15 minutes). kind \"feed\": project, url, match, when (default hourly). None sends or changes anything. The answer carries the grant command the person runs once, then watchers.create {name, hash} turns it on.",
      input: { type: "object", required: ["kind", "project"], properties: { kind: str, project: str, credential: str, connection: str, instruction: str, dailyUsd: { type: "number" }, calendar: str, match: { type: "array", items: str }, days: { type: "integer" }, when: str, label: str, repo: str, only: str, channel: str, url: str } },
      // Reach "asked": for a model it runs only on the person's own words; it writes a draft and never turns it on.
      run: async (i, meta = {}) => { const c = await rt.createPreset(i); remember(meta, c); return c; },
    });
    ctx.tool("watchers.pause", { description: "Stop a watcher running until it is resumed. The pause says who stopped it.", input: named,
      run: async ({ name }, meta = {}) => { await mustSee(meta, name); const m = /** @type {any} */ (meta); return rt.pause(name, `paused by ${m.agent || m.caller || "someone"}`); } });
    ctx.tool("watchers.resume", { description: "Resume a paused watcher, clearing its failure count. The person's (or teammates' for a duty): an agent cannot undo a pause the person made.", input: { type: "object", required: ["name"], properties: { name: str, hash: str } }, run: async ({ name, hash }, { caller } = {}) => { owned(name, caller); return rt.resume(name, { hash: hash || null }); } });
    ctx.tool("watchers.logs", {
      description: "A watcher's recent runs, newest first: when, why (schedule, retry, create, hook, event, test), items seen and filed, error and log lines.",
      input: { type: "object", required: ["name"], properties: { name: str, limit: { type: "integer" } } },
      run: async ({ name, limit = 10 }, meta = {}) => { await mustSee(meta, name); return rt.logs(name, Math.min(200, Math.max(1, limit))); },
    });
    ctx.tool("watchers.items", {
      description: "Items watchers have filed, newest first: for one watcher (name), one project (project slug), or all.",
      input: { type: "object", properties: { name: str, project: str, limit: { type: "integer" } } },
      run: async ({ name, project, limit = 50 }, meta = {}) => {
        if (name) await mustSee(meta, name);
        const can = await scopeFor(meta, projectOfCwd, projectOfThread);
        return rt.items({ name, project, limit: Math.min(500, Math.max(1, limit)) }).filter(it => can(it.project));
      },
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
