// @ts-check
// lease — one surface types into a thread at a time (security floor, rule 4).
//
// Why: a Claude Code transcript is an append-only file. Two writers on one session append in
// turn, and the file becomes something neither side wrote; nothing downstream can merge it. The
// prototype nearly lost a long conversation that way. So typing needs the lease, and taking the
// lease is explicit: the others go read-only and are told who has it.
//
// Ported from the prototype's lease registry, with its three lessons:
//   - Expiry matters more than release. The common end of a lease is a lid closing, not a
//     polite hand-over, so a lease unheard from for TTL is free.
//   - Taking a lease whose holder went quiet is recorded as a take-over, with how long it was
//     silent, so a person can see the thread changed hands without anyone handing it over.
//   - Re-taking your own lease is not a conflict. A surface that reconnects is still itself.
// The registry is one table in vyred, the one process that is always there, so there is no
// clock skew between holders to reason about: every beat is stamped by the same clock.

export const TTL = 90_000;

/**
 * Is a process on this machine still there? ESRCH is the only "gone": EPERM means it runs as
 * someone else, which is still alive.
 * @param {number} pid
 */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code !== "ESRCH"; }
}

/**
 * The pid in a terminal's surface name ("cli:<pid>"), or 0. The CLI only reaches vyred over its
 * local socket, so the pid is a process on vyred's own machine and vyred can ask if it is alive.
 * @param {string} surface
 */
const cliPid = surface => { const m = /^cli:(\d+)$/.exec(String(surface)); return m ? Number(m[1]) : 0; };

/**
 * A person's own surfaces (their Deck, phone, Capsule, Glass, Lumen, Mac, web) are one participant: the names are anchored, and a surface only ever gets one of them from the caller vyred verified (surfaceOf in index.js), never from what a call says about itself. A tailnet login or a paired device is mapped to one there. They are one participant: they never lock each other out.
 * The keyboard is contested only between that person and a terminal process, an agent, another box or another person.
 * @param {string} surface
 */
export const ownSurface = surface => /^(?:deck|phone|capsule|glass|lumen|mac|web)(?::|$)/.test(String(surface));
export const sameKeyboard = (a, b) => a === b || (ownSurface(a) && ownSurface(b));

export class Leases {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {() => number} [now] @param {(pid: number) => boolean} [alive]
   */
  constructor(db, now = () => Date.now(), alive = pidAlive) {
    this.db = db;
    this.now = now;
    this.alive = alive;
  }

  /**
   * The live holder of a thread, or null. A terminal whose process has exited holds nothing:
   * `vyre threads start` takes the keyboard and returns, and waiting out the TTL for a process
   * that is gone locked every later `vyre threads send` out for 90 seconds.
   */
  holder(thread) {
    const l = /** @type {any} */ (this.db.prepare("SELECT * FROM threads_leases WHERE thread = ?").get(thread));
    if (!l || this.now() - Number(l.beat) >= TTL) return null;
    const pid = cliPid(l.surface);
    if (pid && !this.alive(pid)) return null;
    return { surface: String(l.surface), since: Number(l.since), beat: Number(l.beat) };
  }

  /**
   * Take the keyboard. Always succeeds: taking over is a person's choice, made on the surface
   * they are looking at. Returns who had it, so every surface can show the hand-over.
   * @returns {{ holder: string, previous: string|null, changed: boolean, took?: { from: string, silent_ms: number } }}
   */
  take(thread, surface) {
    const raw = /** @type {any} */ (this.db.prepare("SELECT * FROM threads_leases WHERE thread = ?").get(thread));
    const live = this.holder(thread);
    const now = this.now();
    if (live && sameKeyboard(live.surface, surface)) {
      if (live.surface !== surface) { this.db.prepare("UPDATE threads_leases SET surface = ?, beat = ? WHERE thread = ?").run(surface, now, thread); return { holder: surface, previous: live.surface, changed: true }; }
      this.db.prepare("UPDATE threads_leases SET beat = ? WHERE thread = ?").run(now, thread);
      return { holder: surface, previous: surface, changed: false };
    }
    const took = !live && raw && raw.surface !== surface ? { from: String(raw.surface), silent_ms: now - Number(raw.beat) } : undefined;
    this.db.prepare(`INSERT INTO threads_leases (thread, surface, since, beat) VALUES (?,?,?,?)
      ON CONFLICT(thread) DO UPDATE SET surface = excluded.surface, since = excluded.since, beat = excluded.beat`).run(thread, surface, now, now);
    return { holder: surface, previous: live ? live.surface : null, changed: true, ...(took ? { took } : {}) };
  }

  /**
   * May this surface type now? A free thread is taken on the way (a first keystroke is a claim);
   * one held by another live surface is refused, with who holds it.
   * @returns {{ ok: true, took?: ReturnType<Leases["take"]> } | { ok: false, holder: string }}
   */
  typing(thread, surface) {
    const live = this.holder(thread);
    if (live && !sameKeyboard(live.surface, surface)) return { ok: false, holder: live.surface };
    const r = this.take(thread, surface);
    return r.changed ? { ok: true, took: r } : { ok: true };
  }

  /** Let go. Idempotent: releasing what you do not hold changes nothing. */
  release(thread, surface) {
    const live = this.holder(thread);
    if (!live || (surface && live.surface !== surface)) return { released: false, holder: live ? live.surface : null };
    this.db.prepare("DELETE FROM threads_leases WHERE thread = ?").run(thread);
    return { released: true, holder: null };
  }
}
