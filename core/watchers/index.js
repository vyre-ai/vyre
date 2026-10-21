// @ts-check
// watchers: the watcher runtime, as a module (docs/SPEC.md, section 7.6).
//
// A runtime, not a set of integrations: an agent sets up its own watcher when a person asks it to (watchers.write, the
// write-a-watcher skill), and this runs it. Projects, the vault and Memory are used through ctx and are not listed
// under requires, so the runtime starts without them: a watcher that needs a vault item fails its
// run with "the vault is not running", and filed items wait for Memory rather than being lost.
// Each fetch names the watcher, and the vault releases only against a grant for that watcher.

import { findWall } from "./spawner-wall.js";
import { createTarget, presetTarget } from "./targets.js";
import { ShownLog } from "./shown.js";
import { scopeFor } from "./scope.js";
import { PRESET_KINDS } from "./presets.js";
import * as folderMod from "./folder.js";
import { isAgent, isPerson, agentName } from "../../lib/caller.js";
import { askerAccount as askerOf } from "./asker.js";
import { DUTY_NAME } from "./duty.js";
import { testHooks } from "../../lib/sandbox/index.js";
import { Runtime, MIGRATIONS, LATE_MIGRATIONS, WAITING } from "./runtime.js";
import { runOnce } from "./run.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefs, MIGRATIONS as DEF_MIGRATIONS } from "./defs.js";
import { ROUTINE_EMITS, ROUTINE_WATCH_JS, routineSchedule } from "./routine.js";
import * as cron from "./cron.js";
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
const PEOPLE = ["cli", "local", "deck", "capsule", "tailnet", "device"];
/** A model session (mcp) and the harness: the project-scoped tools below name them, since mustSee already limits a model to its granted projects. */
const MODEL = ["mcp", "harness"];

