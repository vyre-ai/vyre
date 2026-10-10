// @ts-check
// planner: alarms, timers, reminders, todos, notes and a calendar, kept on the box so something rings
// when the Mac is shut (docs/adr/0025-planner.md). The planner keeps no tables: reminders and notes
// are the Space's Reminder and Note records, to-dos are its Tasks, the calendar is its Event records
// (records.js). One scheduler (scheduler.js) reads them, and delivery is one event, planner.fired,
// that push, the Capsule and the Deck each act on. A Mac paired with a box forwards every tool there
// and keeps its scheduler idle; an unpaired Mac runs the planner itself.

import { KINDS, STATES, shape, shapeFiring, newId, ringKey, readKey } from "./items.js";
import { openRecords, fromEvent, recordOf } from "./records.js";
import { parseRule } from "./rrule.js";
import { MIGRATIONS as LEGACY_MIGRATIONS, importLegacy } from "./legacy.js";
import { Scheduler, nextFire, zoneOf } from "./scheduler.js";
import { taskEscalation } from "./escalate.js";
import { calendar, shapeCal } from "./events.js";
import { zoneFrom } from "../../lib/time/index.js";
import { validZone, systemZone, parseDate, parseWall, dateString, wallString, localDate, localParts, toUTC, addDays, checkRepeat, nextOccurrence } from "./time.js";
import { callerKind, agentClaim } from "../modules/index.js";
import { cloudGate } from "../../lib/cloud-gate.js";
import { isPerson } from "../../lib/caller.js";

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: a fake clock and timer. Anything left
 * out uses the real thing.
 * @type {Map<string, { now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }>}
 */
export const seams = new Map();

const PEOPLE = ["cli", "local", "deck", "capsule"];
/** The callers that are a person's own device in hand: their zone is where they are. (A shell on a server is the server's zone, which is never used.) */
const FOLLOWS = new Set(["cli", "local", "deck", "capsule", "tailnet", "device"]);
const AGENTS = ["mcp", "module", "harness"];
/** What an agent may add with no permission (the user's rule): everything but an event, which is an invite. */
const AGENT_KINDS = ["alarm", "timer", "reminder", "todo", "note", "task"];
/** A runaway guard, not a limit anyone should meet: adds an hour from one agent. */
const AGENT_CAP = 200;
const TIMED = ["alarm", "timer", "reminder", "event"];
const LINK_CODES = ["box_unreachable", "no_link", "unreachable", "timeout", "not_box", "unpaired"];
const MAX_TIMER = 30 * 86_400_000;

/** An instant from a number (ms) or an ISO string that names its offset. */
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

const fail = (message, code = "bad_input") => Object.assign(new Error(message), { code });

