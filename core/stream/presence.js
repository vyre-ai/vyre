// @ts-check
// presence: who is typing, and what an assistant is doing (ADR 0052). Ephemeral: the frame has no
// cursor, is never logged and never replayed. One per author every 3 seconds at most.

import { frame } from "./protocol.js";

export const PRESENCE_MS = 3000;

/**
 * @param {{ session: string, now?: () => number, minMs?: number }} o
 */
export function createPresence(o) {
  const now = o.now || Date.now;
  const minMs = o.minMs ?? PRESENCE_MS;
  /** @type {Map<string, number>} */ const lastAt = new Map();
  return {
    /**
     * A presence frame for `author`, or null when this author already sent one in the last 3 seconds.
     * @param {string} author @param {"typing"|"doing"} state @param {string} [doing] e.g. "running the tests"
     */
    set(author, state, doing) {
      const t = now();
      const prev = lastAt.get(author);
      if (prev !== undefined && t - prev < minMs) return null;
      lastAt.set(author, t);
      return frame("presence", { who: author, state, ...(doing ? { doing } : {}) }, { session: o.session, time: t, author });
    },
    /** Forget an author (they sent their message or left), so their next presence goes out at once. @param {string} author */
    clear(author) { lastAt.delete(author); },
  };
}

/**
 * Send presence through a log's live fan-out, throttled.
 * @param {import("./log.js").SessionLog} log
 */
export function presenceFor(log, now = Date.now, minMs = PRESENCE_MS) {
  const p = createPresence({ session: log.session, now, minMs });
  return {
    /** @param {string} author @param {"typing"|"doing"|"idle"} state @param {string} [doing] */
    set(author, state, doing) {
      const f = p.set(author, state, doing);
      if (!f) return null;
      return log.emit("presence", f.data, { time: f.time, author });
    },
    clear: p.clear,
  };
}
