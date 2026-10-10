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
import { isAgent, isPerson } from "../../lib/caller.js";
import { DUTY_NAME } from "./duty.js";
import { testHooks } from "../../lib/sandbox/index.js";
import { Runtime, MIGRATIONS, LATE_MIGRATIONS } from "./runtime.js";
import { runOnce } from "./run.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefs, MIGRATIONS as DEF_MIGRATIONS } from "./defs.js";
import { validZone, systemZone } from "../../lib/time/index.js";

/**
 * How often vyred looks for due watchers. Cron is minute-grained, so a tick faster than that
 * finds nothing new; docs/SPEC.md section 2, principle 8 caps idle polling at once a minute, so
 * this sits right at that floor rather than four times past it.
 */
const TICK_MS = 60_000;
export const SYNC_EVERY = 30;

/** The wall is probed once per vyred. @type {Promise<any>|null} */
let cachedWall = null;

const str = { type: "string" };

/** The person's own surfaces. A model reaches only what a tool lists beside them; a module hop is checked against the original caller by the registry. */
const PEOPLE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device"];
/** A model session (mcp) and the harness: the project-scoped tools below name them, since mustSee already limits a model to its granted projects. */
const MODEL = ["mcp", "harness"];

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
/** Test seams for the hook sandbox, keyed by the home: a wall that opens, or the net options a test needs. */
export const hookSeams = new Map();

