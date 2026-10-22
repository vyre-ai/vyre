// @ts-check
// A chat turn's kernel session stays open while its provider process is still producing events.
// Claude Code keeps working after a result (a background tool, a second fetch). The session ends
// 30 s after the last event, not after the first result. A frame for a session that ended moments
// ago reopens it for the same person, and the frame is delivered.

const GRACE_MS = 30_000;
/** How long after the session ended a late frame may reopen it. A frame in the incident arrived about 24 s after the end. */
const LATE_MS = 120_000;

/**
 * @param {any} sb the Switchboard
 */
export function createTurnTail(sb) {
  /** @type {Map<string, { timer: any, session: any }>} */
  const timers = new Map();
  /** Facts for Try again, kept after the session ends. @type {Map<string, { asker: string|null, chat: string|null, space: string|null }>} */
  const kept = new Map();
  /** When the grace ended the session, in the switchboard clock. @type {Map<string, number>} */
  const endedAt = new Map();

  const now = () => (typeof sb.deps.now === "function" ? sb.deps.now() : Date.now());
  /** @param {() => void} fn @param {number} ms */
  const later = (fn, ms) => {
    if (typeof sb.deps.later === "function") {
      const t = sb.deps.later(fn, ms);
      if (t && typeof t.unref === "function") t.unref();
      return t;
    }
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  };
  /** @param {any} t */
  const cancel = t => {
    if (t == null) return;
    if (typeof sb.deps.cancel === "function") sb.deps.cancel(t);
    else clearTimeout(t);
  };

  /** @param {string} id @param {any} k */
  const facts = (id, k) => {
    const rec = sb.record(id);
    return {
      asker: k && k.asker ? String(k.asker) : null,
      chat: rec && rec.chat ? String(rec.chat) : null,
      space: sb.turnSpace.get(id) || null,
    };
  };

  /** @param {string} id @param {any} k */
  const schedule = (id, k) => {
    const prev = timers.get(id);
    if (prev) cancel(prev.timer);
    const timer = later(() => {
      const cur = timers.get(id);
      if (!cur || cur.session !== k) return;
      timers.delete(id);
      // A newer session has replaced this one: leave it, and leave its own timer, alone.
      if (sb.ksCur.get(id) !== k) return;
      kept.set(id, facts(id, k));
      endedAt.set(id, now());
      void sb.endKernelSession(id, "30 s after its last event");
    }, GRACE_MS);
    timers.set(id, { timer, session: k });
  };

  return {
    /** Arm the grace for a chat turn that just ended. Later events of the same process reset it. @param {string} id */
    arm(id) {
      const k = sb.ksCur.get(id);
      if (!k || !k.turn) return;
      kept.set(id, facts(id, k));
      schedule(id, k);
    },

    /** An event arrived. If the grace is running for this session, start its 30 s again. @param {string} id */
    keep(id) {
      const held = timers.get(id);
      if (!held) return;
      const k = sb.ksCur.get(id);
      if (!k || held.session !== k || !k.turn) return;
      schedule(id, k);
    },

    /**
     * Reopen a session the grace ended, when this frame is still inside the late window.
     * Undefined when nothing is reopened, so the caller stays synchronous.
     * @param {string} id @returns {Promise<void>|undefined}
     */
    before(id) {
      if (sb.closing || sb.ksCur.get(id)) return;
      const st = sb.live.get(id);
      if (!st || st.stopping) return;
      const at = endedAt.get(id);
      if (at == null || now() - at > LATE_MS) return;
      const snap = kept.get(id);
      if (!snap || !snap.asker || !snap.chat) return;
      const rec = sb.record(id);
      if (!rec) return;
      endedAt.delete(id);
      const turn = { chat: snap.chat, asker: snap.asker, ...(snap.space ? { space: snap.space } : {}) };
      return sb.renewKernelSession(id, rec, turn, "late").then((/** @type {any} */ ok) => {
        const k2 = sb.ksCur.get(id);
        if (ok && k2 && k2.turn) schedule(id, k2);
      }).catch(() => {});
    },

    /**
     * One provider event, for the runner. Returns a promise only when a session is reopened first.
     * @param {string} id @param {any} st @param {any} m
     */
    deliver(id, st, m) {
      this.keep(id);
      const w = this.before(id);
      if (w) return w.then(() => { sb.onMessage(id, st, m); });
      sb.onMessage(id, st, m);
    },

    /** The person and chat a fresh Try again should open: the live session, else the one the grace ended. @param {string} id */
    last(id) {
      const k = sb.ksCur.get(id);
      const rec = sb.record(id);
      if (k && k.asker && rec && rec.chat) return { asker: String(k.asker), chat: String(rec.chat), space: sb.turnSpace.get(id) || null };
      const snap = kept.get(id);
      if (snap && snap.asker && snap.chat) return { asker: snap.asker, chat: snap.chat, space: snap.space || null };
      return null;
    },
  };
}
