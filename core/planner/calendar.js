// @ts-check
// The planner's copy of connected Google calendars (ADR 0025 point 11), kept as Event records (source google). The google module
// owns the accounts and their tokens; the planner only calls google.* tools through ctx.call, never
// a token. Every 15 minutes while any account is connected (a scheduler wake hook, so no timer of
// its own), and on google.added / google.removed, the window from a day ago to 14 days ahead is
// kept as Event records, the record's own id being the event's id here. Each timed event rings event_lead minutes before its start, once per
// (account, event, start), however often the cache is refreshed. All-day events never ring.

import { newId, ringKey } from "./store.js";
import { parseDate, toUTC } from "./time.js";

export const SYNC_EVERY = 15 * 60_000;
const DAY = 86_400_000;
const BEHIND = DAY, AHEAD = 14 * DAY;
/** google.calendar.list returns at most this many; a full page is read again in halves. */
const PAGE = 100;
const LATE_MS = 60_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A cached event as the tools show it: an agenda entry with the same fields as a planner one. */
export const shapeCal = r => r && ({
  id: r.id, source: r.account, account: r.account, event: r.event_id, kind: "event", title: r.title ?? "", at: r.start, start: r.start,
  end: r.end ?? null, all_day: Boolean(r.all_day), where: r.where_ ?? null, url: r.url ?? null, next_fire: r.next_fire ?? null, synced_at: r.synced_at,
});

/**
 * @param {{ ctx: any, st: ReturnType<typeof import("./store.js").store>, scheduler: import("./scheduler.js").Scheduler,
 *   settings: () => import("./scheduler.js").Settings, now: () => number, emit: (type: string, payload: any, item?: any) => void,
 *   cancelRinging: (id: string) => void, active: () => boolean }} deps
 */