/** The parser, if its file is there: another team writes parse.js, and the planner works without it. */
async function loadParser(log) {
  try {
    const m = await import("./parse.js");
    return typeof m.parse === "function" ? m.parse : null;
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes("parse.js")) return null;
    log(`planner: parse.js did not load (${err && err.message}); planner.parse answers null`);
    return null;
  }
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // The planner's data is the Space's records. With no kernel there is nowhere to keep it: the tools are still declared (so they are listed and documented) and each answers, plainly, that the kernel is off.
    const K = ctx.kernel || null;
    const offline = { space: null, owner: null, serviceChain: () => { throw fail("the planner keeps its records in the kernel, which is off here", "unavailable"); } };
    const seam = seams.get(ctx.paths && ctx.paths.root) || {};
    const now = seam.now || Date.now;
    const role = ctx.config && ctx.config.role === "box" ? "box" : "local";
    const parser = await loadParser(ctx.log);
    const st = await openRecords({ K: K || offline, now, log: ctx.log, onExternal: (row, how) => external(row, how), zone: () => settings().timezone });
    // An upgraded box still has the planner's old tables: their list stays registered (a module's migration list is append-only) and the tables stay. What is in them moves into Records once (legacy.js).
    if (ctx.store && ctx.store.migrate) ctx.store.migrate(LEGACY_MIGRATIONS);
    if (K) { await importLegacy({ db: ctx.store && ctx.store.db, K, log: ctx.log }); await st.load(); }

    // The zone is read only when something needs it: the first zoned Intl call loads ICU's time
    // zone data (about 8 MB of RSS), which an idle planner never needs.
    let zone = /** @type {string|null} */ (null);
    const defaultZone = () => zone ??= (ctx.config && ctx.config.planner && validZone(ctx.config.planner.timezone) && String(ctx.config.planner.timezone)) || systemZone();
    /** @returns {import("./scheduler.js").Settings} */
    const settings = () => {
      const { timezone, ...kept } = st.state.get("settings") || {};
      const out = /** @type {any} */ ({ escalate_after: 5, escalate_max: 3, event_lead: 10, follow_device: true, ...kept });
      return Object.defineProperty(out, "timezone", { enumerable: true, get: () => timezone || defaultZone() });
    };

    const emit = (type, payload, item) => {
      try { ctx.events.emit(type, payload, { ...(item && item.project ? { project: item.project } : {}), ...(item && item.thread ? { thread: item.thread } : {}) }); }
      catch (e) { ctx.log(`planner: ${type} not emitted (${/** @type {Error} */ (e).message})`); }
    };

    // /later's own name for its creator: "agent:<name>" is the shape core/planner already gives
    // an agent's own items (who(), above); a person's or a module's source runs with no agent
    // scope at all (ambient), same as any session a person starts themselves.
    const AGENT_SOURCE = /^agent:(.+)$/;

    /**
     * Run a task item: rule 1, it runs with its creator's own scope, never more. An existing
     * thread already carries its own scope (threads.post is just a turn in it); a fresh one
     * (threads.launch) is given the creator's agent name, so it gets that agent's credentials
     * and projects.access, exactly as if that agent had started it itself - never the planner's.
     * Records run_count and last_result either way, so a recurring task's history is visible
     * (rule 2) even when nobody is watching it fire.
     */
    const runTask = async item => {
      if (item.paused) return;
      const text = item.body || item.title;
      const agent = AGENT_SOURCE.exec(item.source || "")?.[1] || null;
      let ok = true, note = "";
      try {
        // MEDIUM (reviewer, 2026-09-28): re-check scope right before it fires, not only at add or
        // edit time - an agent's projects.access can shrink (or the agent be deleted) any time
        // between scheduling a task and it going off. threads.launch trusts whatever project it is
        // given (it's internal, module-to-module), so this is the one place that would catch it.
        if (agent && item.project) {
          const projects = await agentProjects(agent);
          if (!projects || (projects !== "*" && !projects.includes(item.project))) {
            throw fail(`${agent} no longer has access to ${item.project}`, "denied");
          }
        }
        const r = item.thread
          ? await ctx.call("threads.post", { thread: item.thread, text, kind: "scheduled", from: "planner" })
          : agent
            ? await ctx.call("agents.job", { agent, prompt: text, ...(item.project ? { project: item.project } : {}) })
            : await ctx.call("threads.launch", { project: item.project || undefined, prompt: text, purpose: "job", once: true });
        if (r.error) { ok = false; note = r.error.message; }
      } catch (e) { ok = false; note = /** @type {Error} */ (e).message; }
      const last_result = (ok ? "ok" : `error: ${note}`).slice(0, 300);
      st.patch(item.id, { run_count: (item.run_count || 0) + 1, last_result });
      emit("planner.task-run", { item: item.id, ok, result: last_result }, item);
    };

    const scheduler = new Scheduler({ st, settings, now, setTimer: seam.setTimer, clearTimer: seam.clearTimer, log: ctx.log,
      fired: (f, item) => {
        emit("planner.fired", { firing: f.id, key: ringKey(item.id, f.due), item: item.id, kind: item.kind, title: item.title, due: f.due, ring: f.ring,
          missed: Boolean(f.missed), actions: ["done", "snooze"], ...(item.source_name ? { added_by: item.source_name } : {}) }, item);
        // Reviewer, 2026-09-28: fireItem already sets next_ring null for a task, so nothing should
        // ring it a second time - but this is the one place that actually runs the model-written
        // instruction, so it stays fail-safe on its own: only ever the first ring of a firing,
        // never an escalation, in case a firing is ever re-delivered some other way.
        if (item.kind === "task" && f.ring === 1) runTask(item).catch(e => ctx.log(`planner: task ${item.id} did not run (${e.message})`));
      } });

    // Chained tasks ("when X finishes, do Y"): X's own done is the trigger, not a time, so this
    // runs outside the scheduler entirely. A task fires once per its own dependency's done - it
    // is not rearmed unless a person or an agent points waits_on at a new item.
    //
    // Bug fix: the chained task's own state stays "open" forever (running it does not finish it),
    // so matching on "waits_on = X AND state = open" alone fires again every time X's state field
    // changes to done - including reopening X and finishing it a second time, which is the same
    // dependency, not a new one. waits_on_fired records WHICH done_at this task last ran for;
    // done_at is fresh every time an item newly reaches done (never reused across a reopen), so
    // comparing against it tells "the same completion, already handled" from "a later one" without
    // needing to touch the task's own state.
    ctx.events.on("planner.changed", async e => {
      if (!e.payload || !Array.isArray(e.payload.fields) || !e.payload.fields.includes("state")) return;
      const done = st.item(e.payload.item);
      if (!done || done.state !== "done" || done.done_at == null) return;
      for (const row of /** @type {any[]} */ (st.waitingOn(e.payload.item))) {
        if (row.waits_on_fired === done.done_at) continue; // already ran for this exact completion
        st.patch(row.id, { waits_on_fired: done.done_at });
        await runTask(shape(row)).catch(err => ctx.log(`planner: chained task ${row.id} did not run (${err.message})`));
      }
    });

    // ---- The Mac's side: paired means the box keeps the planner. -----------------------------
    let linked = false;
    const checkLink = async () => {
      if (role !== "local") return false;
      const r = await ctx.call("link.status", {});
      const was = linked;
      linked = Boolean(r && r.data && r.data.linked);
      if (linked && !was) scheduler.stop();
      if (!linked && was) { scheduler.start(); cal.sync().catch(() => {}); }
      return linked;
    };
    const offs = [];
    if (role === "local") {
      offs.push(ctx.events.on("link.paired", () => { checkLink().catch(() => {}); }));
      offs.push(ctx.events.on("link.unpaired", () => { checkLink().catch(() => {}); }));
    }
    const forward = async (tool, input) => {
      const r = await ctx.remote(tool, input);
      if (r && r.error) {
        const link = LINK_CODES.includes(r.error.code);
        throw fail(link ? `the box is not reachable (${r.error.code})` : r.error.message, link ? "box_unreachable" : r.error.code);
      }
      return r ? r.data : null;
    };

    // ---- Time ---------------------------------------------------------------------------------

    /**
     * Turn what a caller gave (at, in_ms, wall, date, repeat, due, tz, floating) into the item's time
     * columns. Throws a readable error for what cannot be placed.
     */
    const resolveTime = (kind, i, s, t) => {
      const floating = i.floating !== undefined ? Boolean(i.floating) : kind === "alarm" || kind === "timer";
      if (i.tz !== undefined && i.tz !== null && !validZone(i.tz)) throw fail(`${i.tz} is not a time zone`);
      const zone = floating ? s.timezone : String(i.tz || s.timezone);
      const out = /** @type {any} */ ({ floating, tz: floating ? null : zone, at: null, wall: null, date: null, repeat: null, due: null, duration_ms: null });
      if (kind === "note") return out;
      if (kind === "timer") {
        const ms = Number(i.in_ms ?? i.duration_ms);
        if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMER) throw fail("a timer needs in_ms: at least a second, at most 30 days");
        return { ...out, at: t + Math.round(ms), duration_ms: Math.round(ms) };
      }
      let date = null, wall = null, at = null;
      const take = v => {
        if (v === undefined || v === null || v === "") return;
        if (typeof v === "number") { at = v; return; }
        const str = String(v).trim();
        if (parseDate(str)) { date = str; return; }
        const m = LOCAL_ISO.exec(str);
        if (m && !ZONED.test(str)) { date = m[1]; wall = m[2]; return; }
        // Date.parse reads almost anything with a number in it ("tomorrow at 9" is a day in 2001),
        // so trust it only with a year in the text.
        const ms = /\b\d{4}\b/.test(str) ? Date.parse(str) : NaN;
        if (!Number.isNaN(ms)) { at = ms; return; }
        // Words, as people say a time: "6pm" is the next 6pm in the item's zone, "tomorrow at 9",
        // "in 20 minutes". The parser reads them as a reminder's time.
        const said = atWords(str, zone, t);
        if (said == null) throw fail(`"${str}" is not a time (an ISO time, YYYY-MM-DD, or words like 6pm or tomorrow at 9)`);
        at = said;
      };
      take(i.at);
      if (kind === "todo" && i.due !== undefined) take(i.due);
      if (i.date !== undefined && i.date !== null) { if (!parseDate(i.date)) throw fail(`"${i.date}" is not a date (YYYY-MM-DD)`); date = String(i.date); }
      if (i.wall !== undefined && i.wall !== null) { const w = parseWall(i.wall); if (!w) throw fail(`"${i.wall}" is not a time (HH:MM)`); wall = wallString(w); }
      let repeat = null;
      try { repeat = checkRepeat(i.repeat); } catch (e) { throw fail(/** @type {Error} */ (e).message); }

      if (at != null) { const p = localParts(at, zone); date = dateString(p); wall = wallString(p); }
      else if (wall && date) at = toUTC(/** @type {any} */ (parseDate(date)), /** @type {any} */ (parseWall(wall)), zone);
      else if (wall) {
        at = nextOccurrence({ wall, tz: zone, after: t, repeat });
        if (at == null) throw fail("that rule has no time left to ring");
        date = dateString(localDate(at, zone));
      }
      if (repeat) {
        if (!wall) throw fail("a repeating item needs a time of day (wall, or at)");
        repeat = { ...repeat, start: repeat.start || date };
        const first = nextOccurrence({ wall, tz: zone, after: t - 1, repeat });
        if (first == null) throw fail("that rule has no time left to ring");
        at = first;
      }
      if (kind === "todo") return { ...out, at: wall ? at : null, wall, date, repeat, due: date };
      if (at == null && date && TIMED.includes(kind)) throw fail(`a ${kind} needs a time of day (wall "HH:MM") with its date`);
      if (at == null && TIMED.includes(kind)) throw fail(`a ${kind} needs a time: at, or wall (and date)`);
      if (at != null && at < t && !repeat && (kind === "alarm" || kind === "reminder")) throw fail("that time has already passed");
      return { ...out, at, wall, date, repeat };
    };

    /** A time in words to an instant, or null: "6pm", "tomorrow at 9", "in 20 minutes", "7:30". */
    const atWords = (str, zone, t) => {
      if (!parser || str.length > 80) return null;
      for (const text of [`remind me x ${str}`, `remind me x at ${str}`]) {
        try {
          const p = parser(text, { now: t, tz: zone });
          if (p && !p.ambiguous && typeof p.at === "number" && !p.repeat) return p.at;
        } catch {}
      }
      return null;
    };

    /** An item's next_fire (and at, for a repeat) as of now. */
    const schedule = (row, t = now()) => { const n = nextFire(row, t, settings()); return { at: n.at, next_fire: n.next }; };

    // ---- Who may do what ----------------------------------------------------------------------

    // The user's rule: anyone, agents included, adds alarms, timers, reminders, todos and notes
    // with no prompt. The person changes anything; an agent changes only what it added. An item
    // keeps who added it (source), and shows a name (added_by) only when that was neither the
    // person nor their assistant.
    //
    // isPerson used to be `callerAllowed(PEOPLE, caller)`, which never refused an agent claim
    // first (the same backwards shape reviewer caught in goals) - swapped onto lib/caller.js's
    // isPerson (cohesion, 2026-09-28), intentionally STRICTER, not identical: "cli agent:kit" and
    // "cli:thread:x" both used to read as the person here and no longer do (reviewer, 2026-09-28).

    /** The assistant's name, read from agents.list at most once a minute. */
    let assistant = { name: /** @type {string|null} */ (null), at: -Infinity };
    const isAssistant = async name => {
      if (Date.now() - assistant.at > 60_000) {
        const r = await ctx.call("agents.list", {}).catch(() => null);
        const a = r && Array.isArray(r.data) ? r.data.find(x => x && x.kind === "assistant") : null;
        assistant = { name: a ? String(a.name) : null, at: Date.now() };
      }
      return assistant.name === name;
    };

    /**
     * Who a call is from: { person, source, name, thread }. A paired Mac passes an agent's
     * identity on as `as`, which only a person's call (the Mac's link arrives as the owner) may
     * carry - `as.thread` rides along the same way, so taskScope sees the ORIGINAL calling thread
     * on the box, not the Mac-to-box link call's own (meaningless, for this) thread.
     * @param {string} thread the caller's own calling thread (vyred's meta.thread), direct or none
     * @returns {Promise<{ person: boolean, source: string, name: string|null, thread: string|null, chain?: any }>}
     */
    const who = async (i, caller, thread = null, agent = null) => {
      if (isPerson(caller)) {
        const as = i && i.as && typeof i.as === "object" ? i.as : null;
        if (as && as.source) return { person: false, source: String(as.source).slice(0, 120), name: as.name ? String(as.name).slice(0, 80) : null, thread: as.thread ? String(as.thread).slice(0, 120) : null };
        return { person: true, source: callerKind(caller), name: null, thread };
      }
      const c = String(caller);
      if (c.startsWith("module:")) return { person: false, source: c.slice(0, 120), name: null, thread };
      // A Vyre-owned session's thread (ADR 0030, in-process tools): the person's assistant, as an
      // unnamed terminal session is, so what one thread adds another may change.
      // The session is what the daemon vouched (meta.thread, meta.agent), never the `:thread:<id>` or `:agent:<name>` text of a label (RC-1). The label only says which surface (mcp or harness); the claim text is read only when no verified meta came with the call (SHIM: kernel off).
      const claim = typeof agent === "string" && agent ? agent : (agent === null && !thread ? agentClaim(c) : null);
      if (!claim && thread && /^(mcp|harness)(?::|$)/.test(c)) return { person: false, source: c.slice(0, /[:]/.test(c) ? c.indexOf(":") : c.length), name: null, thread };
      // An unnamed MCP or harness caller is the person's own Claude session: their assistant.
      if (!claim) return { person: false, source: callerKind(caller), name: null, thread };
      return { person: false, source: `agent:${claim}`, name: (await isAssistant(claim)) ? null : claim, thread };
    };

    const agentKind = (kind, w) => {
      if (w.person) return;
      if (!AGENT_KINDS.includes(kind)) throw fail(`an agent may add alarms, timers, reminders, todos, notes and tasks, not ${kind}s`, "denied");
    };

    /** The projects a named agent may reach, from core/agents' own record: "*" for every one, a
     * list of slugs, or null when no such agent exists. */
    const agentProjects = async name => {
      const r = await ctx.call("agents.list", {}).catch(() => null);
      const a = r && Array.isArray(r.data) ? r.data.find(x => x && x.name === name) : null;
      return a ? a.projects : null;
    };

    /**
     * Reviewer HIGH 1+2, 2026-09-28: a task is the one kind that fires later, unattended, running
     * text a model wrote - into a thread, or a fresh ambient session. Every other kind an agent (or
     * a bare model session) adds only ever rings for whoever is watching; a task can act on
     * another thread's behalf, or launch with the person's own full scope, if let through
     * unchecked. So: only a person, or a caller with a genuinely claimed agent identity (never a
     * bare mcp/harness caller, a thread-scoped one with no claim, or a module - none of which the
     * person actually named), may add or redirect one, and its target - the thread it posts into,
     * or the project it launches under - must be inside exactly that identity's own scope. Called
     * again right before it fires (runTask), not only when it was added or last edited, so a
     * project removed from the agent afterward is caught too.
     * @param {{thread?: string|null, project?: string|null}} target
     * @param {{person: boolean, source: string, thread?: string|null}} w
     */
    const taskScope = async (target, w) => {
      if (w.person) return;
      if (!w.source.startsWith("agent:")) throw fail("a task needs a person, or a named agent's own claim", "denied");
      if (target.thread) {
        if (target.thread !== w.thread) throw fail("an agent's task may only target its own calling thread", "denied");
        return;
      }
      if (target.project) {
        const name = w.source.slice("agent:".length);
        const projects = await agentProjects(name);
        if (!projects || (projects !== "*" && !projects.includes(target.project))) throw fail(`${name} has no access to ${target.project}`, "denied");
        return;
      }
      throw fail("an agent's task needs a thread (its own) or a project it can reach", "denied");
    };
    /** An agent may change, finish, snooze or delete only what it added. */
    const owns = (item, w) => {
      if (w.person || (item && item.source === w.source)) return;
      // A to-do the person gave to this assistant is the assistant's to finish.
      if (item && item._task && item.assignee && w.source === `agent:${item.assignee}`) return;
      throw fail("an agent may change only the items it added", "denied");
    };

    /** Adds in the last hour, by agent. Silent: nobody is told the number. */
    const recent = new Map();
    const capped = w => {
      if (w.person) return;
      const t = now();
      const seen = (recent.get(w.source) || []).filter(x => x > t - 3_600_000);
      recent.set(w.source, seen);
      if (seen.length >= AGENT_CAP) throw fail("too many items added in the last hour; try again later", "busy");
    };
    const counted = w => { if (!w.person) recent.get(w.source)?.push(now()); };

    // ---- Items --------------------------------------------------------------------------------

    const clip = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));
    const tagsOf = v => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) throw fail("tags is a list of words");
      return [...new Set(v.map(x => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
    };
    const priorityOf = v => {
      if (v === undefined || v === null) return 0;
      const p = Number(v);
      if (!Number.isInteger(p) || p < 0 || p > 3) throw fail("priority is 0 to 3");
      return p;
    };

    /** Read free text with the parser, if there is one. */
    const parseText = (text, t = now(), kind = undefined) => {
      if (!parser) return null;
      try { return parser(String(text), { now: t, tz: settings().timezone, ...(kind ? { kind } : {}) }) || null; }
      catch (e) { ctx.log(`planner: parse failed (${/** @type {Error} */ (e).message})`); return null; }
    };

    const add = async (i, w) => {
      const t = now();
      let input = { ...i };
      if (typeof i.text === "string" && i.text.trim()) {
        const p = parseText(i.text, t, i.kind);
        if (p && p.ambiguous) throw fail(p.reason || "those words do not say when", "ambiguous");
        const given = Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k !== "text"));
        input = { ...(p || {}), ...given, title: given.title ?? (p && p.title) ?? i.text.trim() };
      }
      const kind = input.kind || "note";
      if (!KINDS.includes(kind)) throw fail(`kind is one of ${KINDS.join(", ")}`);
      agentKind(kind, w);
      if (kind === "task") await taskScope({ thread: input.thread || null, project: input.project || null }, w);
      capped(w);
      const s = settings();
      const time = resolveTime(kind, input, s, t);
      let title = String(input.title ?? "").trim().slice(0, 500);
      if (!title) title = kind === "alarm" ? "Alarm" : kind === "timer" ? "Timer" : "";
      if (!title) throw fail(`a ${kind} needs a title`);
      if (input.parent && !(st.item(input.parent) && st.item(input.parent)._task && kind === "todo")) throw fail("a to-do's parent is another to-do", "not_found");
      if (input.waits_on && !st.item(input.waits_on)) throw fail("no such item to wait on", "not_found");
      // Only the person gives a to-do to an assistant; the assistant then finishes it as its doer.
      const assignee = input.assignee ? String(input.assignee).slice(0, 80) : null;
      if (assignee) {
        if (kind !== "todo") throw fail("only a to-do is given to an assistant");
        if (!w.person) throw fail("only the person gives a to-do to an assistant", "denied");
        if (await agentProjects(assignee) === null) throw fail(`no assistant or agent named ${assignee}`, "not_found");
      }
      if (kind !== "event" && (input.rrule || input.url)) throw fail("rrule and url are for events: a reminder repeats with repeat");
      if (kind === "event") return addEvent({ ...input, title, at: time.at, tz: time.tz || undefined }, w, t);
      const row = { id: newId("i"), kind, title, body: clip(input.body, 100_000), list: clip(input.list, 80), priority: priorityOf(input.priority),
        parent: input.parent ? String(input.parent) : null, project: clip(input.project, 120), thread: clip(input.thread, 120),
        tags: tagsOf(input.tags), pinned: Boolean(input.pinned), state: "open", ...time, created: t, updated: t, source: w.source, source_name: w.name,
        waits_on: input.waits_on ? String(input.waits_on) : null, paused: Boolean(input.paused), assignee };
      const n = schedule(row, t);
      if (row.repeat) row.at = n.at;
      const made = await st.create({ ...row, next_fire: n.next_fire }, w);
      counted(w);
      emit("planner.added", { item: made.id, kind, title, ...(made.at != null ? { at: made.at } : {}), ...(w.name ? { added_by: w.name } : {}) }, made);
      scheduler.arm();
      return shape(st.item(made.id));
    };

    /** An event's rule and link as the record keeps them: undefined when not given, null to clear, else checked. */
    const rruleOf = v => {
      if (v === undefined) return undefined;
      if (v === null || String(v).trim() === "") return null;
      try { parseRule(String(v)); } catch (e) { throw fail(`rrule: ${/** @type {Error} */ (e).message}`); }
      return String(v).trim().replace(/^RRULE:/i, "");
    };
    const urlOf = v => {
      if (v === undefined) return undefined;
      if (v === null || String(v).trim() === "") return null;
      const u = String(v).trim().slice(0, 2000);
      if (!/^https?:\/\/\S+$/.test(u)) throw fail("url is a web address (https://...)");
      return u;
    };

    /** An event of the planner's own: an Event record (source "vyre"), the same record a connector's sync writes for an outside event. */
    const addEvent = async (input, w, t) => {
      const tz = input.tz || settings().timezone;
      if (input.at == null) throw fail("an event needs a start");
      const end = input.end != null ? input.end : input.at + (input.duration_ms ? Number(input.duration_ms) : 3_600_000);
      const rrule = rruleOf(input.rrule), url = urlOf(input.url);
      const row = await st.cal.create({ title: input.title, starts_at: new Date(input.at).toISOString(), ends_at: new Date(end).toISOString(), all_day: false, time_zone: tz, source: "vyre",
        ...(input.where ? { place: clip(input.where, 500) } : {}), ...(rrule ? { rrule } : {}), ...(url ? { url } : {}) }, w.person ? w.chain : undefined);
      const shown = cal.add({ ...row, own: true });
      counted(w);
      emit("planner.added", { item: row.id, kind: "event", title: input.title, at: input.at, ...(w.name ? { added_by: w.name } : {}) }, { project: input.project, thread: input.thread });
      void t;
      return { ...shapeCal(shown), tz, project: input.project ?? null, thread: input.thread ?? null, added_by: w.name ?? null };
    };

    const EDITABLE = ["title", "body", "list", "priority", "pinned", "tags", "project", "thread", "parent", "state", "waits_on", "paused"];
    const TIME_FIELDS = ["at", "in_ms", "wall", "date", "repeat", "tz", "floating", "due"];

    /** Change one of the planner's own events: its Event record. An outside calendar's event is changed on that calendar. */
    const updateEvent = async (row, i, w) => {
      if (!w.person) throw fail("an agent may change only the items it added", "denied");
      if (!row.own) throw fail("that event belongs to an outside calendar: change it there", "denied");
      const patch = {};
      if (i.title !== undefined) { const title = String(i.title).trim().slice(0, 500); if (!title) throw fail("the title cannot be empty"); patch.title = title; }
      if (i.where !== undefined) patch.place = clip(i.where, 500);
      const rrule = rruleOf(i.rrule), url = urlOf(i.url);
      if (rrule !== undefined) patch.rrule = rrule;
      if (url !== undefined) patch.url = url;
      const timed = i.at !== undefined || i.date !== undefined || i.wall !== undefined;
      if (timed) {
        const time = resolveTime("event", { at: i.at, date: i.date, wall: i.wall, tz: i.tz }, settings(), now());
        patch.starts_at = new Date(time.at).toISOString();
        patch.ends_at = new Date(time.at + (row.end != null ? row.end - row.start : 3_600_000)).toISOString();
      }
      const made = await st.cal.update(row.rec ?? recordOf(row.id), patch);
      const shown = cal.add({ ...made, own: true });
      emit("planner.changed", { item: row.rec ?? row.id, kind: "event", fields: Object.keys(patch) }, {});
      return shapeCal(shown);
    };

    const update = async (i, w) => {
      const ev = cal.row(i.item);
      if (ev && !st.item(i.item)) return updateEvent(ev, i, w);
      const item = st.item(i.item);
      if (!item || item.deleted_at) throw fail("no such item", "not_found");
      owns(item, w);
      if (i.kind !== undefined && i.kind !== item.kind) throw fail("an item's kind does not change; add a new one");
      // HIGH 2 (reviewer, 2026-09-28): a task's own thread/project is exactly what taskScope
      // checked at add time - letting an agent redirect it afterward with planner.update would be
      // the same confused-deputy escape through the back door. Re-check with whatever the patch
      // leaves it as (the new value if given, else its current one).
      if (item.kind === "task" && (i.thread !== undefined || i.project !== undefined)) {
        await taskScope({ thread: i.thread !== undefined ? (i.thread || null) : item.thread, project: i.project !== undefined ? (i.project || null) : item.project }, w);
      }
      const t = now();
      const patch = /** @type {any} */ ({});
      if (i.title !== undefined) { patch.title = String(i.title).trim().slice(0, 500); if (!patch.title) throw fail("the title cannot be empty"); }
      if (i.body !== undefined) patch.body = clip(i.body, 100_000);
      if (i.list !== undefined) patch.list = clip(i.list, 80);
      if (i.priority !== undefined) patch.priority = priorityOf(i.priority);
      if (i.pinned !== undefined) patch.pinned = Boolean(i.pinned);
      if (i.tags !== undefined) patch.tags = tagsOf(i.tags);
      if (i.project !== undefined) patch.project = clip(i.project, 120);
      if (i.thread !== undefined) patch.thread = clip(i.thread, 120);
      if (i.parent !== undefined) { if (i.parent && !st.item(i.parent)) throw fail("no such parent item", "not_found"); patch.parent = i.parent || null; }
      if (i.waits_on !== undefined) { if (i.waits_on && !st.item(i.waits_on)) throw fail("no such item to wait on", "not_found"); patch.waits_on = i.waits_on || null; }
      if (i.paused !== undefined) patch.paused = Boolean(i.paused);
      if (i.state !== undefined) {
        if (!STATES.includes(i.state)) throw fail(`state is one of ${STATES.join(", ")}`);
        patch.state = i.state;
        patch.done_at = i.state === "open" ? null : t;
      }
      const timeChanged = TIME_FIELDS.some(k => i[k] !== undefined);
      if (timeChanged) {
        const old = shape(item);
        const keepRepeat = old.repeat && i.date === undefined && i.at === undefined ? old.repeat : old.repeat ? { ...old.repeat, start: undefined } : null;
        const ti = {
          at: i.at, in_ms: i.in_ms, due: i.due,
          wall: i.wall ?? (i.at === undefined && i.due === undefined ? old.wall : undefined),
          date: i.date ?? (i.at === undefined && i.wall === undefined && i.due === undefined ? old.date : undefined),
          repeat: i.repeat !== undefined ? i.repeat : keepRepeat && JSON.parse(JSON.stringify(keepRepeat)),
          tz: i.tz ?? old.tz, floating: i.floating ?? old.floating,
        };
        if (item.kind === "timer" && ti.in_ms === undefined) throw fail("give a timer a new in_ms");
        Object.assign(patch, resolveTime(item.kind, ti, settings(), t), { snooze_until: null });
      }
      patch.updated = t;
      const next = { ...item, ...patch, tags: JSON.stringify(patch.tags ?? JSON.parse(item.tags)), repeat: patch.repeat !== undefined ? (patch.repeat ? JSON.stringify(patch.repeat) : null) : item.repeat };
      if (timeChanged || patch.state !== undefined) {
        const n = schedule(next, t);
        patch.next_fire = n.next_fire;
        if (next.repeat && n.at != null) patch.at = n.at;
      }
      st.patch(item.id, patch, w);
      if (patch.state && patch.state !== "open") cancelRinging(item.id);
      emit("planner.changed", { item: item.id, kind: item.kind, fields: Object.keys(patch).filter(k => k !== "updated") }, next);
      scheduler.arm();
      return shape(st.item(item.id));
    };

    /** The firing and item an acknowledgement is about: a firing id, or an item and its live firing. */
    const target = i => {
      if (i.key !== undefined && !i.firing) {
        const k = readKey(i.key);
        if (!k) throw fail("key is planner-<item>-<due in seconds>");
        const item = st.item(k.item);
        if (!item || item.deleted_at) throw fail("no such item", "not_found");
        return { f: st.firingAt(item.id, k.due) || null, item, due: k.due };
      }
      if (i.firing) {
        const f = st.firing(i.firing);
        if (!f) throw fail("no such firing", "not_found");
        return { f, item: st.item(f.item) };
      }
      if (!i.item) throw fail("give firing or item");
      const item = st.item(i.item);
      if (!item || item.deleted_at) throw fail("no such item", "not_found");
      return { f: st.ringing(item.id) || null, item };
    };

    const ack = (f, action, w, until = null) => {
      st.patchFiring(f.id, { state: "acked", acked_at: now(), action, by: w.source, until, next_ring: null });
      emit("planner.acked", { firing: f.id, key: ringKey(f.item, f.due), item: f.item, due: f.due, action, by: w.source, ...(until ? { until } : {}) }, st.item(f.item));
    };
    /**
     * An answer to a ring the box has not rung: a device rang it from its own schedule while the
     * box was out of reach, and its outbox sends the answer by key. It is kept as an answered
     * firing, so the box never rings that moment, and the ack clears the ring on other devices.
     */
    const answerUnrung = (item, kind, due, action, w, until = null) => {
      const t = now();
      const f = { id: newId("f"), item, kind, due, ring: 0, missed: false, state: "acked", fired_at: t, next_ring: null };
      st.insertFiring(f);
      st.patchFiring(f.id, { acked_at: t, action, by: w.source, until });
      emit("planner.acked", { firing: f.id, key: ringKey(item, due), item, due, action, by: w.source, unrung: true, ...(until ? { until } : {}) },
        st.item(item));
      return st.firing(f.id);
    };
    /** Stop any ring for an item that has ended; surfaces drop the banner on the ack. */
    const cancelRinging = id => {
      const f = st.ringing(id);
      if (!f) return;
      st.patchFiring(f.id, { state: "cancelled", next_ring: null, acked_at: now(), action: "dismiss" });
      emit("planner.acked", { firing: f.id, key: ringKey(id, f.due), item: id, due: f.due, action: "dismiss", by: "planner" }, st.item(id));
    };
    const already = f => ({ already: true, firing: f.id, state: f.state, action: f.action ?? null });

    /** A ring for a cached calendar event: its firing (by firing id, or the row's live one) and row, or null. */
    const calTarget = i => {
      if (i.key !== undefined && !i.firing) {
        const k = readKey(i.key);
        const row = k ? cal.row(k.item) : null;
        return row ? { f: st.firingAt(row.id, /** @type {any} */ (k).due) || null, row, due: /** @type {any} */ (k).due } : null;
      }
      if (i.firing) {
        const f = st.firing(i.firing);
        if (!f || st.item(f.item)) return null;
        const row = cal.row(f.item);
        return row ? { f, row } : null;
      }
      const row = i.item ? cal.row(i.item) : null;
      return row ? { f: st.ringing(row.id) || null, row } : null;
    };
    /** done, snooze or dismiss on a calendar event's ring: the copy is read-only, so only the ring changes. */
    const calAck = (c, action, w, minutes) => {
      // A calendar copy is nobody's to add, so no agent owns its ring.
      if (!w.person) throw fail("an agent may change only the items it added", "denied");
      if (c.f && c.f.state !== "ringing") return already(c.f);
      let until = null;
      if (action === "snooze") {
        const m = minutes === undefined ? 9 : Number(minutes);
        if (!Number.isFinite(m) || m < 1 || m > 7 * 1440) throw fail("minutes is 1 to 10080");
        until = now() + Math.round(m * 60_000);
        cal.snooze(c.row.id, until);
      } else cal.clearSnooze(c.row.id);
      if (c.f) ack(c.f, action, w, until);
      else if (c.due != null) c.f = answerUnrung(c.row.id, "event", c.due, action, w, until);
      else if (action === "dismiss") throw fail("nothing is ringing for that event", "not_found");
      return { item: shapeCal(cal.row(c.row.id)), firing: c.f ? shapeFiring(st.firing(c.f.id)) : null, ...(until ? { until } : {}) };
    };
    const oneOffEnds = item => !item.repeat;

    const done = (i, w) => {
      const c = calTarget(i);
      if (c) return calAck(c, "done", w);
      const { f, item, due } = target(i);
      if (!item) throw fail("that firing's item is gone", "not_found");
      owns(item, w);
      if ((i.firing || due != null) && f && f.state !== "ringing") return already(f);
      const t = now();
      if (f && f.state === "ringing") ack(f, "done", w);
      const unrung = !f && due != null ? answerUnrung(item.id, item.kind, due, "done", w) : null;
      if (item._task && item.repeat) {
        // A repeating to-do is a series of Tasks: this one is finished and the next is made for the next time its rule names.
        if (item.state === "open") {
          st.patch(item.id, { state: "done", done_at: t, next_fire: null, snooze_until: null, updated: t }, w);
          emit("planner.changed", { item: item.id, kind: item.kind, fields: ["state", "done_at"] }, item);
          spawning.push(nextOccurrence_(item, t, w));
        }
      } else if (item.repeat) {
        // A repeating item keeps going. Done with nothing ringing is done for this time round; by
        // key, only when that time is the one it waits for.
        const patch = /** @type {any} */ ({ snooze_until: null, updated: t });
        if (!f && item.next_fire != null && (due == null || due >= item.next_fire)) patch.next_fire = nextFire(item, Math.max(t, item.next_fire), settings()).next;
        st.patch(item.id, patch);
        emit("planner.changed", { item: item.id, kind: item.kind, fields: Object.keys(patch).filter(k => k !== "updated") }, item);
      } else if (item.state === "open") {
        st.patch(item.id, { state: "done", done_at: t, next_fire: null, snooze_until: null, updated: t }, w);
        emit("planner.changed", { item: item.id, kind: item.kind, fields: ["state", "done_at"] }, item);
      }
      scheduler.arm();
      const g = f || unrung;
      return { item: shape(st.item(item.id)), firing: g ? shapeFiring(st.firing(g.id)) : null };
    };

    /** @type {Promise<any>[]} the next occurrences a done repeating to-do is making (the tool waits for them) */
    const spawning = [];
    const nextOccurrence_ = async (item, t, w) => {
      const zone = zoneOf(item, settings());
      const at = nextOccurrence({ wall: item.wall, tz: zone, after: Math.max(item.at ?? t, t), repeat: JSON.parse(item.repeat) });
      if (at == null) return null;
      const date = dateString(localDate(at, zone));
      const row = { ...item, id: undefined, _task: undefined, at, date, due: date, next_fire: null, state: "open", done_at: null, deleted_at: null, snooze_until: null, created: t, updated: t, assignee: w.person ? item.assignee : null };
      const made = await st.create(row, w);
      const n = schedule(made, t);
      made.next_fire = n.next_fire;
      emit("planner.added", { item: made.id, kind: "todo", title: made.title, at }, made);
      scheduler.arm();
      return made;
    };

    const snooze = (i, w) => {
      const c = calTarget(i);
      if (c) return calAck(c, "snooze", w, i.minutes);
      const { f, item, due } = target(i);
      if (!item) throw fail("that firing's item is gone", "not_found");
      owns(item, w);
      if ((i.firing || due != null) && f && f.state !== "ringing") return already(f);
      const minutes = i.minutes === undefined ? 9 : Number(i.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 1440) throw fail("minutes is 1 to 10080");
      const until = now() + Math.round(minutes * 60_000);
      if (f && f.state === "ringing") ack(f, "snooze", w, until);
      const g = f || (due != null ? answerUnrung(item.id, item.kind, due, "snooze", w, until) : null);
      st.patch(item.id, { snooze_until: until, updated: now() });
      scheduler.arm();
      return { item: shape(st.item(item.id)), firing: g ? shapeFiring(st.firing(g.id)) : null, until };
    };

    const dismiss = (i, w) => {
      const c = calTarget(i);
      if (c) return calAck(c, "dismiss", w);
      const { f: rung, item, due } = target(i);
      if (!item) throw fail("that firing's item is gone", "not_found");
      owns(item, w);
      if (!rung && due == null) throw fail("nothing is ringing for that item", "not_found");
      if (rung && rung.state !== "ringing") return already(rung);
      const f = rung || answerUnrung(item.id, item.kind, /** @type {number} */ (due), "dismiss", w);
      if (rung) ack(rung, "dismiss", w);
      const t = now();
      // A one-off alarm, timer, reminder or event is over once dismissed; a todo stays to be done.
      if (oneOffEnds(item) && item.kind !== "todo" && item.state === "open") {
        st.patch(item.id, { state: "done", done_at: t, next_fire: null, snooze_until: null, updated: t }, w);
        emit("planner.changed", { item: item.id, kind: item.kind, fields: ["state", "done_at"] }, item);
      } else st.patch(item.id, { snooze_until: null, updated: t });
      scheduler.arm();
      return { item: shape(st.item(item.id)), firing: shapeFiring(st.firing(f.id)) };
    };

    const remove = (i, w) => {
      const item = st.item(i.item);
      if (!item) throw fail("no such item", "not_found");
      owns(item, w);
      const t = now();
      if (i.restore) {
        if (!item.deleted_at) return shape(item);
        const back = { ...item, deleted_at: null };
        // A deleted to-do was skipped; restoring it opens the Task again.
        st.patch(item.id, { deleted_at: null, updated: t, next_fire: schedule(back, t).next_fire, ...(item._task && item.state === "cancelled" ? { state: "open" } : {}) }, w);
        emit("planner.added", { item: item.id, kind: item.kind, title: item.title, ...(item.at != null ? { at: item.at } : {}) }, item);
        scheduler.arm();
        return shape(st.item(item.id));
      }
      if (item.deleted_at) return shape(item);
      cancelRinging(item.id);
      // A to-do is a Task: deleting it cancels it (a Task has no bin).
      st.patch(item.id, { deleted_at: t, next_fire: null, snooze_until: null, updated: t, ...(item._task && item.state === "open" ? { state: "cancelled" } : {}) }, w);
      emit("planner.removed", { item: item.id, kind: item.kind }, item);
      scheduler.arm();
      return { removed: item.id, restore_until: t + 30 * 86_400_000 };
    };

    /**
     * Delete or restore one of the planner's own events. The record goes to the records' bin (records.remove) and comes back with records.restore, so a restore works after a
     * restart and from any record id: the event's, or one of a repeating event's occurrences (`<record>~<start>`). An outside calendar's event is changed on that calendar.
     */
    const removeEvent = async (i, w) => {
      if (!w.person) throw fail("an agent may change only the items it added", "denied");
      const rec = recordOf(i.item);
      if (i.restore) {
        const row = await st.cal.restore(rec);
        if (!row) throw fail("no such event in the bin", "not_found");
        const shown = cal.add({ ...row, own: row.own });
        emit("planner.added", { item: rec, kind: "event", title: row.title, at: row.start }, {});
        return shapeCal(shown);
      }
      const row = cal.row(i.item);
      if (row && !row.own) throw fail("that event belongs to an outside calendar: delete it there", "denied");
      if (!(await st.cal.remove(rec))) throw fail("no such event", "not_found");
      cal.forget(rec);
      emit("planner.removed", { item: rec, kind: "event" }, {});
      return { removed: rec, kind: "event", restore: "planner.delete with restore: true, or the Records bin" };
    };

    // ---- Agenda -------------------------------------------------------------------------------

    const agenda = async i => {
      const s = settings();
      const tz = s.timezone;
      const t = now();
      if (i.next !== undefined) {
        const n = Number(i.next);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw fail("next is 1 to 100");
        const ahead = await agenda({ from: t, to: t + 60 * 86_400_000 });
        return { tz, from: t, entries: ahead.entries.filter(e => e.at >= t).slice(0, n) };
      }
      const edge = (v, end) => {
        if (v === undefined || v === null || v === "") return null;
        if (typeof v === "number") return v;
        const d = parseDate(v);
        if (d) return toUTC(end ? addDays(d, 1) : d, { hour: 0, minute: 0 }, tz);
        const ms = /\b\d{4}\b/.test(String(v)) ? Date.parse(String(v)) : NaN;
        if (Number.isNaN(ms)) throw fail(`"${v}" is not a date or time`);
        return ms;
      };
      const today = localDate(t, tz);
      const from = edge(i.from, false) ?? toUTC(today, { hour: 0, minute: 0 }, tz);
      const to = edge(i.to, true) ?? toUTC(addDays(localDate(from, tz), 1), { hour: 0, minute: 0 }, tz);
      if (to <= from) throw fail("to must come after from");
      if (to - from > 400 * 86_400_000) throw fail("an agenda covers at most 400 days");

      const entries = [];
      const rows = st.all().filter(r => r.deleted_at == null && ["alarm", "timer", "reminder"].includes(r.kind)
        && (r.repeat != null || (r.at != null && r.at >= from && r.at < to) || (r.snooze_until != null && r.snooze_until >= from && r.snooze_until < to)));
      for (const r of rows) {
        const base = { source: "planner", item: r.id, kind: r.kind, title: r.title, state: r.state, repeat: Boolean(r.repeat), all_day: false,
          where: r.where_ ?? null, url: null };
        const end = r.kind === "event" && r.duration_ms ? ms => ms + r.duration_ms : () => null;
        if (r.repeat && r.wall && r.state === "open") {
          const rule = JSON.parse(r.repeat);
          let a = from - 1;
          for (let k = 0; k < 100; k++) {
            const n = nextOccurrence({ wall: r.wall, tz: zoneOf(r, s), after: a, repeat: rule });
            if (n == null || n >= to) break;
            entries.push({ ...base, at: n, start: n, end: end(n) });
            a = n;
          }
        } else if (!r.repeat) {
          if (r.at != null && r.at >= from && r.at < to) entries.push({ ...base, at: r.at, start: r.at, end: end(r.at) });
          if (r.snooze_until != null && r.state === "open") entries.push({ ...base, at: r.snooze_until, start: r.snooze_until, end: null, snoozed: true });
        }
      }
      for (const c of await st.eventsBetween(from, to)) {
        const e = shapeCal(c);
        entries.push({ source: e.source, ...(e.account ? { account: e.account } : {}), event: e.event, item: e.id, kind: "event", title: e.title, at: e.at, start: e.start, end: e.end,
          all_day: e.all_day, where: e.where, url: e.url, record: e.record, ...(e.rrule ? { rrule: e.rrule } : {}), ...(e.occurrence ? { occurrence: true } : {}) });
      }
      // By start; on the same instant, all-day first, then the planner's own, then by title.
      entries.sort((a, b) => a.at - b.at || Number(b.all_day) - Number(a.all_day) || Number(b.source === "planner") - Number(a.source === "planner")
        || String(a.title).localeCompare(String(b.title)));

      if (i.busy) {
        // Busy time: timed events (the planner's with a length, and every calendar's), clipped to
        // the range and merged. Instants are UTC, so events made in different zones merge as they overlap.
        const spans = entries.filter(e => e.kind === "event" && !e.all_day && e.end != null && e.end > e.at && e.state !== "cancelled")
          .map(e => ({ start: Math.max(e.at, from), end: Math.min(e.end, to) })).filter(x => x.end > x.start).sort((a, b) => a.start - b.start);
        const busy = [];
        for (const x of spans) {
          const last = busy.at(-1);
          if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
          else busy.push({ ...x });
        }
        return { tz, from, to, busy };
      }

      // Todos due by the end of the range, overdue ones included: what needs doing is still due.
      const toDate = dateString(localDate(to - 1, tz));
      const todos = st.all().filter(r => r.deleted_at == null && r.kind === "todo" && r.state === "open" && ((r.at != null && r.at < to) || (r.at == null && r.due != null && r.due <= toDate)))
        .sort((a, b) => String(a.due ?? "").localeCompare(String(b.due ?? "")) || b.priority - a.priority).map(shape);
      return { tz, from, to, entries, todos };
    };

    // ---- A device's own schedule (ADR 0029, R6) --------------------------------------------------

    /**
     * The event cursor a read is current to (ADR 0029, R1), read before the data: a surface that
     * loads with it and follows the stream from it misses nothing.
     */
    const cursor = () => Number(ctx.events.latestId()) || 0;

    const RINGS = ["alarm", "timer", "reminder", "todo"];
    /**
     * Every ring the box expects in the next `hours` (48 by default, at most 72), for a device to
     * schedule as local notifications so an alarm rings with the box out of reach. Each entry has
     * the key the box's push uses as its tag, so a device that rang it already replaces the push.
     * A moment already answered or ringing is left out; so is anything the box never rings.
     */
    const upcoming = i => {
      const last_event = cursor();
      const hours = i.hours === undefined ? 48 : Number(i.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw fail("hours is a whole number from 1 to 72");
      const s = settings();
      const from = now(), to = from + hours * 3_600_000;
      const entries = [];
      const put = (e, due, at) => {
        if (at <= from || at > to || st.firingAt(e.item, due)) return;
        entries.push({ key: ringKey(e.item, due), ...e, due: Math.floor(due / 1000), at, loud: e.kind === "alarm" || e.kind === "timer" });
      };
      const rows = st.all().filter(r => r.state === "open" && r.deleted_at == null && RINGS.includes(r.kind)
        && ((r.next_fire != null && r.next_fire <= to) || (r.snooze_until != null && r.snooze_until <= to) || r.repeat != null));
      for (const r of rows) {
        const e = { item: r.id, kind: r.kind, title: String(r.title ?? ""), ...(r.source_name ? { added_by: r.source_name } : {}) };
        if (r.snooze_until != null) put({ ...e, snoozed: true }, r.snooze_until, r.snooze_until);
        // The same walk the scheduler takes, so each moment is the one the box would ring.
        let n = r.next_fire;
        for (let k = 0; n != null && n <= to && k < 200; k++) {
          const start = r.kind === "event" ? n + s.event_lead * 60_000 : n;
          put(r.kind === "event" ? { ...e, start } : e, n, n);
          n = r.repeat && r.wall ? nextFire(r, n, s).next : null;
        }
      }
      for (const c of st.cal.rows().filter(c => !c.all_day && ((c.next_fire != null && c.next_fire <= to) || (c.snooze_until != null && c.snooze_until <= to)))) {
        const e = { item: c.id, kind: "event", title: String(c.title ?? ""), ...(c.account ? { account: c.account } : {}), start: c.start };
        if (c.snooze_until != null) put({ ...e, snoozed: true }, c.snooze_until, c.snooze_until);
        // A ring found inside its lead is set for now, but its moment (and key) is still start less the lead.
        if (c.next_fire != null && c.rung_start !== c.start) put(e, c.start - s.event_lead * 60_000, Math.max(c.next_fire, c.start - s.event_lead * 60_000));
      }
      entries.sort((a, b) => a.at - b.at || String(a.key).localeCompare(String(b.key)));
      return { tz: s.timezone, from, to, last_event, entries };
    };

    // ---- Settings -----------------------------------------------------------------------------

    const changeSettings = i => {
      const cur = settings();
      const next = { ...(st.state.get("settings") || {}) };
      if (i.timezone !== undefined) { if (!validZone(i.timezone)) throw fail(`${i.timezone} is not a time zone`); next.timezone = String(i.timezone); }
      if (i.follow_device !== undefined) next.follow_device = Boolean(i.follow_device);
      const int = (k, lo, hi) => {
        if (i[k] === undefined) return;
        const v = Number(i[k]);
        if (!Number.isInteger(v) || v < lo || v > hi) throw fail(`${k} is a whole number from ${lo} to ${hi}`);
        next[k] = v;
      };
      // Nothing rings again sooner than a minute (SPEC principle 8).
      int("escalate_after", 1, 120); int("escalate_max", 0, 10); int("event_lead", 0, 1440);
      st.state.set("settings", next);
      const after = settings();
      if (after.timezone !== cur.timezone || after.event_lead !== cur.event_lead) {
        // Floating items follow the new zone; events move with a new lead.
        const t = now();
        const rows = st.all().filter(r => r.state === "open" && r.deleted_at == null && r.next_fire != null && r.floating && r.wall != null);
        for (const r of rows) {
          const n = nextFire(r, t, after);
          st.patch(r.id, { next_fire: n.next, ...(n.at != null && (r.repeat || r.floating) ? { at: n.at } : {}), updated: t });
        }
        scheduler.arm();
      }
      if (after.event_lead !== cur.event_lead) cal.relead();
      if (after.timezone !== cur.timezone || after.event_lead !== cur.event_lead) emit("planner.schedule", { reason: "settings" });
      return after;
    };

    // ---- Calendar -----------------------------------------------------------------------------

    const cal = calendar({ ctx, K, st, scheduler, settings, now, emit, active: () => role === "box" || !linked });

    /** An agent may only ask for an invite on a connected calendar, which the google module holds at the Gate. */
    const createCheck = (i, w) => {
      if (w.person) return;
      const to = Array.isArray(i.attendees) ? i.attendees.filter(Boolean) : i.attendees ? [i.attendees] : [];
      if (!i.account || !to.length) throw fail("an agent may only ask for an invite on a connected calendar (account and attendees), which waits at the Gate", "denied");
    };

    /** A time for Google: a date stays a date; a local time is read in the planner's zone. */
    const googleTime = (v, tz) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (typeof v === "number") return new Date(v).toISOString();
      const str = String(v).trim();
      if (parseDate(str)) return str;
      const m = LOCAL_ISO.exec(str);
      if (m && !ZONED.test(str)) return new Date(toUTC(/** @type {any} */ (parseDate(m[1])), /** @type {any} */ (parseWall(m[2])), tz)).toISOString();
      return str;
    };

    const createEvent = async (i, w) => {
      createCheck(i, w);
      const s = settings();
      if (i.tz !== undefined && i.tz !== null && !validZone(i.tz)) throw fail(`${i.tz} is not a time zone`);
      const tz = String(i.tz || s.timezone);
      if (!i.account) {
        const ms = v => (typeof v === "number" ? v : Date.parse(String(googleTime(v, tz))));
        const startAt = ms(i.start);
        let endAt = null;
        if (i.end !== undefined && i.end !== null && i.end !== "") {
          endAt = ms(i.end);
          if (!Number.isFinite(endAt) || !(endAt > startAt)) throw fail("end must be a time after start");
        }
        return await add({ kind: "event", title: i.title, at: i.start, tz, project: i.project, thread: i.thread, duration_ms: endAt != null ? endAt - startAt : 3_600_000, where: i.where, rrule: i.rrule, url: i.url }, w);
      }
      const input = { title: String(i.title ?? ""), start: googleTime(i.start, tz), account: String(i.account), time_zone: tz,
        ...(i.end !== undefined ? { end: googleTime(i.end, tz) } : {}), ...(i.where ? { where: String(i.where) } : {}),
        ...(i.attendees !== undefined ? { attendees: i.attendees } : {}), ...(i.why ? { why: String(i.why) } : {}) };
      const r = await ctx.call("google.calendar.create", input);
      if (r.error) throw fail(r.error.message, r.error.code || "failed");
      // Written at once (no invite): the connectors' sync brings it in as an Event record; look again so its reminder is set now.
      if (r.data && r.data.event) cal.sync().catch(() => {});
      return r.data;
    };

    /** A reminder, note or to-do the records say changed from outside: its next ring follows its time, and a finished one stops ringing. */
    const external = (row, how) => {
      if (how === "removed") { cancelRinging(row.id); scheduler.arm(); return; }
      if (row.kind !== "note" && row.state === "open" && row.deleted_at == null) {
        const n = schedule(row, now());
        // A to-do's ring time is not stored (the Task has its due time): it is worked out here, in the working set only, with its date and time of day read from the due time in its zone.
        if (row._task) {
          row.next_fire = n.next_fire;
          if (row.at != null) { const p = localParts(row.at, zoneOf(row, settings())); row.date = dateString(p); row.wall = wallString(p); row.due = row.date; }
        }
        else if (n.next_fire !== row.next_fire) st.patch(row.id, { next_fire: n.next_fire, ...(n.at != null && row.repeat ? { at: n.at } : {}) });
      }
      if (row.state !== "open" || row.deleted_at != null) cancelRinging(row.id);
      emit(how === "added" ? "planner.added" : "planner.changed", how === "added" ? { item: row.id, kind: row.kind, title: row.title, ...(row.at != null ? { at: row.at } : {}) } : { item: row.id, kind: row.kind, fields: ["records"] }, row);
      scheduler.arm();
    };

    // ---- Tools --------------------------------------------------------------------------------

    const str = { type: "string" }, int = { type: "integer" }, bool = { type: "boolean" };
    const when = { description: "an ISO time (with an offset, or read in the item's zone without one), YYYY-MM-DD, or ms since 1970" };
    const repeatSchema = { type: "object", description: "every: day|weekday|week|month|year, with optional days, interval, until", properties: { every: { type: "string", enum: ["day", "weekday", "week", "month", "year"] },
      days: { type: "array", items: int }, interval: int, until: str } };
    const itemFields = { title: str, body: str, list: str, priority: int, parent: str, project: str, thread: str, tags: { type: "array", items: str },
      pinned: bool, assignee: { type: "string", description: "give a to-do to this assistant or agent (the person only); it finishes it as its own" }, at: when, in_ms: { type: "number", description: "a timer's length in ms" }, wall: { type: "string", description: "wall-clock HH:MM, with date" }, date: { type: "string", description: "YYYY-MM-DD, with wall" }, due: when, repeat: repeatSchema, tz: str, floating: bool,
      // /later: waits_on chains a task after another item's own done, instead of a time; paused
      // stops just this one item (rule 2) without deleting it or losing its run history.
      waits_on: str, paused: bool,
      // An event's own fields: how it repeats (an RRULE, such as FREQ=WEEKLY;BYDAY=MO) and where it is on its calendar.
      rrule: { anyOf: [str, { type: "null" }] }, url: { anyOf: [str, { type: "null" }] } };
    const ref = { type: "object", properties: { firing: str, item: str, key: { type: "string", description: "planner-<item>-<due in seconds>, as planner.upcoming and the push give it" } } };

    /**
     * Register a tool. On a paired Mac it runs on the box, which sees the forwarded call as the
     * owner; an agent's call carries `as` so the box applies the agent's rules. A `local` tool
     * (the parser: pure, no state) answers where it is asked.
     */
    const READS = new Set(["planner.list", "planner.get", "planner.ringing", "planner.agenda", "planner.bin", "planner.upcoming", "planner.parse"]);
    const tool = (name, description, input, run, { agents = false, local = false } = {}) => ctx.tool(name, {
      // `as` is the Mac's forward of an agent's call to the box (who() honours it only from a person's label).
      description, input: { ...input, properties: { ...(input.properties || {}), as: { type: "object" } } }, effect: READS.has(name) ? "read" : "write", callers: agents ? [...PEOPLE, ...AGENTS] : PEOPLE,
      run: async (i, meta) => {
        const w = await who(i, meta.caller, meta.thread || null, meta.agent || null);
        const { as: _as, ...rest } = i || {};
        // A Mac paired with a box hands every call to the box, which is where the planner lives and decides; only a call that stays here is asked whether this space can hold the planner.
        const paired = !local && role === "local" && (await checkLink());
        // A Basic personal space has no store for the planner: it needs a Cloud space, and the answer lists the ones the person is in.
        if (!local && !paired) { const gate = await cloudGate(ctx, K ? K.space : undefined); if (gate) throw gate; }
        if (!K && !local && !paired) throw fail("the planner keeps its records in the kernel, which is off here", "unavailable");
        if (paired) return forward(name, w.person ? rest : { ...rest, as: { source: w.source, name: w.name, ...(w.thread ? { thread: w.thread } : {}) } });
        // The caller's own chain, for what only the person may do (finishing a to-do is the Task's doer's act).
        if (!local && (!READS.has(name) || name === "planner.bin")) w.chain = await K.chain(meta).catch(() => null);
        // A personal reminder follows the person: a device they are using says which zone it is in (lib/time), and the planner's zone (which floating alarms are read in) moves to it, unless they turned that off.
        if (!local && K && w.person && FOLLOWS.has(callerKind(meta.caller)) && meta.zone && (role === "local" || callerKind(meta.caller) !== "cli")) {
          const here = zoneFrom(meta.zone, "");
          if (here && settings().follow_device !== false && here !== settings().timezone && name !== "planner.settings") { try { changeSettings({ timezone: here }); } catch (e) { ctx.log(`planner: zone not followed (${/** @type {Error} */ (e).message})`); } }
        }
        const out = await run(rest, w);
        // A write answers once the records have it; a write the gateway refused is the caller's error.
        if (!local && !READS.has(name)) await st.flush();
        return out;
      },
    });

    tool("planner.add", "Add an alarm, timer, reminder, todo, note or event, from times (at, in_ms, or wall with date) or plain words in text.",
      { type: "object", properties: { kind: { type: "string", enum: KINDS }, text: { type: "string", description: "plain words such as \"alarm 7am\", read into an item; kind is a hint" }, ...itemFields } },
      async (i, w) => await add(i, w), { agents: true });

    tool("planner.list", "Items, newest time first, filtered by kind, state, list, project, pinned or tag. cursor: true returns { items, last_event }.",
      { type: "object", properties: { kind: { type: "string", enum: KINDS }, state: { type: "string", enum: [...STATES, "all"], description: "open by default; all for every state" }, list: str, project: str, pinned: bool, tag: str, limit: { type: "integer", description: "up to 500" }, cursor: { type: "boolean", description: "true returns { items, last_event }, the event cursor the list is current to" } } },
      async i => {
        const last_event = i.cursor ? cursor() : 0;
        const items = st.list({ ...i, limit: Math.min(500, Math.max(1, i.limit || 100)) }).map(shape);
        return i.cursor ? { items, last_event } : items;
      }, { agents: true });

    tool("planner.get", "One item and its latest firings, by item or firing id.",
      ref,
      async i => {
        const f = i.firing ? st.firing(i.firing) : null;
        const item = st.item(f ? f.item : i.item);
        if (!item) {
          let row = cal.row(f ? f.item : i.item);
          // An event outside the window the planner rings for is still an event record.
          if (!row && i.item) { const rec = await K.records.get(K.serviceChain(), "event", String(i.item)).catch(() => null); row = rec ? fromEvent(rec, now()) : null; }
          if (row) return { item: shapeCal(row), firings: st.firingsOf(row.id).map(shapeFiring), ...(f ? { firing: shapeFiring(f) } : {}) };
          throw fail("no such item", "not_found");
        }
        return { item: shape(item), firings: st.firingsOf(item.id).map(shapeFiring), ...(f ? { firing: shapeFiring(f) } : {}) };
      }, { agents: true });

    tool("planner.ringing", "What is ringing now, shaped like planner.fired, so a surface that connects late can show its banners. cursor: true returns { ringing, last_event }.",
      { type: "object", properties: { cursor: bool } },
      async i => {
        const last_event = i.cursor ? cursor() : 0;
        const ringing = st.allRinging().map(f => {
        const it = st.item(f.item) || cal.row(f.item);
        return { firing: f.id, key: ringKey(f.item, f.due), item: f.item, kind: f.kind, title: it ? String(it.title || "") : "", due: f.due, ring: f.ring, missed: Boolean(f.missed), actions: ["done", "snooze"],
          ...(it && it.source_name ? { added_by: it.source_name } : {}) };
        });
        return i.cursor ? { ringing, last_event } : ringing;
      }, { agents: true });

    tool("planner.update", "Change an item's fields, state (open, done, cancelled) or time. An agent may change only items it added.",
      { type: "object", required: ["item"], properties: { item: str, kind: str, state: { type: "string", enum: STATES }, ...itemFields } },
      async (i, w) => await update(i, w), { agents: true });

    tool("planner.done", "Acknowledge a firing or finish a todo or reminder. Give firing, item, or key.",
      ref, async (i, w) => { const out = done(i, w); await Promise.all(spawning.splice(0)); return out; }, { agents: true });

    tool("planner.snooze", "Snooze a firing or an item: it rings again after minutes (9 by default).",
      { type: "object", properties: { ...ref.properties, minutes: { type: "number" } } }, async (i, w) => snooze(i, w), { agents: true });

    tool("planner.dismiss", "Stop a firing without finishing a todo. A one-off alarm, timer or reminder ends.",
      ref, async (i, w) => dismiss(i, w), { agents: true });

    tool("planner.delete", "Delete an item; restore: true brings it back within 30 days, events from the records' bin.",
      { type: "object", required: ["item"], properties: { item: str, restore: { type: "boolean", description: "true restores it; an event comes back from the records' bin by id" } } }, async (i, w) => {
        // An event is a record of the Space's calendar, not a planner row: its delete and restore go through the records' bin.
        if (!st.item(i.item) && (cal.row(i.item) || (i.restore && i.item))) return removeEvent(i, w);
        return remove(i, w);
      }, { agents: true });

    tool("planner.bin", "The events you deleted that can still be restored (planner.delete with restore: true and the id), newest first.",
      { type: "object", properties: {} }, async (i, w) => ({ events: await st.cal.binned(w.chain) }), { agents: true });

    tool("planner.agenda", "What is on between from and to (default today): planner items, calendar events and due todos, each with source, start and end. Returns last_event too.",
      { type: "object", properties: { from: when, to: when, busy: { type: "boolean", description: "true returns only the merged busy intervals" }, next: { type: "integer", description: "n returns the next n entries from now" } } }, async i => { const last_event = cursor(); return { ...(await agenda(i)), last_event }; }, { agents: true });

    tool("planner.upcoming", "Rings expected in the next hours, for a device to schedule as its own notifications. Returns entries (key, item, kind, title, due) and last_event.",
      { type: "object", properties: { hours: { type: "integer", description: "default 48, 1 to 72" } } }, async i => upcoming(i), { agents: true });

    tool("planner.calendar.sync", "Read the connected Google calendars (a day back to 14 days ahead) into the planner's copy now.",
      { type: "object", properties: {} }, async () => cal.sync(), { agents: true });

    tool("planner.calendar.create", "Make an event: the planner's own, or on a Google calendar when account is given. Attendees send invites, held at the Gate for the user.",
      { type: "object", required: ["title", "start"], properties: { title: str, start: when, end: when, where: str, attendees: { anyOf: [str, { type: "array", items: str }] },
        account: { type: "string", description: "Google account whose calendar gets the event; agents may only ask for an invite (account with attendees)" }, tz: str, why: str, project: str, thread: str, rrule: str, url: str } },
      async (i, w) => createEvent(i, w), { agents: true });

    tool("planner.parse", "Read words like \"alarm 7am\" into a proposed item { kind, title, at, tz }, { ambiguous, reason }, or null. kind is a hint.",
      { type: "object", required: ["text"], properties: { text: str, kind: { type: "string", enum: KINDS, description: "a hint when the words are unclear" } } }, async i => parseText(i.text, now(), i.kind), { agents: true, local: true });

    tool("planner.settings", "The planner's zone (floating alarms follow it), escalate_after (minutes, from 1), escalate_max (rings after the first) and event_lead (minutes). With no input, the current settings.",
      { type: "object", properties: { timezone: str, follow_device: bool, escalate_after: int, escalate_max: int, event_lead: int } }, async i => changeSettings(i));

    // ---- Start --------------------------------------------------------------------------------

    if (role === "local") {
      try { await checkLink(); } catch { linked = false; }
    }
    if (!K) return { async stop() {} };
    // A to-do's time is not stored on its Task: it rings from the working set, so its next ring is worked out again at start.
    for (const r of st.all()) if (r._task && r.state === "open" && r.at != null) r.next_fire = schedule(r, now()).next_fire;
    // A task's escalate_after and escalate_to (stored by the kernel, read here): a wake hook on the one scheduler, so no second timer.
    const escalation = taskEscalation({ K, st, scheduler, now, emit: (type, payload) => emit(type, payload), log: ctx.log });
    if (!linked) scheduler.start();
    escalation.refresh().catch(() => {});
    offs.push(cal.watch());
    // The records are the truth: a reminder, note or to-do changed from the app, a Flow or another device is read back in.
    for (const [type, consumer] of [["reminder.*", "planner-reminders"], ["note.*", "planner-notes"], ["task.*", "planner-tasks"]]) {
      const off = K.events.subscribe(K.serviceChain(), consumer, { type }, e => {
        if (type === "task.*") escalation.refresh().catch(() => {});
        // What the planner itself wrote is already in its working set.
        if (String(e.actor || "").split("@")[0] === "service:planner") return;
        const parts = String(e.subject || "").split("/");
        const id = parts.pop(), kind = parts.pop();
        if (id && kind) return st.external({ type: kind, id }).catch(err => ctx.log(`planner: a change to ${kind} ${id} was not read (${err.message})`));
      });
      offs.push(() => { if (typeof off === "function") off(); });
    }

    return {
      scheduler,
      calendar: cal,
      async stop() { scheduler.stop(); for (const off of offs) { try { off(); } catch {} } },
    };
  },
};