/** Deleting, running or resuming a watcher on demand is the person's (reach person); a duty is managed by the teammates module through watchers.duty.*, or by the person. An agent manages its own watchers with watchers.own.*. */
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
    const SYNCED = new Set(["watchers.list", "watchers.test", "watchers.card", "watchers.create", "watchers.preset", "watchers.delete", "watchers.duty.create", "watchers.duty.update", "watchers.duty.delete", "watchers.own.delete"]);
    const tool = (/** @type {string} */ name, /** @type {any} */ spec) => ctx.tool(name, defs && SYNCED.has(name) ? { ...spec, run: async (/** @type {any} */ i, /** @type {any} */ m) => { await sync(); const r = await spec.run(i, m); void sync(); return r; } } : spec);
    const K = ctx.kernel || null;
    const canon = (/** @type {string} */ x) => (K && typeof K.canonicalPerson === "function" ? K.canonicalPerson(x) : x);
    /** Whether a person is the Space's owner. No kernel: one person, the owner. @param {string|null|undefined} person */
    const isOwnerPerson = person => (!K ? true : Boolean(person && K.owner && canon(String(person)) === canon(String(K.owner))));
    /** The person a call is for: its chain's first person hop, else the owner (the owner's own surfaces and the home's services). Null when the chain cannot be read. @param {any} meta */
    const personOf = async meta => {
      if (!K || typeof K.chain !== "function") return null;
      try { const c = await K.chain(meta); const h = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : (K.owner ? String(K.owner) : null); }
      catch { return null; }
    };
    const askerAccount = (/** @type {string|undefined} */ person, /** @type {string} */ agent) => askerOf({ call: ctx.call, isOwner: isOwnerPerson }, person, agent);
    const rt = rtRef = new Runtime({
      db: ctx.store.db, dir: ctx.paths.watchers, defs,
      // Schedules run in the Space's time zone: the planner's configured zone, else the server's own.
      zone: () => { const z = ctx.config && ctx.config.planner && ctx.config.planner.timezone; return validZone(z) ? String(z) : systemZone(); },
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      // A watcher that fires at a different time since schedules follow the Space's zone is told once, as a to-do in the planner.
      notice: text => ctx.call("planner.add", { kind: "todo", title: text.slice(0, 120), body: text }),
      // An agent's own watcher (`agent` set) reads what is lent to that agent: the vault checks the agent's grant, not a per-watcher one.
      call: ctx.call, fetch: async (name, watcher, field, agent) => {
        if (!agent) return ctx.vault.fetch(name, { watcher, ...(field ? { field } : {}) });
        const r = await ctx.call("vault.release", { name, watcher, agent, ...(field ? { field } : {}) });
        if (r.error) throw new Error(r.error.code === "no_such_tool" ? "the vault is not running on this machine" : r.error.message);
        return r.data && r.data.value;
      },
      teach: (kind, fact) => ctx.memory.teach(kind, fact),
      ask: async (prompt, o = {}) => {
        // threads.quick, no tools (internal, module-only). Its cost reaches core/spend on its own, from the quick session's thread.finished.
        // An agent's own watcher asks on the AI account of the person it runs for (any provider they hold one on), never the owner's for someone else.
        const who = o && o.agent ? await askerAccount(o.person, o.agent) : {};
        const r = await ctx.call("threads.quick", { purpose: "helper", prompt: String(prompt), timeout_ms: 30_000, ...who });
        if (r.error || !r.data || r.data.ok === false) throw new Error((r.error && r.error.message) || "no model answered");
        return { text: String(r.data.text || ""), usd: Number(r.data.cost_usd) || 0, provider: r.data.provider };
      },
      thread: async id => { const r = await ctx.call("threads.get", { thread: id, limit: 1 }); return r.data && r.data.thread ? { project: r.data.thread.project ?? null, agent: r.data.thread.agent ?? null } : null; },
      // An agent's own watcher wakes that agent for the person who asked, in the chat it was asked in (the agents module checks the thread and the account).
      wakeAgent: async w => {
        const r = await ctx.call("agents.wake", { task: `watcher:${w.watcher}`, agent: w.agent, title: w.watcher, watcher: w.watcher, text: w.text, ...(w.person ? { approver: w.person } : {}), ...(w.thread ? { thread: w.thread } : {}) });
        if (r.error) throw new Error(r.error.message || r.error.code || "agents.wake refused");
        return r.data;
      },
      post: async (thread, text, from) => { const r = await ctx.call("threads.post", { thread, text, kind: "watcher.item", from }); if (r.error) throw new Error(r.error.message || r.error.code || "threads.post refused"); },
      // A Google account is read by a watcher only against a person's grant of the account's vault item to this watcher (`vyre vault grant <item> watchers --watcher <name>`), as for any credential.
      googleItem: async account => { const r = await ctx.call("google.accounts", {}); const a = (Array.isArray(r.data) ? r.data : []).find(/** @param {any} x */ x => x.name === account); return a && a.auth && typeof a.auth.item === "string" ? a.auth.item : null; },
      googleGranted: async (account, watcher, agent) => {
        const r = await ctx.call("google.accounts", {}); const a = (Array.isArray(r.data) ? r.data : []).find(/** @param {any} x */ x => x.name === account);
        const item = a && a.auth && a.auth.item; if (!item) return false;
        // the vault's own check, the one release makes: a grant to this module and exactly this watcher, or for an agent's own watcher what is lent to that agent
        const g = await ctx.call("vault.granted", { name: String(item), watcher, ...(agent ? { agent } : {}) });
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
    /** The agent a model's call comes from: vyred's verified meta.agent, else the daemon-assigned claim in its label (L-1). Two that disagree are no one. @param {any} meta */
    const callingAgent = meta => { const m = meta || {}; const v = typeof m.agent === "string" && m.agent ? m.agent : null, c = agentName(m.caller || ""); return v && c && v !== c ? null : v || c || null; };
    /** An agent sees its own watchers wherever they file; anything else by project, as before. */
    const visible = (meta, can, name, project) => { const own = rt.ownerAgent(name); return (own !== null && own === callingAgent(meta)) || can(project || null); };   // can(null) is true only for a caller that sees everything
    const mustSee = async (meta, name) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); if (!visible(meta, can, name, projectOf(name))) throw Object.assign(new Error(`no watcher ${name} (watchers.list shows them)`), { code: "not_found" }); };
    /** An agent's own watcher, for that agent's own call: the name checked, the owner checked, the caller a model session of that agent. */
    const mustOwn = (meta, name) => {
      const me = callingAgent(meta), own = rt.ownerAgent(String(name));
      if (!me) throw Object.assign(new Error("watchers.own.* is for an agent managing its own watchers; a person uses watchers.pause, resume, run and delete"), { code: "denied" });
      if (own !== me) throw Object.assign(new Error(own ? `${name} is ${own}'s watcher, not yours: only ${own} or a person manages it` : `${name} is not one of your watchers (watchers.list with agent shows yours)`), { code: own ? "denied" : "not_found" });
      return me;
    };
    const shown = new ShownLog();
    /** A card served to a thread is remembered as shown, with the hash it carried. */
    const remember = (meta, card) => { const thread = meta && /** @type {any} */ (meta).thread; if (thread && card && card.hash) shown.record(thread, { name: card.name, hash: card.hash, title: card.lines && card.lines.do || null, state: card.state, project: card.project }); };

    tool("watchers.list", {
      description: "List watchers with state, schedule, next and last run, and items filed. An agent's own also say the person each runs for.",
      input: { type: "object", properties: { project: { ...str, description: "only this project's watchers" }, agent: { ...str, description: "only this agent's own watchers (an agent passes its own name to see the ones it set up)" } } },
      run: async (i, meta = {}) => { const can = await scopeFor(meta, projectOfCwd, projectOfThread); const l = rt.list(i.agent ? { agent: String(i.agent) } : {}); return { ...l, watchers: l.watchers.filter(w => visible(meta, can, w.name, w.project) && (!i.project || w.project === i.project)) }; },
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


    // ---------------------------------------------------------------- an agent's own Routines and Watchers
    // A Watcher runs when something new appears ("tell me when an invoice from Northwind arrives"); a Routine runs on a schedule ("every weekday at 9,
    // summarise my inbox"). Both belong to the agent that set them up, are made only when the person's own words in the chat asked (reach "asked", the
    // said-check), and run for that person on that person's own AI account. They live in this module's one store, beside teammates' duties.
    /** Write a definition as the hidden def-watcher record (the folder follows from it), or the folder itself where the kernel is off. */
    const putDef = async (/** @type {string} */ name, /** @type {string} */ json, /** @type {string} */ code) => {
      if (defs) { await defs.put(name, json, code); return; }
      const dir = path.join(ctx.paths.watchers, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "watcher.json"), json);
      fs.writeFileSync(path.join(dir, "watch.js"), code);
    };
    /** The calling agent, for a tool only an agent's own session uses. */
    const mustAgent = (/** @type {any} */ meta, /** @type {string} */ what) => {
      const me = callingAgent(meta);
      if (!me) throw Object.assign(new Error(`${what} is for an agent setting up its own; a person asks the agent in chat`), { code: "denied" });
      return me;
    };
    /** A name that is free, or already this agent's own. Teammates' duties keep their own names. */
    const freeOrMine = (/** @type {string} */ name, /** @type {string} */ me) => {
      if (!folderMod.NAME.test(String(name || "")) || String(name).length > 60) throw Object.assign(new Error(`"${String(name).slice(0, 60)}" is not a name: lowercase words joined by dashes, like northwind-invoices`), { code: "bad_input" });
      if (DUTY_NAME.test(name)) throw Object.assign(new Error("names starting duty- are teammates' duties; pick another name"), { code: "bad_input" });
      const own = rt.ownerAgent(name);
      if (own && own !== me) throw Object.assign(new Error(`${name} is ${own}'s; pick another name`), { code: "denied" });
      if (!own && (rt.row(name) || fs.existsSync(path.join(ctx.paths.watchers, name)))) throw Object.assign(new Error(`a watcher named ${name} already exists; pick another name`), { code: "denied" });
    };
    /** The owner block Vyre writes into an agent's own definition: from the verified call, never from the agent's words. */
    const ownerOf = async (/** @type {any} */ meta, /** @type {string} */ me) => {
      const person = await personOf(meta);
      const thread = typeof (meta || {}).thread === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(meta.thread) ? meta.thread : null;
      return { kind: "agent", agent: me, ...(person ? { person } : {}), ...(thread ? { thread } : {}) };
    };
    /** A watcher an agent wrote: Vyre sets the owner, drops what only Vyre may say, writes it and records it as paused until a test passes. */
    const writeOwnWatcher = async (/** @type {any} */ meta, /** @type {string} */ me, /** @type {any} */ i) => {
      const spec = i.spec && typeof i.spec === "object" && !Array.isArray(i.spec) ? { ...i.spec } : null;
      if (!spec) throw Object.assign(new Error("spec is watcher.json as an object: schedule (cron) or on and where, net (the hosts it reads, each with the Vault item or Connection lent to you), summary { when, check, do }"), { code: "bad_input" });
      if (typeof i.code !== "string" || !i.code.trim() || i.code.length > 200_000) throw Object.assign(new Error("code is watch.js as text: export default async function watch({ since, emit, log, fetch, ask })"), { code: "bad_input" });
      for (const k of ["owner", "act", "about", "source", "needs"]) delete spec[k];
      if (spec.emits === ROUTINE_EMITS) delete spec.emits;
      const json = JSON.stringify({ ...spec, name: i.name, owner: await ownerOf(meta, me) }, null, 2);
      const checked = folderMod.checkFiles(i.name, json, String(i.code));
      await putDef(i.name, json, String(i.code));
      rt.ownWritten(i.name, me);
      let card = null;
      if (!checked.problems.length) { card = rt.card(i.name); remember(meta, card); }
      return { name: i.name, state: "paused", waiting: true, ...(checked.problems.length ? { problems: checked.problems, next: "Fix these with watchers.revise, then dry-run it with watchers.test." } : { card, next: "Dry-run it with watchers.test now. It turns on when the test passes. Then tell the person in plain words what you set up, for example: Done. I'll tell you here when an invoice from Northwind arrives." }) };
    };

    tool("watchers.write", {
      callers: [...PEOPLE, ...MODEL],
      description: "Set up a Watcher for yourself, only when the person's own words in this chat asked. It starts paused: test it with watchers.test.",
      input: { type: "object", required: ["name", "spec", "code"], properties: { name: { ...str, description: "lowercase words joined by dashes, like northwind-invoices" }, spec: { type: "object", description: "watcher.json; Vyre sets name and owner. schedule as cron like */15 * * * *, or on and where for an event. net: the hosts it reads, each with the Vault item or Connection already lent to you. summary { when, check, do }. Optional ask { dailyUsd }." }, code: { type: "string", maxLength: 200000, description: "watch.js: export default async function watch({ since, emit, log, fetch, ask }), read only" } } },
      run: async (i, meta = {}) => { const me = mustAgent(meta, "watchers.write"); freeOrMine(String(i.name), me); return writeOwnWatcher(meta, me, i); },
    });
    tool("watchers.revise", {
      callers: [...PEOPLE, ...MODEL],
      description: "Fix your own Watcher until its first test passes: same spec and code as watchers.write. Once it is on, the person must ask again.",
      input: { type: "object", required: ["name", "spec", "code"], properties: { name: str, spec: { type: "object" }, code: { type: "string", maxLength: 200000 } } },
      run: async (i, meta = {}) => {
        const me = mustOwn(meta, String(i.name));
        const r = rt.row(String(i.name));
        if (!r || r.paused_by !== "waiting") throw Object.assign(new Error(`${i.name} already passed its test and is set up; to change it, the person asks you again and you use watchers.write`), { code: "denied" });
        return writeOwnWatcher(meta, me, i);
      },
    });
    tool("watchers.routine.create", {
      callers: [...PEOPLE, ...MODEL],
      description: "Set up a Routine for yourself, only when the person's own words in this chat asked for work at set times. For arrivals use watchers.write.",
      input: { type: "object", required: ["name", "when", "instructions"], properties: { name: { ...str, description: "lowercase words joined by dashes, like morning-inbox" }, when: { ...str, description: "weekdays 09:00, daily 07:30, every 2 hours, hourly or five-field cron, in the Space's time zone" }, instructions: { type: "string", maxLength: 2000, description: "what to do each time, in the person's words" } } },
      run: async (i, meta = {}) => {
        const me = mustAgent(meta, "watchers.routine.create");
        const name = String(i.name);
        freeOrMine(name, me);
        const instruction = String(i.instructions || "").trim();
        if (!instruction) throw Object.assign(new Error("instructions are what to do each time, in plain words"), { code: "bad_input" });
        const zone = (() => { const z = ctx.config && ctx.config.planner && ctx.config.planner.timezone; return validZone(z) ? String(z) : systemZone(); })();
        let schedule;
        try { schedule = routineSchedule(String(i.when || ""), zone); } catch (e) { throw Object.assign(new Error(/** @type {Error} */ (e).message), { code: "bad_input" }); }
        const every = cron.describe(schedule, zone);
        const json = JSON.stringify({ name, owner: await ownerOf(meta, me), schedule, when: String(i.when).slice(0, 200), instruction: instruction.slice(0, 2000), emits: ROUTINE_EMITS, timeout: 30, memory: false,
          summary: { when: `Runs ${every}`.slice(0, 240), do: instruction.split("\n")[0].slice(0, 240) } }, null, 2);
        const checked = folderMod.checkFiles(name, json, ROUTINE_WATCH_JS);
        if (checked.problems.length) throw Object.assign(new Error(checked.problems.join("; ")), { code: "bad_input" });
        await putDef(name, json, ROUTINE_WATCH_JS);
        rt.ownWritten(name, me);
        const on = rt.routineOn(name);
        const card = rt.card(name); remember(meta, card);
        return { ...on, card, next: "Tell the person in plain words what you set up and when it first runs." };
      },
    });
    // The owning agent manages its own Routines and Watchers (never another agent's or a person's). Pausing is watchers.pause, open to anyone it is shown to.
    tool("watchers.own.resume", {
      callers: [...PEOPLE, "module", ...MODEL],
      description: "Resume one of your own Routines or Watchers. One a person paused stays paused until they resume it.",
      input: named,
      run: async ({ name }, meta = {}) => {
        mustOwn(meta, String(name));
        const r = rt.row(String(name));
        if (r && r.paused && r.paused_by === "person") throw Object.assign(new Error(`a person paused ${name}; only they resume it`), { code: "denied" });
        if (r && r.paused && r.paused_by === "waiting") throw Object.assign(new Error(`${name} turns on when watchers.test passes`), { code: "denied" });
        return rt.resume(String(name), {});
      },
    });
    tool("watchers.own.run", { callers: [...PEOPLE, "module", ...MODEL], description: "Run one of your own Routines or Watchers now and return what happened.", input: named,
      run: async ({ name }, meta = {}) => { mustOwn(meta, String(name)); return rt.run(String(name)); } });
    tool("watchers.own.delete", { callers: [...PEOPLE, "module", ...MODEL], description: "Delete one of your own Routines or Watchers. What it found stays.", input: named,
      run: async ({ name }, meta = {}) => { mustOwn(meta, String(name)); return rt.remove(String(name)); } });

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
    ctx.tool("watchers.shown", { description: "The watcher cards shown in a thread, with the hash each card carried when it was shown: { project, kinds, watchers: [{ name, hash, title, state, project, at }] }. Answered from a record made when watchers.card or watchers.preset served the card, never from the folder now. The assistant's recorder and a paired device read it.", input: { type: "object", required: ["thread"], properties: { thread: str } },
      run: async ({ thread }, meta = {}) => {
        // the same person check the other watcher reads use: a caller sees the cards of the projects it may see (a person, a module and a paired device see all)
        const can = await scopeFor(meta, projectOfCwd, projectOfThread);
        const watchers = shown.list(thread).filter(w => visible(meta, can, w.name, w.project));
        // an agent's own Routines and Watchers asked for in this chat show here for as long as they exist, not only until a restart
        const have = new Set(watchers.map(w => w.name));
        for (const w of rt.list().watchers) if (w.agent && w.thread === thread && !have.has(w.name) && visible(meta, can, w.name, w.project)) watchers.push({ name: w.name, hash: w.hash, title: w.title, state: w.state, project: w.project, at: null });
        return { project: watchers.length ? watchers[watchers.length - 1].project : null, kinds: PRESET_KINDS, watchers };
      } });
    /**
     * An agent's own watcher may use what is lent to its agent and nothing else: each Vault item or Connection it names that is not lent shows as a need, with the
     * item's name, so the person can let the agent use it (Vault, the item, Can use it, without seeing it). Never a value.
     */
    const withNeeds = async (/** @type {any} */ card) => {
      const own = card && card.owner && card.owner.kind === "agent" ? card.owner.agent : null;
      if (!own || !card.facts || !Array.isArray(card.facts.credentials)) return card;
      const needs = [];
      for (const c of card.facts.credentials) {
        let item = String(c.item || "");
        if (item.startsWith("google:")) { const r = await ctx.call("google.accounts", {}).catch(() => null); const a = r && Array.isArray(r.data) ? r.data.find((/** @type {any} */ x) => `google:${x.name}` === item) : null; item = a && a.auth && a.auth.item ? String(a.auth.item) : item; }
        const g = await ctx.call("vault.granted", { name: item, watcher: card.name, agent: own }).catch(() => null);
        if (!(g && g.data && g.data.granted)) needs.push({ item, host: c.host || null });
      }
      return needs.length ? { ...card, needs } : card;
    };
    tool("watchers.card", {
      description: "What to show before a watcher is turned on: when, check and do lines, what it reads, whether it acts, its cost, and the hash.",
      input: named,
      run: async ({ name }, meta = {}) => { await mustSee(meta, name); const c = await withNeeds(rt.card(name)); remember(meta, c); return c; },
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
      run: async ({ name }, meta = {}) => {
        await mustSee(meta, name); const m = /** @type {any} */ (meta);
        const me = callingAgent(m), person = isPerson(m.caller) && !me;
        return rt.pause(name, person ? "paused by you" : `paused by ${me || m.caller || "someone"}`, person ? "person" : me ? `agent:${me}` : "vyre");
      } });
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
        return rt.items({ name, project, limit: Math.min(500, Math.max(1, limit)) }).filter(it => visible(meta, can, it.watcher, it.project));
      },
    });
    // POST /v1/watchers/<name>/hook is retired: a webhook starts a Flow. The tool stays so the old address answers in words, and nothing runs.
    ctx.tool("watchers.hook", {
      hook: true,
      description: "Retired: a webhook starts a Flow now. Answers that, and runs nothing.",
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
