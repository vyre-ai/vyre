// @ts-check
// planner: alarms, timers, reminders, todos, notes and the planner's own calendar, kept on the box
// so something rings when the Mac is shut (docs/adr/0025-planner.md). One store, one scheduler
// (scheduler.js), and delivery by one event, planner.fired, that push, the Capsule and the Deck
// each act on. A Mac paired with a box forwards every tool there and keeps its scheduler idle;
// an unpaired Mac runs the planner itself.

import { MIGRATIONS, KINDS, STATES, store, shape, shapeFiring, newId } from "./store.js";
import { Scheduler, nextFire, zoneOf } from "./scheduler.js";
import { calendarCache, shapeCal } from "./calendar.js";
import { validZone, systemZone, parseDate, parseWall, dateString, wallString, localDate, localParts, toUTC, addDays, checkRepeat, nextOccurrence } from "./time.js";
import { callerAllowed, callerKind } from "../modules/index.js";

export { MIGRATIONS };

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: a fake clock and timer. Anything left
 * out uses the real thing.
 * @type {Map<string, { now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }>}
 */
export const seams = new Map();

const PEOPLE = ["cli", "local", "deck", "capsule"];
const AGENTS = ["mcp", "module", "harness"];
/** What an agent may add with no permission (the user's rule): everything but an event, which is an invite. */
const AGENT_KINDS = ["alarm", "timer", "reminder", "todo", "note"];
/** A runaway guard, not a limit anyone should meet: adds an hour from one agent. */
const AGENT_CAP = 200;
/** A caller that names an agent: "mcp:agent:kit", "harness:agent:kit". vyred has checked the name. */
const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/;
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
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const st = store(db);
    const seam = seams.get(ctx.paths && ctx.paths.root) || {};
    const now = seam.now || Date.now;
    const role = ctx.config && ctx.config.role === "box" ? "box" : "local";
    const parser = await loadParser(ctx.log);

    const defaults = () => ({
      timezone: (ctx.config && ctx.config.planner && validZone(ctx.config.planner.timezone) && String(ctx.config.planner.timezone)) || systemZone(),
      escalate_after: 5, escalate_max: 3, event_lead: 10,
    });
    /** @returns {import("./scheduler.js").Settings} */
    const settings = () => ({ ...defaults(), ...(st.state.get("settings") || {}) });

    const emit = (type, payload, item) => {
      try { ctx.events.emit(type, payload, { ...(item && item.project ? { project: item.project } : {}), ...(item && item.thread ? { thread: item.thread } : {}) }); }
      catch (e) { ctx.log(`planner: ${type} not emitted (${/** @type {Error} */ (e).message})`); }
    };

    const scheduler = new Scheduler({ db, st, settings, now, setTimer: seam.setTimer, clearTimer: seam.clearTimer, log: ctx.log,
      fired: (f, item) => emit("planner.fired", { firing: f.id, item: item.id, kind: item.kind, title: item.title, due: f.due, ring: f.ring,
        missed: Boolean(f.missed), actions: ["done", "snooze"], ...(item.source_name ? { added_by: item.source_name } : {}) }, item) });

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
        const ms = Date.parse(str);
        if (Number.isNaN(ms)) throw fail(`"${str}" is not a time (an ISO time, or YYYY-MM-DD)`);
        at = ms;
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

    /** An item's next_fire (and at, for a repeat) as of now. */
    const schedule = (row, t = now()) => { const n = nextFire(row, t, settings()); return { at: n.at, next_fire: n.next }; };

    // ---- Who may do what ----------------------------------------------------------------------

    // The user's rule: anyone, agents included, adds alarms, timers, reminders, todos and notes
    // with no prompt. The person changes anything; an agent changes only what it added. An item
    // keeps who added it (source), and shows a name (added_by) only when that was neither the
    // person nor their assistant.

    const isPerson = caller => callerAllowed(PEOPLE, caller);

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
     * Who a call is from: { person, source, name }. A paired Mac passes an agent's identity on as
     * `as`, which only a person's call (the Mac's link arrives as the owner) may carry.
     * @returns {Promise<{ person: boolean, source: string, name: string|null }>}
     */
    const who = async (i, caller) => {
      if (isPerson(caller)) {
        const as = i && i.as && typeof i.as === "object" ? i.as : null;
        if (as && as.source) return { person: false, source: String(as.source).slice(0, 120), name: as.name ? String(as.name).slice(0, 80) : null };
        return { person: true, source: callerKind(caller), name: null };
      }
      const c = String(caller);
      if (c.startsWith("module:")) return { person: false, source: c.slice(0, 120), name: null };
      const m = AGENT_CLAIM.exec(c);
      // An unnamed MCP or harness caller is the person's own Claude session: their assistant.
      if (!m) return { person: false, source: callerKind(caller), name: null };
      return { person: false, source: `agent:${m[1]}`, name: (await isAssistant(m[1])) ? null : m[1] };
    };

    const agentKind = (kind, w) => {
      if (w.person) return;
      if (!AGENT_KINDS.includes(kind)) throw fail(`an agent may add alarms, timers, reminders, todos and notes, not ${kind}s`, "denied");
    };
    /** An agent may change, finish, snooze or delete only what it added. */
    const owns = (item, w) => {
      if (w.person || (item && item.source === w.source)) return;
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

    const add = (i, w) => {
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
      capped(w);
      const s = settings();
      const time = resolveTime(kind, input, s, t);
      let title = String(input.title ?? "").trim().slice(0, 500);
      if (!title) title = kind === "alarm" ? "Alarm" : kind === "timer" ? "Timer" : "";
      if (!title) throw fail(`a ${kind} needs a title`);
      if (input.parent && !st.item(input.parent)) throw fail("no such parent item", "not_found");
      const row = { id: newId("i"), kind, title, body: clip(input.body, 100_000), list: clip(input.list, 80), priority: priorityOf(input.priority),
        parent: input.parent ? String(input.parent) : null, project: clip(input.project, 120), thread: clip(input.thread, 120),
        tags: tagsOf(input.tags), pinned: Boolean(input.pinned), state: "open", ...time, created: t, updated: t, source: w.source, source_name: w.name };
      const n = schedule(row, t);
      if (row.repeat) row.at = n.at;
      st.insert({ ...row, next_fire: n.next_fire });
      counted(w);
      emit("planner.added", { item: row.id, kind, title, ...(row.at != null ? { at: row.at } : {}), ...(w.name ? { added_by: w.name } : {}) }, row);
      scheduler.arm();
      return shape(st.item(row.id));
    };

    const EDITABLE = ["title", "body", "list", "priority", "pinned", "tags", "project", "thread", "parent", "state"];
    const TIME_FIELDS = ["at", "in_ms", "wall", "date", "repeat", "tz", "floating", "due"];

    const update = (i, w) => {
      const item = st.item(i.item);
      if (!item || item.deleted_at) throw fail("no such item", "not_found");
      owns(item, w);
      if (i.kind !== undefined && i.kind !== item.kind) throw fail("an item's kind does not change; add a new one");
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
      st.patch(item.id, patch);
      if (patch.state && patch.state !== "open") cancelRinging(item.id);
      emit("planner.changed", { item: item.id, kind: item.kind, fields: Object.keys(patch).filter(k => k !== "updated") }, next);
      scheduler.arm();
      return shape(st.item(item.id));
    };

    /** The firing and item an acknowledgement is about: a firing id, or an item and its live firing. */
    const target = i => {
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
      emit("planner.acked", { firing: f.id, item: f.item, action, by: w.source, ...(until ? { until } : {}) }, st.item(f.item));
    };
    /** Stop any ring for an item that has ended; surfaces drop the banner on the ack. */
    const cancelRinging = id => {
      const f = st.ringing(id);
      if (!f) return;
      st.patchFiring(f.id, { state: "cancelled", next_ring: null, acked_at: now(), action: "dismiss" });
      emit("planner.acked", { firing: f.id, item: id, action: "dismiss", by: "planner" }, st.item(id));
    };
    const already = f => ({ already: true, firing: f.id, state: f.state, action: f.action ?? null });

    /** A ring for a cached calendar event: its firing (by firing id, or the row's live one) and row, or null. */
    const calTarget = i => {
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
      else if (action === "dismiss") throw fail("nothing is ringing for that event", "not_found");
      return { item: shapeCal(cal.row(c.row.id)), firing: c.f ? shapeFiring(st.firing(c.f.id)) : null, ...(until ? { until } : {}) };
    };
    const oneOffEnds = item => !item.repeat;

    const done = (i, w) => {
      const c = calTarget(i);
      if (c) return calAck(c, "done", w);
      const { f, item } = target(i);
      if (!item) throw fail("that firing's item is gone", "not_found");
      owns(item, w);
      if (i.firing && f && f.state !== "ringing") return already(f);
      const t = now();
      if (f && f.state === "ringing") ack(f, "done", w);
      if (item.repeat) {
        // A repeating item keeps going. Done with nothing ringing is done for this time round.
        const patch = /** @type {any} */ ({ snooze_until: null, updated: t });
        if (!f && item.next_fire != null) patch.next_fire = nextFire(item, Math.max(t, item.next_fire), settings()).next;
        st.patch(item.id, patch);
        emit("planner.changed", { item: item.id, kind: item.kind, fields: Object.keys(patch).filter(k => k !== "updated") }, item);
      } else if (item.state === "open") {
        st.patch(item.id, { state: "done", done_at: t, next_fire: null, snooze_until: null, updated: t });
        emit("planner.changed", { item: item.id, kind: item.kind, fields: ["state", "done_at"] }, item);
      }
      scheduler.arm();
      return { item: shape(st.item(item.id)), firing: f ? shapeFiring(st.firing(f.id)) : null };
    };

    const snooze = (i, w) => {
      const c = calTarget(i);
      if (c) return calAck(c, "snooze", w, i.minutes);
      const { f, item } = target(i);
      if (!item) throw fail("that firing's item is gone", "not_found");
      owns(item, w);
      if (i.firing && f && f.state !== "ringing") return already(f);
      const minutes = i.minutes === undefined ? 9 : Number(i.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 1440) throw fail("minutes is 1 to 10080");
      const until = now() + Math.round(minutes * 60_000);
      if (f && f.state === "ringing") ack(f, "snooze", w, until);
      st.patch(item.id, { snooze_until: until, updated: now() });
      scheduler.arm();
      return { item: shape(st.item(item.id)), firing: f ? shapeFiring(st.firing(f.id)) : null, until };
    };

    const dismiss = (i, w) => {
      const c = calTarget(i);
      if (c) return calAck(c, "dismiss", w);
      const { f, item } = target(i);
      if (!item) throw fail("that firing's item is gone", "not_found");
      owns(item, w);
      if (!f) throw fail("nothing is ringing for that item", "not_found");
      if (f.state !== "ringing") return already(f);
      ack(f, "dismiss", w);
      const t = now();
      // A one-off alarm, timer, reminder or event is over once dismissed; a todo stays to be done.
      if (oneOffEnds(item) && item.kind !== "todo" && item.state === "open") {
        st.patch(item.id, { state: "done", done_at: t, next_fire: null, snooze_until: null, updated: t });
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
        st.patch(item.id, { deleted_at: null, updated: t, next_fire: schedule(back, t).next_fire });
        emit("planner.added", { item: item.id, kind: item.kind, title: item.title, ...(item.at != null ? { at: item.at } : {}) }, item);
        scheduler.arm();
        return shape(st.item(item.id));
      }
      if (item.deleted_at) return shape(item);
      cancelRinging(item.id);
      st.patch(item.id, { deleted_at: t, next_fire: null, snooze_until: null, updated: t });
      emit("planner.removed", { item: item.id, kind: item.kind }, item);
      scheduler.arm();
      return { removed: item.id, restore_until: t + 30 * 86_400_000 };
    };

    // ---- Agenda -------------------------------------------------------------------------------

    const agenda = i => {
      const s = settings();
      const tz = s.timezone;
      const t = now();
      if (i.next !== undefined) {
        const n = Number(i.next);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw fail("next is 1 to 100");
        const ahead = agenda({ from: t, to: t + 60 * 86_400_000 });
        return { tz, from: t, entries: ahead.entries.filter(e => e.at >= t).slice(0, n) };
      }
      const edge = (v, end) => {
        if (v === undefined || v === null || v === "") return null;
        if (typeof v === "number") return v;
        const d = parseDate(v);
        if (d) return toUTC(end ? addDays(d, 1) : d, { hour: 0, minute: 0 }, tz);
        const ms = Date.parse(String(v));
        if (Number.isNaN(ms)) throw fail(`"${v}" is not a date or time`);
        return ms;
      };
      const today = localDate(t, tz);
      const from = edge(i.from, false) ?? toUTC(today, { hour: 0, minute: 0 }, tz);
      const to = edge(i.to, true) ?? toUTC(addDays(localDate(from, tz), 1), { hour: 0, minute: 0 }, tz);
      if (to <= from) throw fail("to must come after from");
      if (to - from > 400 * 86_400_000) throw fail("an agenda covers at most 400 days");

      const entries = [];
      const rows = /** @type {any[]} */ (db.prepare(`SELECT * FROM planner_items WHERE deleted_at IS NULL AND kind IN ('alarm','timer','reminder','event')
        AND (repeat IS NOT NULL OR (at >= ? AND at < ?) OR (snooze_until >= ? AND snooze_until < ?))`).all(from, to, from, to));
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
      const copies = /** @type {any[]} */ (db.prepare("SELECT * FROM planner_calendar WHERE start < ? AND COALESCE(end, start) >= ? ORDER BY start").all(to, from));
      for (const c of copies) {
        const e = shapeCal(c);
        entries.push({ source: e.source, account: e.account, event: e.event, item: e.id, kind: "event", title: e.title, at: e.at, start: e.start, end: e.end,
          all_day: e.all_day, where: e.where, url: e.url });
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
      const todos = /** @type {any[]} */ (db.prepare(`SELECT * FROM planner_items WHERE deleted_at IS NULL AND kind = 'todo' AND state = 'open'
        AND ((at IS NOT NULL AND at < ?) OR (at IS NULL AND due IS NOT NULL AND due <= ?)) ORDER BY COALESCE(due, ''), priority DESC`).all(to, toDate)).map(shape);
      return { tz, from, to, entries, todos };
    };

    // ---- Settings -----------------------------------------------------------------------------

    const changeSettings = i => {
      const cur = settings();
      const next = { ...(st.state.get("settings") || {}) };
      if (i.timezone !== undefined) { if (!validZone(i.timezone)) throw fail(`${i.timezone} is not a time zone`); next.timezone = String(i.timezone); }
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
        const rows = /** @type {any[]} */ (db.prepare(`SELECT * FROM planner_items WHERE state = 'open' AND deleted_at IS NULL AND next_fire IS NOT NULL
          AND ((floating = 1 AND wall IS NOT NULL) OR kind = 'event')`).all());
        for (const r of rows) {
          const n = nextFire(r, t, after);
          st.patch(r.id, { next_fire: n.next, ...(n.at != null && (r.repeat || r.floating) ? { at: n.at } : {}), updated: t });
        }
        scheduler.arm();
      }
      if (after.event_lead !== cur.event_lead) cal.relead();
      return after;
    };

    // ---- Calendar -----------------------------------------------------------------------------

    const cal = calendarCache({ ctx, db, st, scheduler, settings, now, emit, cancelRinging, active: () => role === "box" || !linked });

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
        const item = add({ kind: "event", title: i.title, at: i.start, tz, project: i.project, thread: i.thread }, w);
        st.patch(item.id, { duration_ms: endAt != null ? endAt - item.at : 3_600_000, where_: clip(i.where, 500) });
        return shape(st.item(item.id));
      }
      const input = { title: String(i.title ?? ""), start: googleTime(i.start, tz), account: String(i.account), time_zone: tz,
        ...(i.end !== undefined ? { end: googleTime(i.end, tz) } : {}), ...(i.where ? { where: String(i.where) } : {}),
        ...(i.attendees !== undefined ? { attendees: i.attendees } : {}), ...(i.why ? { why: String(i.why) } : {}) };
      const r = await ctx.call("google.calendar.create", input);
      if (r.error) throw fail(r.error.message, r.error.code || "failed");
      // Written at once (no invite): keep it in the copy so the agenda and its reminder have it now.
      if (r.data && r.data.event) cal.upsert(r.data.event, String(i.account));
      return r.data;
    };

    // ---- Tools --------------------------------------------------------------------------------

    const str = { type: "string" }, int = { type: "integer" }, bool = { type: "boolean" };
    const when = { description: "an ISO time (with an offset, or read in the item's zone without one), YYYY-MM-DD, or ms since 1970" };
    const repeatSchema = { type: "object", properties: { every: { type: "string", enum: ["day", "weekday", "week", "month", "year"] },
      days: { type: "array", items: int }, interval: int, until: str } };
    const itemFields = { title: str, body: str, list: str, priority: int, parent: str, project: str, thread: str, tags: { type: "array", items: str },
      pinned: bool, at: when, in_ms: { type: "number" }, wall: str, date: str, due: when, repeat: repeatSchema, tz: str, floating: bool };
    const ref = { type: "object", properties: { firing: str, item: str } };

    /**
     * Register a tool. On a paired Mac it runs on the box, which sees the forwarded call as the
     * owner; an agent's call carries `as` so the box applies the agent's rules. A `local` tool
     * (the parser: pure, no state) answers where it is asked.
     */
    const tool = (name, description, input, run, { agents = false, local = false } = {}) => ctx.tool(name, {
      description, input, callers: agents ? [...PEOPLE, ...AGENTS] : PEOPLE,
      run: async (i, meta) => {
        const w = await who(i, meta.caller);
        const { as: _as, ...rest } = i || {};
        if (!local && role === "local" && (await checkLink())) return forward(name, w.person ? rest : { ...rest, as: { source: w.source, name: w.name } });
        return run(rest, w);
      },
    });

    tool("planner.add", "Add an alarm, timer, reminder, todo, note or event. Times: at (ISO or ms), in_ms for a timer, or wall \"HH:MM\" with date \"YYYY-MM-DD\" and repeat {every: day|weekday|week|month|year, days?, interval?, until?}. Or give text (\"alarm 7am\") to read it, with kind as a hint. Anyone may add alarms, timers, reminders, todos and notes.",
      { type: "object", properties: { kind: { type: "string", enum: KINDS }, text: str, ...itemFields } },
      async (i, w) => add(i, w), { agents: true });

    tool("planner.list", "Items, newest time first: filter by kind, state (open by default; all), list, project, pinned, tag; limit up to 500.",
      { type: "object", properties: { kind: { type: "string", enum: KINDS }, state: { type: "string", enum: [...STATES, "all"] }, list: str, project: str, pinned: bool, tag: str, limit: int } },
      async i => st.list({ ...i, limit: Math.min(500, Math.max(1, i.limit || 100)) }).map(shape), { agents: true });

    tool("planner.get", "One item and its latest firings, by item or firing id.",
      ref,
      async i => {
        const f = i.firing ? st.firing(i.firing) : null;
        const item = st.item(f ? f.item : i.item);
        if (!item) {
          const row = cal.row(f ? f.item : i.item);
          if (row) return { item: shapeCal(row), firings: st.firingsOf(row.id).map(shapeFiring), ...(f ? { firing: shapeFiring(f) } : {}) };
          throw fail("no such item", "not_found");
        }
        return { item: shape(item), firings: st.firingsOf(item.id).map(shapeFiring), ...(f ? { firing: shapeFiring(f) } : {}) };
      }, { agents: true });

    tool("planner.ringing", "What is ringing now, shaped like planner.fired, so a surface that connects late can show its banners.",
      { type: "object", properties: {} },
      async () => st.allRinging().map(f => {
        const it = st.item(f.item) || cal.row(f.item);
        return { firing: f.id, item: f.item, kind: f.kind, title: it ? String(it.title || "") : "", due: f.due, ring: f.ring, missed: Boolean(f.missed), actions: ["done", "snooze"],
          ...(it && it.source_name ? { added_by: it.source_name } : {}) };
      }), { agents: true });

    tool("planner.update", "Change an item: title, body, list, priority, pinned, tags, project, thread, parent, state (open, done, cancelled) or its time. An agent may change only the items it added.",
      { type: "object", required: ["item"], properties: { item: str, kind: str, state: { type: "string", enum: STATES }, ...itemFields } },
      async (i, w) => update(i, w), { agents: true });

    tool("planner.done", "Done: acknowledge a firing (an alarm stops ringing; a repeating one keeps its schedule) or finish a todo or reminder. Give firing or item.",
      ref, async (i, w) => done(i, w), { agents: true });

    tool("planner.snooze", "Snooze a firing or an item: it rings again after minutes (9 by default).",
      { type: "object", properties: { firing: str, item: str, minutes: { type: "number" } } }, async (i, w) => snooze(i, w), { agents: true });

    tool("planner.dismiss", "Stop a firing without finishing a todo. A one-off alarm, timer or reminder ends.",
      ref, async (i, w) => dismiss(i, w), { agents: true });

    tool("planner.delete", "Delete an item. It can be restored (restore: true) for 30 days.",
      { type: "object", required: ["item"], properties: { item: str, restore: bool } }, async (i, w) => remove(i, w), { agents: true });

    tool("planner.agenda", "What is on between from and to (today in the planner's zone by default): alarms, reminders, timers and events, the connected calendars' events, and the todos due. Each entry has source (\"planner\" or the Google account's name), start, end, all_day, where, url. busy: true returns only the busy intervals, merged. next: n returns the next n entries from now.",
      { type: "object", properties: { from: when, to: when, busy: bool, next: int } }, async i => agenda(i), { agents: true });

    tool("planner.calendar.sync", "Read the connected Google calendars (a day back to 14 days ahead) into the planner's copy now. It also runs every 15 minutes while an account is connected.",
      { type: "object", properties: {} }, async () => cal.sync(), { agents: true });

    tool("planner.calendar.create", "Make an event. Without account it is the planner's own event. With account it is written to that Google calendar through google.calendar.create; attendees mean invites, which wait at the Gate for the user (returns { held, message }). Agents may only ask for an invite (account and attendees).",
      { type: "object", required: ["title", "start"], properties: { title: str, start: when, end: when, where: str, attendees: { anyOf: [str, { type: "array", items: str }] },
        account: str, tz: str, why: str, project: str, thread: str } },
      async (i, w) => createEvent(i, w), { agents: true });

    tool("planner.parse", "Read words like \"alarm 7am\", \"timer 10 min\" or \"remind me to call the printer at 6\" into a proposed item { kind, title, at (ms), tz, duration?, repeat? }, { ambiguous, reason } when they cannot be placed, or null. kind is a hint. Answers where it is asked, never forwarded.",
      { type: "object", required: ["text"], properties: { text: str, kind: { type: "string", enum: KINDS } } }, async i => parseText(i.text, now(), i.kind), { agents: true, local: true });

    tool("planner.settings", "The planner's zone (floating alarms follow it), escalate_after (minutes, from 1), escalate_max (rings after the first) and event_lead (minutes). With no input, the current settings.",
      { type: "object", properties: { timezone: str, escalate_after: int, escalate_max: int, event_lead: int } }, async i => changeSettings(i));

    // ---- Start --------------------------------------------------------------------------------

    if (role === "local") {
      try { await checkLink(); } catch { linked = false; }
    }
    if (!linked) scheduler.start();
    offs.push(...cal.watch());

    return {
      scheduler,
      calendar: cal,
      async stop() { scheduler.stop(); for (const off of offs) { try { off(); } catch {} } },
    };
  },
};
