// @ts-check
// The planner's read-only copy of connected Google calendars (ADR 0025 point 11). The google module
// owns the accounts and their tokens; the planner only calls google.* tools through ctx.call, never
// a token. Every 15 minutes while any account is connected (a scheduler wake hook, so no timer of
// its own), and on google.added / google.removed, the window from a day ago to 14 days ahead is
// read into planner_calendar. Each timed event rings event_lead minutes before its start, once per
// (account, event, start), however often the cache is refreshed. All-day events never ring.

import crypto from "node:crypto";
import { newId } from "./store.js";
import { parseDate, toUTC } from "./time.js";

export const SYNC_EVERY = 15 * 60_000;
const DAY = 86_400_000;
const BEHIND = DAY, AHEAD = 14 * DAY;
/** google.calendar.list returns at most this many; a full page is read again in halves. */
const PAGE = 100;
const LATE_MS = 60_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** One cache row per (account, event), with an id that stays the same across resyncs. */
export const rowId = (account, eventId) => `c_${crypto.createHash("sha256").update(`${account}\0${eventId}`).digest("base64url").slice(0, 16)}`;

/** A cached event as the tools show it: an agenda entry with the same fields as a planner one. */
export const shapeCal = r => r && ({
  id: r.id, source: r.account, account: r.account, event: r.event_id, kind: "event", title: r.title ?? "", at: r.start, start: r.start,
  end: r.end ?? null, all_day: Boolean(r.all_day), where: r.where_ ?? null, url: r.url ?? null, next_fire: r.next_fire ?? null, synced_at: r.synced_at,
});

/**
 * @param {{ ctx: any, db: import("node:sqlite").DatabaseSync, st: any, scheduler: import("./scheduler.js").Scheduler,
 *   settings: () => import("./scheduler.js").Settings, now: () => number, emit: (type: string, payload: any, item?: any) => void,
 *   cancelRinging: (id: string) => void, active: () => boolean }} deps
 */
