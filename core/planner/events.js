// @ts-check
// The planner's calendar: the Space's Event records, the same ones the connectors' calendar sync writes and the planner's own events are made as. There is no copy of
// any calendar here. The planner keeps a working set of the events it will ring for (a day back to 14 days ahead), read from the records and kept current by the
// kernel's own `event.*` events, so a change from the app, a Flow or a sync rings correctly without anything polling. Each timed event rings event_lead minutes
// before its start, once per start, however often it is read again. All-day events never ring.

import { newId, ringKey } from "./items.js";
import { fromEvent } from "./records.js";

export const REFRESH_EVERY = 15 * 60_000;
const DAY = 86_400_000;
const LATE_MS = 60_000;

/** An event row as the tools show it: an agenda entry with the same fields as a planner one. */
export const shapeCal = r => r && ({
  id: r.id, source: r.own ? "planner" : r.account ?? "calendar", account: r.own ? null : r.account ?? null, event: r.event_id, kind: "event", title: r.title ?? "", at: r.start, start: r.start,
  end: r.end ?? null, all_day: Boolean(r.all_day), where: r.where_ ?? null, url: r.url ?? null, next_fire: r.next_fire ?? null, synced_at: r.synced_at, state: "open",
  ...(r.own ? { duration_ms: r.end != null ? r.end - r.start : null } : {}),
});

/**
 * @param {{ ctx: any, K: any, st: any, scheduler: import("./scheduler.js").Scheduler, settings: () => import("./scheduler.js").Settings, now: () => number,
 *   emit: (type: string, payload: any, item?: any) => void, active: () => boolean }} deps
 */
