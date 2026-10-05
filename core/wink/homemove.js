// @ts-check
// homemove: the one thing a HOME may ask of another home (a project move between two servers, lib/spaces/move-pull.js). The source home's spaces module opens a move for a Space
// (`wink.home-move.open`), and only then does the peer door admit a stranger home, for that Space and for one tool, `spaces.moves.pull`. Closing the move, or its expiry, shuts the door again.
// This file keeps who has a move open and the limits a stranger is held to; the door (core/daemon/peer-door.js) asks it on every request, and nothing else here reaches a tool.

const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MOVE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** The tool a home may call on another home, and nothing else. */
export const HOME_TOOL = "spaces.moves.pull";
/** A request per minute for one move, and the most an answer may carry (base64 text of one chunk, plus the envelope). */
export const HOME_LIMITS = Object.freeze({ perMinute: 240, answerChars: 1_048_576 + 16_384, channels: 4, channelsPerMinute: 12, maxOpenMs: 7 * 24 * 3_600_000, preStreams: 3, preRequests: 3, preMs: 10_000 });
/** What a stream may send before its auth has been verified: the pull protocol's two opening requests, nothing else (lib/spaces/move-pull.js). */
export const PRE_AUTH_REQUESTS = Object.freeze(["hello", "auth"]);
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {{ now?: () => number }} [o] */
export function createHomeMoves(o = {}) {
  const now = o.now || Date.now;
  /** @type {Map<string, { space: string, move_id: string, to: string, expires: number, stamps: number[], busy: boolean }>} */
  const open = new Map();
  /** Channel arrivals in the last minute, box-wide: a stranger cannot make the home dial-answer without limit. @type {number[]} */
  let arrivals = [];
  /** Streams that have not proven themselves yet, box-wide. They are charged here and never to a move's own budget, so a stranger cannot spend the real target's requests. */
  let preOpen = 0;
  const sweep = () => { const t = now(); for (const [k, m] of open) if (m.expires <= t) open.delete(k); };
  return {
    /** The source home opens a move: `to` is the target Space's id (what the move names, shown in logs), `expires` a time in ms. @param {{ space: string, move_id: string, to?: string, expires: number }} m */
    open(m) {
      if (!m || !SPACE_ID.test(String(m.space)) || !MOVE_ID.test(String(m.move_id))) throw err("bad_input", "a move names a space and a move id");
      const exp = Number(m.expires);
      if (!Number.isFinite(exp) || exp <= now()) throw err("bad_input", "a move needs an expiry in the future");
      if (exp - now() > HOME_LIMITS.maxOpenMs) throw err("bad_input", "a move stays open 7 days at most");
      sweep();
      for (const [k, v] of open) if (v.space === m.space && v.move_id !== m.move_id) open.delete(k);
      open.set(String(m.move_id), { space: String(m.space), move_id: String(m.move_id), to: String(m.to || ""), expires: exp, stamps: [], busy: false });
      return { space: String(m.space), move_id: String(m.move_id), expires: exp };
    },
    /** @param {{ move_id: string }} m */
    close(m) { return { closed: open.delete(String(m && m.move_id)) }; },
    /** Is a move open for this Space now? @param {string} space */
    isOpen(space) { sweep(); for (const m of open.values()) if (m.space === space) return true; return false; },
    any() { sweep(); return open.size > 0; },
    list() { sweep(); return [...open.values()].map(m => ({ space: m.space, move_id: m.move_id, expires: m.expires })); },
    /** A new channel of a stranger home: counted box-wide. Throws rate_limited when too many came in the last minute. */
    arrive() {
      const t = now();
      arrivals = arrivals.filter(x => t - x < 60_000);
      if (arrivals.length >= HOME_LIMITS.channelsPerMinute) throw err("rate_limited", "too many homes are asking; wait a minute");
      arrivals.push(t);
    },
    /** A stream begins before its auth: at most `preStreams` at once, box-wide. Returns the function that ends it (call once, on auth or on close). @returns {() => void} */
    preEnter() {
      if (preOpen >= HOME_LIMITS.preStreams) throw err("rate_limited", "too many homes are asking; wait a moment");
      preOpen++;
      let done = false;
      return () => { if (done) return; done = true; preOpen = Math.max(0, preOpen - 1); };
    },
    /** Is a move open for this Space? (Checked before auth too: it charges nothing.) */
    preCheck(/** @type {string} */ space) { sweep(); if (![...open.values()].some(x => x.space === space)) throw err("denied", "no move is open for that space"); },
    preOpenCount() { return preOpen; },
    /**
     * One request begins for a Space: the move must be open, the request count for the move within its minute, and no other request of the move in flight. Returns the function that ends it.
     * @param {string} space @returns {() => void}
     */
    begin(space) {
      sweep();
      const m = [...open.values()].find(x => x.space === space);
      if (!m) throw err("denied", "no move is open for that space");
      const t = now();
      m.stamps = m.stamps.filter(x => t - x < 60_000);
      if (m.stamps.length >= HOME_LIMITS.perMinute) throw err("rate_limited", "too many requests for this move; wait a minute");
      if (m.busy) throw err("rate_limited", "one request at a time");
      m.stamps.push(t); m.busy = true;
      return () => { m.busy = false; };
    },
  };
}