export function calendarCache({ ctx, db, st, scheduler, settings, now, emit, cancelRinging, active }) {
  const q = {
    row: db.prepare("SELECT * FROM planner_calendar WHERE id = ?"),
    ofAccount: db.prepare("SELECT id FROM planner_calendar WHERE account = ?"),
    accounts: db.prepare("SELECT DISTINCT account FROM planner_calendar"),
    insert: db.prepare(`INSERT INTO planner_calendar (id, account, event_id, title, start, end, all_day, where_, url, synced_at, next_fire)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    update: db.prepare(`UPDATE planner_calendar SET title = ?, start = ?, end = ?, all_day = ?, where_ = ?, url = ?, synced_at = ?, next_fire = ?,
      snooze_until = ? WHERE id = ?`),
    drop: db.prepare("DELETE FROM planner_calendar WHERE id = ?"),
    firedFor: db.prepare("SELECT 1 FROM planner_firings WHERE item = ? AND kind = 'event' AND due = ? LIMIT 1"),
    next: db.prepare("SELECT MIN(x) AS x FROM (SELECT MIN(next_fire) AS x FROM planner_calendar WHERE next_fire IS NOT NULL UNION ALL SELECT MIN(snooze_until) FROM planner_calendar WHERE snooze_until IS NOT NULL)"),
    due: db.prepare("SELECT * FROM planner_calendar WHERE (next_fire IS NOT NULL AND next_fire <= ?) OR (snooze_until IS NOT NULL AND snooze_until <= ?) ORDER BY start"),
    timed: db.prepare("SELECT * FROM planner_calendar WHERE all_day = 0"),
  };

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

  /** Put one event in the cache; a moved start is a new ring, the same start is not. @returns {"added"|"changed"|"same"|null} */
  const upsert = (ev, account, t, s) => {
    if (!ev || ev.id === undefined) return null;
    const { start, end, all_day } = times(ev, s.timezone);
    if (start == null) return null;
    const id = rowId(account, String(ev.id));
    const old = /** @type {any} */ (q.row.get(id));
    const title = String(ev.title ?? "").slice(0, 500), where = ev.where ? String(ev.where).slice(0, 500) : null, url = ev.url ? String(ev.url) : null;
    if (!old) {
      const r = { id, account, event_id: String(ev.id), start, end, all_day: all_day ? 1 : 0, rung_start: null };
      q.insert.run(id, account, String(ev.id), title, start, end, all_day ? 1 : 0, where, url, t, ringAt(r, t, s));
      return "added";
    }
    const moved = old.start !== start || Boolean(old.all_day) !== all_day;
    const r = { ...old, start, end, all_day: all_day ? 1 : 0 };
    // The same start keeps what it had: a pending ring, a snooze, or the fact it already rang.
    const next = moved ? ringAt(r, t, s) : old.next_fire;
    q.update.run(title, start, end, all_day ? 1 : 0, where, url, t, next, moved ? null : old.snooze_until, id);
    const same = !moved && old.title === title && (old.end ?? null) === end && (old.where_ ?? null) === where && (old.url ?? null) === url;
    return same ? "same" : "changed";
  };

  const drop = id => { cancelRinging(id); q.drop.run(id); };

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
    for (const { account } of /** @type {any[]} */ (q.accounts.all())) {
      if (names.includes(String(account))) continue;
      for (const { id } of /** @type {any[]} */ (q.ofAccount.all(account))) { drop(String(id)); removed++; }
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
        const k = upsert(ev, account, t, s);
        if (!k) continue;
        seen.add(rowId(account, String(ev.id)));
        events++;
        if (k === "added") counts.added++; else if (k === "changed") counts.changed++;
      }
      for (const { id } of /** @type {any[]} */ (q.ofAccount.all(account))) if (!seen.has(String(id))) { drop(String(id)); removed++; }
    }
    const synced_at = now();
    st.state.set("calendar", { synced_at, from, to, accounts: names, errors });
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
    for (const r of /** @type {any[]} */ (q.due.all(t, t))) {
      const fromSnooze = r.snooze_until != null && r.snooze_until <= t;
      const fromLead = r.next_fire != null && r.next_fire <= t;
      if (fromLead) db.prepare("UPDATE planner_calendar SET next_fire = NULL WHERE id = ?").run(r.id);
      if (fromSnooze) db.prepare("UPDATE planner_calendar SET snooze_until = NULL WHERE id = ?").run(r.id);
      let due;
      if (fromSnooze) due = r.snooze_until;
      else {
        if (r.all_day || r.rung_start === r.start) continue;
        db.prepare("UPDATE planner_calendar SET rung_start = ? WHERE id = ?").run(r.start, r.id);
        due = r.start - s.event_lead * 60_000;
        // Begun already (vyred was down), or rung before under this id: kept quiet.
        if (t >= r.start || q.firedFor.get(r.id, due)) continue;
      }
      // Late means late for the moment it was set to ring (a sync that found it inside the lead rings at once).
      const meant = fromSnooze ? r.snooze_until : Math.max(due, r.next_fire);
      db.prepare("UPDATE planner_firings SET state = 'superseded', next_ring = NULL WHERE item = ? AND state = 'ringing'").run(r.id);
      const f = { id: newId("f"), item: r.id, kind: "event", due, ring: 1, missed: t - meant > LATE_MS, state: "ringing", fired_at: t, next_ring: null };
      st.insertFiring(f);
      emit("planner.fired", { firing: f.id, item: r.id, kind: "event", title: r.title ?? "", due, ring: 1, missed: f.missed,
        actions: ["done", "snooze"], account: r.account, start: r.start });
    }
  };
  scheduler.hook({
    next: () => { const r = /** @type {any} */ (q.next.get()); return r && r.x != null ? Number(r.x) : null; },
    run: t => fireDue(t),
  });

  return {
    sync,
    /** A settled promise for tests and callers that want the background sync done. */
    settled: async () => { while (running) { try { await running; } catch {} } },
    connected: () => connected,
    row: id => /** @type {any} */ (q.row.get(String(id))),
    upsert: (ev, account) => { const r = upsert(ev, account, now(), settings()); scheduler.arm(); return r; },
    /** A new event_lead moves every pending ring. */
    relead() {
      const t = now(), s = settings();
      for (const r of /** @type {any[]} */ (q.timed.all())) {
        db.prepare("UPDATE planner_calendar SET next_fire = ? WHERE id = ?").run(ringAt(r, t, s), r.id);
      }
      scheduler.arm();
    },
    snooze(id, until) { db.prepare("UPDATE planner_calendar SET snooze_until = ? WHERE id = ?").run(until, String(id)); scheduler.arm(); },
    clearSnooze(id) { db.prepare("UPDATE planner_calendar SET snooze_until = NULL WHERE id = ?").run(String(id)); scheduler.arm(); },
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