export function calendar({ ctx, K, st, scheduler, settings, now, emit, active }) {
  /** The moment an event should ring, or null: never all-day, never twice for one start, never once it has begun. */
  const ringAt = (r, t, s) => {
    if (r.all_day || r.rung_start === r.start || r.start <= t) return null;
    return Math.max(r.start - s.event_lead * 60_000, t);
  };

  /** A row read from the records, with what the planner already knew about the same event: a moved start is a new ring, the same start keeps its pending ring and snooze. */
  const settle = (r, old) => {
    const t = now(), s = settings();
    if (!old) {
      const rung = st.firingAt(r.id, r.start - s.event_lead * 60_000) ? r.start : null;
      const snoozed = st.firingsOf(r.id, 5).find(f => f.action === "snooze" && f.until != null && f.until > t);
      const row = { ...r, rung_start: rung, snooze_until: snoozed ? snoozed.until : null };
      return { ...row, next_fire: ringAt(row, t, s) };
    }
    const moved = old.start !== r.start || Boolean(old.all_day) !== Boolean(r.all_day);
    const row = { ...r, rung_start: moved ? null : old.rung_start, snooze_until: moved ? null : old.snooze_until };
    return { ...row, next_fire: moved ? ringAt(row, t, s) : old.next_fire };
  };

  let lastAttempt = /** @type {number | null} */ (null);
  /** @type {Promise<any> | null} */
  let running = null;

  /** Read the working set again from the records. */
  const sync = () => {
    if (running) return running;
    running = (async () => {
      lastAttempt = now();
      try {
        const r = await st.loadEvents(settle);
        if (r.added || r.changed || r.removed) emit("planner.schedule", { reason: "calendar" });
        return { synced_at: now(), events: r.events, added: r.added, changed: r.changed, removed: r.removed };
      } finally { running = null; scheduler.arm(); }
    })();
    return running;
  };

  // Events come in through the kernel's own events; the window only moves forward by itself, so a calendar that has events is read again now and then, and one with none costs no timer.
  scheduler.hook({
    next: t => (st.cal.rows().length ? (lastAttempt ?? t) + REFRESH_EVERY : null),
    run: () => { sync().catch(e => ctx.log(`planner: calendar refresh failed (${/** @type {Error} */ (e).message})`)); },
  });

  // ---- Rings -----------------------------------------------------------------------------------

  const nextRing = () => { let at = null; for (const r of st.cal.rows()) for (const x of [r.next_fire, r.snooze_until]) if (x != null && (at == null || x < at)) at = x; return at; };

  /** Ring what is due: a start event_lead minutes away, or a snooze that ran out. */
  const fireDue = t => {
    const s = settings();
    const due = st.cal.rows().filter(r => (r.next_fire != null && r.next_fire <= t) || (r.snooze_until != null && r.snooze_until <= t)).sort((a, b) => a.start - b.start);
    for (const r of due) {
      // The row is the working set's own, so what it said is read before it is changed.
      const snoozeAt = r.snooze_until, meantLead = r.next_fire, start = r.start;
      const fromSnooze = snoozeAt != null && snoozeAt <= t;
      const fromLead = meantLead != null && meantLead <= t;
      if (fromLead) st.cal.patch(r.id, { next_fire: null });
      if (fromSnooze) st.cal.patch(r.id, { snooze_until: null });
      let due;
      if (fromSnooze) due = snoozeAt;
      else {
        if (r.all_day || r.rung_start === r.start) continue;
        st.cal.patch(r.id, { rung_start: start });
        due = start - s.event_lead * 60_000;
        // Begun already (vyred was down), or rung before under this id: kept quiet.
        if (t >= start || st.firingAt(r.id, due)) continue;
      }
      // Late means late for the moment it was set to ring (a read that found it inside the lead rings at once).
      const meant = fromSnooze ? snoozeAt : Math.max(due, meantLead);
      st.supersedeRinging(r.id);
      const f = { id: newId("f"), item: r.id, kind: "event", due, ring: 1, missed: t - meant > LATE_MS, state: "ringing", fired_at: t, next_ring: null };
      st.insertFiring(f);
      emit("planner.fired", { firing: f.id, key: ringKey(r.id, due), item: r.id, kind: "event", title: r.title ?? "", due, ring: 1, missed: f.missed,
        actions: ["done", "snooze"], ...(r.account ? { account: r.account } : {}), start: r.start });
    }
  };
  scheduler.hook({ next: () => nextRing(), run: t => fireDue(t) });

  /** One event record changed or went away, as the log says. */
  const follow = async e => {
    const id = String(e.subject || "").split("/").pop();
    if (!id) return;
    if (/\.(removed|forgotten)$/.test(String(e.type))) { cancel(id); st.cal.drop(id); scheduler.arm(); return; }
    const rec = await K.records.get(K.serviceChain(), "event", id).catch(() => null);
    if (!rec) return;
    const row = fromEvent(rec, now());
    if (!row) return;
    const t = now();
    if (row.start < t - DAY || row.start > t + 14 * DAY) { st.cal.drop(id); scheduler.arm(); return; }
    const old = st.cal.row(id);
    st.cal.put(settle(row, old));
    if (!old || old.start !== row.start || old.title !== row.title) emit("planner.schedule", { reason: "calendar" });
    scheduler.arm();
  };
  const cancel = id => { const f = st.ringing(id); if (f) { st.patchFiring(f.id, { state: "cancelled", next_ring: null, acked_at: now(), action: "dismiss" }); emit("planner.acked", { firing: f.id, key: ringKey(id, f.due), item: id, due: f.due, action: "dismiss", by: "planner" }); } };

  return {
    sync,
    /** A settled promise for tests and callers that want the background read done. */
    settled: async () => { while (running) { try { await running; } catch {} } },
    row: id => st.cal.row(String(id)),
    /** Put an event the planner just made in the working set. */
    add(row) { const t = now(); if (row.start >= t - DAY && row.start <= t + 14 * DAY) st.cal.put(settle(row, st.cal.row(row.id))); scheduler.arm(); return st.cal.row(row.id) || row; },
    /** A new event_lead moves every pending ring. */
    relead() {
      const t = now(), s = settings();
      for (const r of st.cal.rows()) if (!r.all_day) st.cal.patch(r.id, { next_fire: ringAt(r, t, s) });
      scheduler.arm();
    },
    snooze(id, until) { st.cal.patch(id, { snooze_until: until }); scheduler.arm(); },
    clearSnooze(id) { st.cal.patch(id, { snooze_until: null }); scheduler.arm(); },
    cancel,
    /** Read once now, then follow the kernel's own event.* events. Returns what to call to stop. */
    watch() {
      const kick = () => { if (active()) sync().catch(e => ctx.log(`planner: calendar read failed (${/** @type {Error} */ (e).message})`)); };
      kick();
      const off = K.events.subscribe(K.serviceChain(), "planner-events", { type: "event.*" }, e => { if (active()) return follow(e).catch(err => ctx.log(`planner: an event change was not read (${err.message})`)); });
      return () => { try { if (typeof off === "function") off(); } catch {} };
    },
  };
}
