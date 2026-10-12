// @ts-check
// ONE door session per team Space, shared by every call the app makes to it (a world load is 8 to 15 calls; the peer door counts a stream open per session). Opened on the first call, reused by the rest
// (calls run side by side on it), closed after IDLE_MS with nothing to do, and dropped at once when a call dies in the transport (not when the door refused it in words: a refusal says the session works).
// `open(space)` is the app's own (join-team.js homeSession); it is passed in so a test uses a counting stand-in.

export const IDLE_MS = 60_000;
/** The codes that mean the session itself is gone, not that the door said no. */
const GONE = new Set(["unreachable", "unavailable", "timeout", "closed", "relay_removed"]);

/** Did this call die in the transport (no answer came back), as opposed to the door answering, even with a refusal? @param {any} err */
export const isTransportFailure = (err) => { const code = err && err.code; return !code || GONE.has(code); };

/**
 * @param {{ open: (space: string) => Promise<{ call(name: string, args: any[], opt?: any): Promise<any>, close(): void }>, idleMs?: number, timers?: { set: (f: () => void, ms: number) => any, clear: (t: any) => void } }} o
 */
export function createSharedSessions(o) {
  const idleMs = o.idleMs ?? IDLE_MS;
  const timers = o.timers || { set: (/** @type {() => void} */ f, /** @type {number} */ ms) => setTimeout(f, ms), clear: (/** @type {any} */ t) => clearTimeout(t) };
  /** @type {Map<string, { p: Promise<any>, busy: number, timer: any }>} */ const held = new Map();
  const drop = (/** @type {string} */ space, /** @type {any} */ entry) => {
    if (held.get(space) !== entry) return;
    held.delete(space);
    if (entry.timer) timers.clear(entry.timer);
    entry.p.then((/** @type {any} */ s) => { try { s.close(); } catch { /* closed */ } }, () => {});
  };
  return {
    /** One call to a Space's door on its shared session. @param {string} space @param {string} name @param {any[]} [args] @param {any} [opt] */
    async call(space, name, args = [], opt = undefined) {
      let entry = held.get(space);
      if (!entry) {
        const made = { p: /** @type {Promise<any>} */ (Promise.resolve().then(() => o.open(space))), busy: 0, timer: /** @type {any} */ (null) };
        entry = made; held.set(space, made);
        made.p.catch(() => drop(space, made));
      }
      const e = entry;
      if (e.timer) { timers.clear(e.timer); e.timer = null; }
      e.busy++;
      try {
        const s = await e.p;
        return await s.call(name, args, opt);
      } catch (err) {
        if (isTransportFailure(err)) drop(space, e);
        throw err;
      } finally {
        e.busy--;
        if (e.busy === 0 && held.get(space) === e) e.timer = timers.set(() => { if (e.busy === 0) drop(space, e); }, idleMs);
      }
    },
    /** Close every session now (the showing Space changed, or the person signed out). */
    closeAll() { for (const [space, entry] of [...held]) drop(space, entry); },
    /** How many Spaces hold a session (for tests). */
    get size() { return held.size; },
  };
}