export function calendarCache({ ctx, st, scheduler, settings, now, emit, cancelRinging, active }) {
  const cal = st.cal;

  /** The moment a cached event should ring, or null: never all-day, never twice for one start, never once it has begun. */
  const ringAt = (r, t, s) => {
    if (r.all_day || r.rung_start === r.start || r.start <= t) return null;
    return Math.max(r.start - s.event_lead * 60_000, t);
  };

  /** Start and end in ms. A date alone is all day, midnight to midnight in the planner's zone. */
  const times = (ev, tz) => {
    const allDay = DATE_ONLY.test(String(ev.start));
    const at = v => {
      if (!v) return null;
      const d = DATE_ONLY.test(String(v)) ? parseDate(v) : null;
      if (d) return toUTC(d, { hour: 0, minute: 0 }, tz);
      const ms = Date.parse(String(v));
      return Number.isFinite(ms) ? ms : null;
    };
    return { start: at(ev.start), end: at(ev.end), all_day: allDay };
  };

  /** One account's events in [from, to): a full page is read again as two halves, so nothing is cut off. */
  const read = async (account, from, to, depth = 0) => {
    const r = await ctx.call("google.calendar.list", { from: new Date(from).toISOString(), to: new Date(to).toISOString(), account, limit: PAGE });
    if (r.error) throw Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code });
    const d = r.data || {};
    if (Array.isArray(d.errors) && d.errors.length) throw new Error(d.errors.map(e => e.error).join("; "));
    const events = Array.isArray(d.events) ? d.events : [];
    if (events.length < PAGE || depth >= 6 || to - from <= 3_600_000) return events;
    const mid = from + Math.floor((to - from) / 2);
    const both = [...await read(account, from, mid, depth + 1), ...await read(account, mid, to, depth + 1)];
    return [...new Map(both.map(e => [String(e.id), e])).values()];
  };

  /** Put one event in the copy; a moved start is a new ring, the same start is not. @returns {Promise<"added"|"changed"|"same"|null>} */
  const upsert = async (ev, account, t, s) => {
    if (!ev || ev.id === undefined) return null;
    const { start, end, all_day } = times(ev, s.timezone);
    if (start == null) return null;
    const old = cal.ofAccount(account).find(r => r.event_id === String(ev.id));
    const title = String(ev.title ?? "").slice(0, 500), where = ev.where ? String(ev.where).slice(0, 500) : null, url = ev.url ? String(ev.url) : null;
    if (!old) {
      const r = { account, event_id: String(ev.id), title, start, end, all_day: all_day ? 1 : 0, where_: where, url, synced_at: t, rung_start: null, snooze_until: null };
      const id = await cal.insert({ ...r, next_fire: null });
      cal.patch(id, { next_fire: ringAt({ ...r, id }, t, s) });
      return "added";
    }
    const moved = old.start !== start || Boolean(old.all_day) !== all_day;
    const r = { ...old, start, end, all_day: all_day ? 1 : 0 };
    // The same start keeps what it had: a pending ring, a snooze, or the fact it already rang.
    const next = moved ? ringAt(r, t, s) : old.next_fire;
    const same = !moved && old.title === title && (old.end ?? null) === end && (old.where_ ?? null) === where && (old.url ?? null) === url;
    cal.patch(old.id, { title, start, end, all_day: all_day ? 1 : 0, where_: where, url, synced_at: t, next_fire: next, snooze_until: moved ? null : old.snooze_until });
    return same ? "same" : "changed";
  };

  const drop = id => { cancelRinging(id); cal.drop(id); };

  // ---- Sync ----------------------------------------------------------------------------------

  /** null until the first look at google.accounts; then whether any account is connected. */
  let connected = /** @type {boolean | null} */ (null);
  let lastAttempt = /** @type {number | null} */ (null);
  let probeAt = /** @type {number | null} */ (null);
  /** @type {Promise<any> | null} */
  let running = null;

  const sync = () => {
    if (running) return running;
    running = (async () => {
      const t = now();
      lastAttempt = t;
      probeAt = null;
      try { return await syncOnce(t); } finally { running = null; scheduler.arm(); }
    })();
    return running;
  };

  const syncOnce = async t => {
    const got = await ctx.call("google.accounts", {});
    if (got.error) {
      // No google module (yet, or at all): look once more a minute on, then wait for google.added.
      if (connected === null && got.error.code === "no_such_tool") probeAt = t + 60_000;
      connected = false;
      return { synced_at: null, accounts: [], events: 0, added: 0, changed: 0, removed: 0, errors: [{ account: null, error: got.error.message || got.error.code }] };
    }
    const names = (Array.isArray(got.data) ? got.data : []).map(a => String(a.name)).filter(Boolean);
    connected = names.length > 0;
    let removed = 0;
    // An account that is gone takes its events with it.
    for (const account of cal.accounts()) {
      if (names.includes(String(account))) continue;
      for (const { id } of cal.ofAccount(account)) { drop(String(id)); removed++; }
    }
    const from = t - BEHIND, to = t + AHEAD;
    const errors = [], counts = { added: 0, changed: 0 };
    let events = 0;
    for (const account of names) {
      let list;
      try { list = await read(account, from, to); }
      catch (e) {
        // One account failing keeps its old copy and does not hold up the rest.
        errors.push({ account, error: String(/** @type {Error} */ (e).message || e).slice(0, 300) });
        continue;
      }
      const s = settings();
      const seen = new Set();
      for (const ev of list) {
        const k = await upsert(ev, account, t, s);
        if (!k) continue;
        seen.add(String(ev.id));
        events++;
        if (k === "added") counts.added++; else if (k === "changed") counts.changed++;
      }
      for (const r of cal.ofAccount(account)) if (!seen.has(String(r.event_id))) { drop(String(r.id)); removed++; }
    }
    const synced_at = now();
    st.state.set("calendar", { synced_at, from, to, accounts: names, errors });
    // Devices keep their own 48 hours of rings (ADR 0029, R6): tell them the calendar's moved.
    if (counts.added || counts.changed || removed) emit("planner.schedule", { reason: "calendar" });
    if (errors.length) ctx.log(`planner: calendar sync had errors for ${errors.map(e => e.account).join(", ")}`);
    return { synced_at, accounts: names, events, ...counts, removed, ...(errors.length ? { errors } : {}) };
  };

  // Every 15 minutes while an account is connected; not at all otherwise.
  scheduler.hook({
    next: t => {
      if (probeAt != null) return probeAt;
      if (!connected) return null;
      return (lastAttempt ?? t) + SYNC_EVERY;
    },
    run: () => { sync().catch(e => ctx.log(`planner: calendar sync failed (${/** @type {Error} */ (e).message})`)); },
  });

  // ---- Rings -----------------------------------------------------------------------------------

  /** Ring what is due: a start event_lead minutes away, or a snooze that ran out. */
  const fireDue = t => {
    const s = settings();
    const due = cal.rows().filter(r => (r.next_fire != null && r.next_fire <= t) || (r.snooze_until != null && r.snooze_until <= t)).sort((a, b) => a.start - b.start);
    for (const r of due) {
      const fromSnooze = r.snooze_until != null && r.snooze_until <= t;
      const fromLead = r.next_fire != null && r.next_fire <= t;
      if (fromLead) cal.patch(r.id, { next_fire: null });
      if (fromSnooze) cal.patch(r.id, { snooze_until: null });
      let at;
      if (fromSnooze) at = r.snooze_until;
      else {
        if (r.all_day || r.rung_start === r.start) continue;
        cal.patch(r.id, { rung_start: r.start });
        at = r.start - s.event_lead * 60_000;
        // Begun already (vyred was down), or rung before under this id: kept quiet.
        if (t >= r.start || st.firingAt(r.id, at)) continue;
      }
      // Late means late for the moment it was set to ring (a sync that found it inside the lead rings at once).
      const meant = fromSnooze ? r.snooze_until : Math.max(at, r.next_fire);
      st.supersede(r.id);
      const f = { id: newId("f"), item: r.id, kind: "event", due: at, ring: 1, missed: t - meant > LATE_MS, state: "ringing", fired_at: t, next_ring: null };
      st.insertFiring(f);
      emit("planner.fired", { firing: f.id, key: ringKey(r.id, at), item: r.id, kind: "event", title: r.title ?? "", due: at, ring: 1, missed: f.missed,
        actions: ["done", "snooze"], account: r.account, start: r.start });
    }
  };
  scheduler.hook({
    next: () => { let at = null; for (const r of cal.rows()) for (const x of [r.next_fire, r.snooze_until]) if (x != null && (at == null || x < at)) at = x; return at; },
    run: t => fireDue(t),
  });

  return {
    sync,
    /** A settled promise for tests and callers that want the background sync done. */
    settled: async () => { while (running) { try { await running; } catch {} } },
    connected: () => connected,
    row: id => cal.row(String(id)),
    upsert: async (ev, account) => { const r = await upsert(ev, account, now(), settings()); scheduler.arm(); return r; },
    /** After a start: each event's ring state from the firings kept with it (what already rang, a snooze still waiting), and the next ring. */
    prime() {
      const t = now(), s = settings();
      for (const r of cal.rows()) {
        if (r.all_day) continue;
        const at = r.start - s.event_lead * 60_000;
        const rang = Boolean(st.firingAt(r.id, at));
        const newest = st.firingsOf(r.id, 1)[0];
        const snooze = newest && newest.state === "acked" && newest.action === "snooze" && newest.until != null && newest.until > t ? newest.until : null;
        cal.patch(r.id, { rung_start: rang ? r.start : null, snooze_until: snooze, next_fire: rang ? null : ringAt({ ...r, rung_start: null }, t, s) });
      }
      scheduler.arm();
    },
    /** A new event_lead moves every pending ring. */
    relead() {
      const t = now(), s = settings();
      for (const r of cal.rows()) if (!r.all_day) cal.patch(r.id, { next_fire: ringAt(r, t, s) });
      scheduler.arm();
    },
    snooze(id, until) { cal.patch(String(id), { snooze_until: until }); scheduler.arm(); },
    clearSnooze(id) { cal.patch(String(id), { snooze_until: null }); scheduler.arm(); },
    /** Start sync on account changes and look once at start. */
    watch() {
      const offs = [];
      const kick = () => { if (active()) sync().catch(e => ctx.log(`planner: calendar sync failed (${/** @type {Error} */ (e).message})`)); };
      offs.push(ctx.events.on("google.added", kick));
      offs.push(ctx.events.on("google.removed", kick));
      kick();
      return offs;
    },
  };
}
