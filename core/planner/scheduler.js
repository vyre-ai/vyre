// @ts-check
// One timer for everything the planner waits on (ADR 0025 points 4 to 7): the earliest item due,
// the earliest escalation and the earliest wake hook (a calendar sync, later). No polling: the
// timer is set to that moment, capped at 6 hours so a clock that jumps is noticed, and recomputed
// on every change. With nothing due there is no timer at all. The timer is unref'd, so it never
// holds vyred open, and now/setTimer/clearTimer are injected so tests run on a fake clock.

import { nextOccurrence, toUTC, parseDate, parseWall } from "./time.js";
import { newId } from "./store.js";

export const CAP_MS = 6 * 3_600_000;
const DRIFT_MS = 60_000;
const STALE_MS = 24 * 3_600_000;
const LATE_MS = 60_000;

/** @typedef {{ timezone: string, escalate_after: number, escalate_max: number, event_lead: number }} Settings */

/** The zone an item's wall time is read in: the planner's own for a floating item. */
export const zoneOf = (item, s) => (item.floating || !item.tz ? s.timezone : item.tz);

/**
 * When an item next rings after an instant, and the moment it is for (an event rings event_lead
 * minutes before its start). A repeating item walks its rule in its zone; a floating one-off
 * re-reads its wall time in the planner's zone, so it follows a zone change.
 * @param {any} item a row @param {number} after @param {Settings} s
 * @returns {{ at: number | null, next: number | null }}
 */
export function nextFire(item, after, s) {
  if (item.state !== "open" || item.deleted_at || item.kind === "note") return { at: item.at ?? null, next: null };
  const zone = zoneOf(item, s);
  const lead = item.kind === "event" ? s.event_lead * 60_000 : 0;
  const repeat = typeof item.repeat === "string" ? JSON.parse(item.repeat) : item.repeat;
  let start = item.at ?? null;
  if (repeat && item.wall) start = nextOccurrence({ wall: item.wall, tz: zone, after: after + lead, repeat });
  else if (item.floating && item.wall && item.date) {
    const d = parseDate(item.date), w = parseWall(item.wall);
    if (d && w) start = toUTC(d, w, zone);
  }
  if (start == null) return { at: repeat ? item.at ?? null : null, next: null };
  const next = start - lead;
  return { at: start, next: next > after ? next : null };
}

