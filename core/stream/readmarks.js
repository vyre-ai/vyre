// @ts-check
// readmarks: how far each person has read each session (ADR 0052). Stored per person, not per
// session: a person's devices share one marker, others never see it. A marker only moves forward.

import { frame } from "./protocol.js";

export function createReadMarkers() {
  /** @type {Map<string, Map<string, number>>} person -> session -> cursor */
  const marks = new Map();
  /** @type {Map<string, Set<(f: any) => void>>} person -> that person's devices */
  const devices = new Map();
  return {
    /** @param {string} person @param {string} session */
    get(person, session) { return marks.get(person)?.get(session) ?? 0; },
    /**
     * Move a person's marker forward and tell that person's devices (not anyone else). Returns the
     * frame, or null when the marker did not move.
     * @param {string} person "person:<id>" @param {string} session @param {number} upto
     */
    set(person, session, upto) {
      if (!person.startsWith("person:") || !Number.isInteger(upto) || upto < 0) throw new Error("a read marker is a person's, with a cursor");
      let m = marks.get(person);
      if (!m) { m = new Map(); marks.set(person, m); }
      if (upto <= (m.get(session) ?? 0)) return null;
      m.set(session, upto);
      const f = frame("read-marker", { upto }, { session, author: person });
      for (const fn of [...(devices.get(person) || [])]) { try { fn(f); } catch {} }
      return f;
    },
    /** One of a person's devices listens; it hears that person's markers only. Returns the unsubscribe. @param {string} person @param {(f: any) => void} fn */
    subscribe(person, fn) {
      let s = devices.get(person);
      if (!s) { s = new Set(); devices.set(person, s); }
      s.add(fn);
      return () => { s.delete(fn); };
    },
    /** Unread messages after the marker, given the session head. @param {string} person @param {string} session @param {number} head */
    unread(person, session, head) { return Math.max(0, head - (marks.get(person)?.get(session) ?? 0)); },
    /** The whole store, to persist per person. */
    toJSON() { return Object.fromEntries([...marks].map(([p, m]) => [p, Object.fromEntries(m)])); },
    /** @param {Record<string, Record<string, number>>} j */
    load(j) { for (const [p, m] of Object.entries(j || {})) marks.set(p, new Map(Object.entries(m))); },
  };
}