export default {
  async start(ctx) {
    ctx.store.migrate([...MIGRATIONS, ...DEF_MIGRATIONS, ...LATE_MIGRATIONS]);
    // Definitions are hidden records where the kernel is on (core/watchers/defs.js); without it the folders are the whole definition, as before.
    /** @type {any} */ let rtRef = null;
    const defs = ctx.kernel && ctx.kernel.records ? createDefs({ kernel: ctx.kernel, dir: ctx.paths.watchers, db: ctx.store.db, log: ctx.log, onGone: name => { try { if (rtRef) rtRef.remove(name); } catch { /* it had no schedule row */ } } }) : null;
    // The folders and the records are brought into step before a tool reads or changes a definition and after one is written, and every minute with the schedule's tick.
    const sync = () => (defs ? defs.sync().catch(e => { ctx.log(`watchers: definitions not synced (${e && e.message})`); }) : Promise.resolve());
    const SYNCED = new Set(["watchers.list", "watchers.test", "watchers.card", "watchers.create", "watchers.preset", "watchers.delete", "watchers.duty.create", "watchers.duty.update", "watchers.duty.delete"]);
    const tool = (/** @type {string} */ name, /** @type {any} */ spec) => ctx.tool(name, defs && SYNCED.has(name) ? { ...spec, run: async (/** @type {any} */ i, /** @type {any} */ m) => { await sync(); const r = await spec.run(i, m); void sync(); return r; } } : spec);
    const rt = rtRef = new Runtime({
      db: ctx.store.db, dir: ctx.paths.watchers, defs,
      // Schedules run in the Space's time zone: the planner's configured zone, else the server's own.
      zone: () => { const z = ctx.config && ctx.config.planner && ctx.config.planner.timezone; return validZone(z) ? String(z) : systemZone(); },
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      // A watcher that fires at a different time since schedules follow the Space's zone is told once, as a to-do in the planner.
      notice: text => ctx.call("planner.add", { kind: "todo", title: text.slice(0, 120), body: text }),
      call: ctx.call, fetch: (name, watcher, field) => ctx.vault.fetch(name, { watcher, ...(field ? { field } : {}) }),
      teach: (kind, fact) => ctx.memory.teach(kind, fact),
      ask: async (prompt, o) => {
        // threads.quick, no tools (internal, module-only). Its cost reaches core/spend on its own, from the quick session's thread.finished.
        const r = await ctx.call("threads.quick", { purpose: "helper", prompt: String(prompt), timeout_ms: 30_000 });
        if (r.error || !r.data || r.data.ok === false) throw new Error((r.error && r.error.message) || "no model answered");
        return { text: String(r.data.text || ""), usd: Number(r.data.cost_usd) || 0, provider: r.data.provider };
      },
      thread: async id => { const r = await ctx.call("threads.get", { thread: id, limit: 1 }); return r.data && r.data.thread ? { project: r.data.thread.project ?? null } : null; },
      post: async (thread, text, from) => { const r = await ctx.call("threads.post", { thread, text, kind: "watcher.item", from }); if (r.error) throw new Error(r.error.message || r.error.code || "threads.post refused"); },
      // A Google account is read by a watcher only against a person's grant of the account's vault item to this watcher (`vyre vault grant <item> watchers --watcher <name>`), as for any credential.
      googleItem: async account => { const r = await ctx.call("google.accounts", {}); const a = (Array.isArray(r.data) ? r.data : []).find(/** @param {any} x */ x => x.name === account); return a && a.auth && typeof a.auth.item === "string" ? a.auth.item : null; },
      googleGranted: async (account, watcher) => {
        const r = await ctx.call("google.accounts", {}); const a = (Array.isArray(r.data) ? r.data : []).find(/** @param {any} x */ x => x.name === account);
        const item = a && a.auth && a.auth.item; if (!item) return false;
        // the vault's own check, the one release makes: a grant to this module and exactly this watcher
        const g = await ctx.call("vault.granted", { name: String(item), watcher });
        return Boolean(g.data && g.data.granted);
      },
      google: async input => { const r = await ctx.call("google.api", input); if (r.error) throw new Error(r.error.message || r.error.code || "the google module refused the request"); return r.data; },
      request: async input => { const r = await ctx.call("vault.request", input); if (r.error) throw new Error(r.error.message || r.error.code || "the vault refused the request"); return r.data; },
      spend: { check: async () => { const r = await ctx.call("spend.check", {}); return r.error ? { ok: false, line: "the spend ledger is not answering" } : r.data; } },
      log: ctx.log, netOptions: () => (process.env.NODE_TEST_CONTEXT ? testHooks.net : {}), wall: () => (process.env.NODE_TEST_CONTEXT ? testHooks.wall : undefined), findWall: () => (cachedWall ||= findWall()), forgetWall: () => { cachedWall = null; },
      listen: (type, fn) => ctx.events.on(type, fn),
    });
    rt.subscribe();
    // An agent sees only the projects it is granted: the registry puts meta.reach on a call to a tool with a projectArg
    // (fail closed: no answer means no projects). A person, a teammate's module and a hook have no meta.reach and see all.
    const projectOf = name => { const f = folderMod.read(ctx.paths.watchers, name); return f.spec ? f.spec.project : (rt.row(name) || {}).project || null; };
    const projectOfCwd = cwd => ctx.call("projects.of", { cwd }).then(r => (r.data && r.data.slug) || null);
    const projectOfThread = thread => ctx.call("threads.get", { thread, limit: 1 }).then(r => (r.data && r.data.thread && r.data.thread.project) || null);
    const mustSee = async (meta, name) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); if (!can(projectOf(name))) throw Object.assign(new Error(`no watcher ${name} (watchers.list shows them)`), { code: "not_found" }); };
    const shown = new ShownLog();
    /** A card served to a thread is remembered as shown, with the hash it carried. */
    const remember = (meta, card) => { const thread = meta && /** @type {any} */ (meta).thread; if (thread && card && card.hash) shown.record(thread, { name: card.name, hash: card.hash, title: card.lines && card.lines.do || null, state: card.state, project: card.project }); };

    tool("watchers.list", {
      description: "List watchers, drafts and turned-on ones, with state (draft, on, paused, changed, invalid), schedule, next and last run, and items filed.",
      input: { type: "object", properties: { project: { ...str, description: "only this project's watchers" } } },
      run: async (i, meta = {}) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); const l = rt.list(); return { ...l, watchers: l.watchers.filter(w => can(w.project) && (!i.project || w.project === i.project)) }; },
    });
    tool("watchers.test", {
      // A dry run executes the watcher's code in the sandbox (network, a granted credential, a model call) and records the run; a model dry-runs its own project's watchers before it asks to turn one on (the event input is the person's, checked below).
      callers: [...PEOPLE, "module", ...MODEL],
      description: "Dry-run a watcher folder once, filing nothing. Returns the items it would emit and its logs, or what to fix. Required before watchers.create.",
      input: { type: "object", required: ["name"], properties: { name: str, since: { description: "where to start reading; default null" }, event: { type: "object", description: "a real event's payload to run an event watcher on; must match its where (hook.received: { route, id } from hooks.list)" } } },
      run: async ({ name, since = null, event = null }, meta = {}) => {
        const { caller } = meta;
        // A dry run on a hook.received hands the watcher a webhook's body, which a model may not read
        // (hooks.delivery refuses it); the watcher's logs and items would show it. Only the person's own
        // surface may: an agent claim, a verified Vyre thread (meta.thread or a thread claim in the label),
        // a bare model session and the harness are all refused, by a positive check on who is asking.
        if (event && (!isPerson(caller) || isAgent(caller) || typeof meta.thread === "string")) throw new Error("a dry run on a real event is the owner's; a model dry-runs without event");
        await mustSee(meta, name);
        return rt.test(name, { since, event });
      },
    });
    tool("watchers.create", {
      description: "Turn on a watcher as last dry-run, with the card's hash. Runs once now, then on schedule. A model needs the person's say-so.",
      input: { type: "object", required: ["name"], properties: { name: str, hash: { ...str, description: "the card's hash, from watchers.card" } } },
      run: async (i) => rt.create(i.name, { hash: i.hash || null }),
    });

    // A teammate's standing duty is a watcher the teammates module manages for a person who turned it on (CHAT 09:21).
    // Its own tools, reach modules, so a model's "asked" gate on watchers.create never stands in a teammate's way.
    tool("watchers.duty.create", {
      description: "Create and turn on a teammate's standing duty: name duty-<role>-<id>, project, owner {kind: teammate, teammate}, when (an event like thread.finished, a schedule like daily 07:00, or push gmail), instruction, act. The teammates module's call, for a duty a person turned on.",
      input: { type: "object", required: ["name", "project", "owner", "when", "instruction"], properties: { name: str, project: str, owner: { type: "object" }, when: str, instruction: str, act: { type: "boolean" } } },
      run: async (i, { caller } = {}) => { dutyCaller(caller); return rt.createDuty(i); },
    });
    tool("watchers.duty.update", {
      description: "Change a teammate's duty: when, instruction or act. It keeps its cursor and stays on or paused as it was. The teammates module's call.",
      input: { type: "object", required: ["name"], properties: { name: str, when: str, instruction: str, act: { type: "boolean" } } },
      run: async (i, { caller } = {}) => { dutyCaller(caller); return rt.updateDuty(i); },
    });
    tool("watchers.duty.delete", { description: "Stop and forget a teammate's duty; its folder goes and its filed items stay. The teammates module's call.", input: named, run: async ({ name }, { caller } = {}) => { dutyCaller(caller); dutyName(name); return rt.remove(name); } });
    // A plugin's hook (core/skills): its script runs once in the watchers' sandbox, with no credentials, and only the hosts the plugin declared. The skills module asks; it does not import the runner.
    ctx.tool("watchers.hook.run", { description: "Run one approved plugin hook's script once in the watchers' sandbox: no credentials, only the declared hosts. The skills module's call.", internal: true, callers: ["module"],
      input: { type: "object", required: ["script"], properties: { script: { type: "string", maxLength: 200000 }, payload: {}, hosts: { type: "array", maxItems: 20, items: { type: "string", maxLength: 255 } } } },
      run: async (/** @type {any} */ i) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-hook-"));
        try {
          fs.writeFileSync(path.join(dir, "watch.js"), String(i.script));
          const seam = hookSeams.get(String((ctx.paths && ctx.paths.root) || "")) || {};
          const r = await runOnce({ dir, needs: [], since: null, hook: i.payload || null, timeoutMs: 8000, fetch: async () => { throw new Error("a hook handles no credentials"); }, hosts: Array.isArray(i.hosts) ? i.hosts : [], ...(seam.wall !== undefined ? { wall: seam.wall } : {}), ...(seam.findWall ? { findWall: seam.findWall } : {}), ...(seam.netOptions ? { netOptions: seam.netOptions } : {}) });
          return { ok: !r.error, ...(r.error ? { error: r.error } : {}), result: r.items[0] || null, logs: r.logs.slice(0, 20) };
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      } });
    ctx.tool("watchers.duty.run", { description: "Run a teammate's turned-on duty now and return what happened. The teammates module's call.", input: named, run: async ({ name }, { caller } = {}) => { dutyCaller(caller); dutyName(name); return rt.run(name); } });
    ctx.tool("watchers.duty.resume", { description: "Resume a paused duty of a teammate that a person turned on. The teammates module's call.", input: { type: "object", required: ["name"], properties: { name: str, hash: str } }, run: async ({ name, hash }, { caller } = {}) => { dutyCaller(caller); dutyName(name); return rt.resume(name, { hash: hash || null }); } });
    tool("watchers.delete", { description: "Stop and forget a watcher; a duty's folder goes too and its filed items stay.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.remove(name); } });
    ctx.tool("watchers.run", { description: "Run a turned-on watcher now and return what happened.", input: named, run: async ({ name }, { caller } = {}) => { owned(name, caller); return rt.run(name); } });
    // What an asked call acts on, for the registry's gate (reach asked, target): the keys lib/said/watchers.js records.
    ctx.tool("watchers.create.target", { description: "For the gate: the key watchers.create acts on, watchers.create:<project>/<name>@<hash> of the code now in the folder; no hash or a different hash answers nothing.", input: { type: "object" },
      run: async call => createTarget(call, { read: name => folderMod.read(ctx.paths.watchers, name) }) });
    ctx.tool("watchers.preset.target", { description: "For the gate: the key watchers.preset acts on, watchers.preset:<project>/<kind>.", input: { type: "object" }, run: async call => presetTarget(call) });
    // The cards a thread was shown, with the hash each carried when shown (never recomputed), for the assistant's recorder.
    ctx.tool("watchers.shown", { description: "The watcher cards shown in a thread, with the hash each card carried when it was shown: { project, kinds, watchers: [{ name, hash, title, state, project, at }] }. Answered from a record made when watchers.card or watchers.preset served the card, never from the folder now. The sessions module's call.", input: { type: "object", required: ["thread"], properties: { thread: str } },
      run: async ({ thread }) => {
        const watchers = shown.list(thread);
        return { project: watchers.length ? watchers[watchers.length - 1].project : null, kinds: PRESET_KINDS, watchers };
      } });
    tool("watchers.card", {
      description: "What to show before a watcher is turned on: when, check and do lines, what it reads, whether it acts, its cost, and the hash.",
      input: named,
      run: async ({ name }, meta = {}) => { await mustSee(meta, name); const c = rt.card(name); remember(meta, c); return c; },
    });
    tool("watchers.preset", {
      description: "Write a watcher for a common source (kind: mail, calendar, repo, slack, feed, connector, pr) from a few fields, left off with its card.",
      input: { type: "object", required: ["kind", "project"], properties: { kind: { ...str, description: "mail, calendar, repo, slack, feed, connector or pr. mail files short quoted notes for important mail a Gmail push announces; calendar files a note per new or changed matching event; repo, slack and feed watch new matches; connector polls a declared connector, read only; pr posts others' new comments on a session's pull requests into it as quoted data" }, connection: str, project: { ...str, description: "project slug the watcher belongs to" }, credential: { ...str, description: "vault credential: Google api-credential (mail, calendar), GitHub (repo, optional if public), Slack, or the connector's" }, google: { ...str, description: "connector gmail or google-calendar: name of a connected Google account, instead of credential" }, connection: { ...str, description: "mail: connection to use, default gmail; connector: id of a Connection made by the person" }, instruction: { ...str, description: "mail: what counts as important; optional" }, dailyUsd: { type: "number" }, calendar: { ...str, description: "calendar: calendar id, default primary" }, match: { type: "array", items: str, description: "words to look for; optional for calendar" }, days: { type: "integer", description: "calendar: days ahead to look, default 14" }, when: { ...str, description: "schedule; defaults: hourly (calendar, feed), every 30 minutes (repo), every 15 minutes (slack), every 10 minutes (pr)" }, label: str, repo: { ...str, description: "repo: owner/name" }, only: { ...str, description: "repo: issues, pulls or both" }, channel: { ...str, description: "slack: channel id" }, url: { ...str, description: "feed: feed URL" }, session: { ...str, description: "pr: session id" }, maxPerDay: { type: "integer", description: "pr: comments posted per day, default 5" }, connector: { ...str, description: "connector: declared connector id (gmail, google-calendar, stripe)" }, poll: { ...str, description: "connector: one of its polls" }, vars: { type: "object", description: "connector: what the poll needs, such as mailbox or calendar" }, lookback_days: { type: "integer", description: "connector: days back to read; optional" } } },
      // Reach "asked": for a model it runs only on the person's own words; it writes a draft and never turns it on.
      run: async (i, meta = {}) => {
        // kind "connector" with `connection`: a poll of a Connection the person made. Its declaration comes from the connectors module, and its credential is the Connection's own (conn-<id>) unless named.
        let resolved = {};
        if (i.kind === "connector" && i.connection) {
          const g = /** @type {any} */ (await ctx.call("connectors.connection.get", { id: String(i.connection) }));
          if (g.error || !g.data) throw new Error(`no Connection ${String(i.connection).slice(0, 40)}; connectors.connection.list shows them`);
          resolved = { declaration: g.data.declaration };
          i = { ...i, connector: g.data.declaration.id, credential: i.credential === undefined ? `conn-${g.data.id}` : i.credential };
        }
        const c = await rt.createPreset(i, resolved); remember(meta, c); return c;
      },
    });
    ctx.tool("watchers.pause", { callers: [...PEOPLE, "module", ...MODEL], description: "Stop a watcher running until it is resumed. The pause says who stopped it.", input: named,
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

    // the minute look is one local query for what is due; the definition records (Records) are brought into step when a watcher tool changes one, and as a safety net every half hour, not every minute
    let looks = 0;
    const timer = setInterval(() => { rt.tick(); if (++looks % SYNC_EVERY === 0) void sync(); }, TICK_MS);
    timer.unref?.();
    rt.tick();
    void sync();
    return { async stop() { clearInterval(timer); await rt.stop(); } };
  },
};
