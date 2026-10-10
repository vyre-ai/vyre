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
import { Runtime, MIGRATIONS } from "./runtime.js";
import { createDefs, MIGRATIONS as DEF_MIGRATIONS } from "./defs.js";

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
export default {
  async start(ctx) {
    ctx.store.migrate([...MIGRATIONS, ...DEF_MIGRATIONS]);
    // Definitions are hidden records where the kernel is on (core/watchers/defs.js); without it the folders are the whole definition, as before.
    /** @type {any} */ let rtRef = null;
    const defs = ctx.kernel && ctx.kernel.records ? createDefs({ kernel: ctx.kernel, dir: ctx.paths.watchers, db: ctx.store.db, log: ctx.log, onGone: name => { try { if (rtRef) rtRef.remove(name); } catch { /* it had no schedule row */ } } }) : null;
    // The folders and the records are brought into step before a tool reads or changes a definition and after one is written, and every minute with the schedule's tick.
    const sync = () => (defs ? defs.sync().catch(e => { ctx.log(`watchers: definitions not synced (${e && e.message})`); }) : Promise.resolve());
    const SYNCED = new Set(["watchers.list", "watchers.test", "watchers.card", "watchers.create", "watchers.preset", "watchers.delete", "watchers.duty.create", "watchers.duty.update", "watchers.duty.delete"]);
    const tool = (/** @type {string} */ name, /** @type {any} */ spec) => ctx.tool(name, defs && SYNCED.has(name) ? { ...spec, run: async (/** @type {any} */ i, /** @type {any} */ m) => { await sync(); const r = await spec.run(i, m); void sync(); return r; } } : spec);
    const rt = rtRef = new Runtime({
      db: ctx.store.db, dir: ctx.paths.watchers, defs,
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
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
    const mustSee = async (meta, name) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); if (!can(projectOf(name))) throw Object.assign(new Error(`no watcher ${name}`), { code: "not_found" }); };
    const shown = new ShownLog();
    /** A card served to a thread is remembered as shown, with the hash it carried. */
    const remember = (meta, card) => { const thread = meta && /** @type {any} */ (meta).thread; if (thread && card && card.hash) shown.record(thread, { name: card.name, hash: card.hash, title: card.lines && card.lines.do || null, state: card.state, project: card.project }); };

    tool("watchers.list", {
      description: "Every watcher: drafts Claude wrote, and those turned on, with state (draft, on, paused, changed, invalid), schedule, next and last run, and items filed. dir is the folder watchers are written in.",
      input: { type: "object", properties: { project: str } },
      run: async (i, meta = {}) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); const l = rt.list(); return { ...l, watchers: l.watchers.filter(w => can(w.project) && (!i.project || w.project === i.project)) }; },
    });
    tool("watchers.test", {
      // A dry run executes the watcher's code in the sandbox (network, a granted credential, a model call) and records the run; a model dry-runs its own project's watchers before it asks to turn one on (the event input is the person's, checked below).
      callers: [...PEOPLE, "module", ...MODEL],
      description: "Dry-run a watcher folder once, from since (default null), filing nothing. Returns the items it would emit and its logs, or what to fix. Required before watchers.create. For a watcher that runs on an event, event is a real event's payload to run it on (for hook.received, { route, id } from hooks.list); it must match the watcher's where.",
      input: { type: "object", required: ["name"], properties: { name: str, since: {}, event: { type: "object" } } },
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
      description: "Turn on a watcher exactly as it was last dry-run (pass the card's hash). Runs once now, then on its schedule. For a model it runs only when the person's own words asked for it, after they have seen the card.",
      input: { type: "object", required: ["name"], properties: { name: str, hash: str } },
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
      description: "What to show before a watcher is turned on: its three lines (when, check, do), what it reads, whether it can act and what it costs, worked out from the folder itself, plus the hash to pass back to watchers.create so the tap turns on exactly this code. No network, no model.",
      input: named,
      run: async ({ name }, meta = {}) => { await mustSee(meta, name); const c = rt.card(name); remember(meta, c); return c; },
    });
    tool("watchers.preset", {
      description: "Write a watcher for a common source from a few fields, left off with its card. kind \"mail\": project, credential (the Google api-credential in the vault), connection (default gmail), instruction (what counts as important, optional); files short quoted notes for the important mail a Gmail push announces. kind \"calendar\": project, credential, calendar (default primary), match (words to look for, optional), days (default 14), when (default hourly); files a note for each new or changed matching event. kind \"repo\": project, repo (owner/name), credential (a GitHub api-credential, optional for a public repo), match, only (issues, pulls or both), when (default every 30 minutes). kind \"slack\": project, credential, channel (the channel id), match, when (default every 15 minutes). kind \"feed\": project, url, match, when (default hourly). kind \"connector\": project, connector (a declared connector: gmail, google-calendar, stripe), poll (one of its polls), credential (the vault credential for it; for gmail and google-calendar not a credential but google: the name of a connected Google account), vars (what the poll needs: mailbox or calendar), when, lookback_days (optional); polls any declared connector with no code of its own, files each new item once, read only. kind \"pr\": project, session (the session id), when (default every 10 minutes), maxPerDay (default 5): posts the new comments other people leave on that session's pull requests into the session, as quoted data. None sends or changes anything. The answer carries the grant command the person runs once, then watchers.create {name, hash} turns it on.",
      input: { type: "object", required: ["kind", "project"], properties: { kind: str, connection: str, project: str, credential: str, google: str, connection: str, instruction: str, dailyUsd: { type: "number" }, calendar: str, match: { type: "array", items: str }, days: { type: "integer" }, when: str, label: str, repo: str, only: str, channel: str, url: str, session: str, maxPerDay: { type: "integer" }, connector: str, poll: str, vars: { type: "object" }, lookback_days: { type: "integer" } } },
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