export class Scheduler {
  /**
   * @param {{ st: ReturnType<typeof import("./store.js").store>, settings: () => Settings,
   *   fired: (firing: any, item: any) => void, log: (m: string) => void, now?: () => number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} deps
   */
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || Date.now;
    this.setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; });
    this.clearTimer = deps.clearTimer || (t => clearTimeout(t));
    this.timer = null;
    /** When the timer was meant to wake, to notice a clock that jumped. */
    this.expected = null;
    this.idle = true;
    /** @type {{ next: (now: number) => number | null, run: (now: number) => any }[]} */
    this.hooks = [];
  }

  /** Begin: catch up on what fell due while vyred was down, then wait for the next thing. */
  start() { this.idle = false; this.tick(); }

  /** Stop waiting (a Mac paired with a box leaves the ringing to the box). */
  stop() { this.idle = true; this.disarm(); }

  /** Something that wants waking at a moment of its own (a calendar sync). */
  hook(h) { this.hooks.push(h); this.arm(); }

  disarm() { if (this.timer) this.clearTimer(this.timer); this.timer = null; this.expected = null; }

  /** The earliest moment anything is waiting for, or null. */
  nextMoment() {
    let at = this.d.st.earliest();
    for (const h of this.hooks) { const n = h.next(this.now()); if (n != null && (at == null || n < at)) at = n; }
    return at;
  }

  /** Set the one timer to the earliest moment, at most 6 hours out. */
  arm() {
    this.disarm();
    if (this.idle) return;
    const at = this.nextMoment();
    if (at == null) return;
    const now = this.now();
    // Never a tight loop: something already due is looked at a second from now at the soonest.
    const wait = Math.min(CAP_MS, Math.max(at - now, 1000));
    this.expected = now + wait;
    this.timer = this.setTimer(() => this.wake(), wait);
  }

  /** The timer went off: check the clock kept pace, then do what is due. */
  wake() {
    this.timer = null;
    const now = this.now();
    if (this.expected != null && Math.abs(now - this.expected) > DRIFT_MS) {
      this.d.log(`planner: the clock moved ${Math.round((now - this.expected) / 1000)} s from what the timer expected; recomputing`);
    }
    this.expected = null;
    this.tick();
  }

  /** Fire what is due, ring again what nobody acknowledged, run due hooks, then re-arm. */
  tick() {
    if (this.idle) return;
    const now = this.now();
    const s = this.d.settings();
    const { st } = this.d;
    for (const item of st.itemsDue(now)) {
      try { this.fireItem(item, now, s); }
      catch (e) {
        // A row that cannot be scheduled must not wake us again and again.
        st.patch(item.id, { next_fire: null, snooze_until: null });
        this.d.log(`planner: item ${item.id} could not fire (${/** @type {Error} */ (e).message}); it is left unscheduled`);
      }
    }
    for (const f of st.ringsDue(now)) {
      const ring = f.ring + 1;
      const more = ring < 1 + s.escalate_max;
      st.patchFiring(f.id, { ring, next_ring: more ? now + s.escalate_after * 60_000 : null });
      const item = st.item(f.item);
      if (item) this.d.fired({ ...f, ring }, item);
    }
    for (const h of this.hooks) {
      const n = h.next(now);
      if (n != null && n <= now) { try { h.run(now); } catch (e) { this.d.log(`planner: ${/** @type {Error} */ (e).message}`); } }
    }
    st.purge(now);
    this.arm();
  }

  /** One item is due: make its firing, and move a repeating item on to its next time. */
  fireItem(item, now, s) {
    const { st } = this.d;
    const fromSnooze = item.snooze_until != null && item.snooze_until <= now;
    const fromRule = item.next_fire != null && item.next_fire <= now;
    let dueAt = fromSnooze ? item.snooze_until : item.next_fire;
    const patch = /** @type {any} */ ({ updated: now });
    if (fromSnooze) patch.snooze_until = null;
    if (fromRule) {
      if (item.repeat && item.wall) {
        // Down for a week: one ring for the latest missed time, not seven.
        let t = item.next_fire;
        for (let i = 0; i < 1000; i++) { const n = nextFire(item, t, s).next; if (n == null || n > now) break; t = n; }
        if (!fromSnooze) dueAt = t;
        const n = nextFire(item, now, s);
        patch.next_fire = n.next;
        patch.at = n.at;
      } else patch.next_fire = null;
    }
    st.patch(item.id, patch);
    // Answered on a device that rang it while the box was out of reach (planner.done with a key):
    // the box does not ring that moment again (ADR 0029, R6).
    const pre = st.firingAt(item.id, dueAt);
    if (pre && pre.state === "acked") return;
    // A new ring for an item replaces one still ringing from before.
    st.supersede(item.id);
    const missed = now - dueAt > LATE_MS;
    // A task runs quietly once (team-lead, 2026-09-28): it is not an alarm nobody answered, it is
    // an instruction that already ran (runTask, on this same fired()) - escalating it would run
    // that instruction again, unattended, every escalate_after minutes up to escalate_max times.
    const f = { id: newId("f"), item: item.id, kind: item.kind, due: dueAt, ring: 1, missed, state: "ringing", fired_at: now,
      next_ring: item.kind === "task" ? null : (s.escalate_max > 0 ? now + s.escalate_after * 60_000 : null) };
    if (now - dueAt > STALE_MS) {
      // A day stale: kept as missed, never rung.
      st.insertFiring({ ...f, ring: 0, state: "missed", next_ring: null });
      return;
    }
    st.insertFiring(f);
    this.d.fired(f, { ...item, ...patch });
  }
}
