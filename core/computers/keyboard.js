// @ts-check
// keyboard: take-over, where one person types into an agent's computer and its hands wait.
//
// The switchboard's lease is the one keyboard (floor rule 4). A take-over is a record here of
// which surface took the computer, plus `threads.lease` on the thread using it, so the screen and
// the thread change hands together and every other surface goes read-only (ADR 0003, "Take-over
// and the lease"). The record follows the lease from its `lease.changed` events:
//
//   - released (holder null): the take-over ends, "lease released";
//   - moved to another person's screen (the laptop to the phone): the take-over moves with it;
//   - moved to anything else: the person no longer has it, so it ends, "lease released";
//   - unheard from for the lease's TTL: it ends, "lease expired". A closing lid ends it this way;
//   - no input from the holder for the owner's idle setting (config computers.handbackIdleMin:
//     0 for off, or 2, 5 or 15 minutes; 5 by default): it ends, "idle". A pong keeps the lease
//     but is not input, so a person who walked away from an open tab gets the agent back.
//     `computer.idle-warning` goes out IDLE_WARN_MS before, and again with `at: null` if input
//     comes in time.
//
// A lease change on a thread nobody took over is someone chatting with the agent. It changes
// nothing here: if typing into a thread paused its hands, talking to an agent would stop it.
//
// With no thread for the agent (none started yet, or no switchboard) the record alone decides,
// on the same TTL, renewed the same way: the take-over surface calls computers.takeover again.
//
// Every question the Glass input gate asks (canType) is answered from memory, since it is asked
// per keystroke.

import { EventEmitter } from "node:events";

/** The switchboard's lease TTL. A take-over unrenewed this long is over. */
export const TTL = 90_000;

/** The idle choices the owner can pick, in minutes. 0 is off. */
export const IDLE_CHOICES = Object.freeze([0, 2, 5, 15]);
export const IDLE_DEFAULT_MIN = 5;
/** How long before an idle hand-back the holder is warned. */
export const IDLE_WARN_MS = 10_000;

/** The idle setting in ms from a config value: one of IDLE_CHOICES, else the default. */
export const idleMsOf = min => (IDLE_CHOICES.includes(Number(min)) ? Number(min) : IDLE_DEFAULT_MIN) * 60_000;

const SURFACE = /^(glass|deck|phone|capsule):[A-Za-z0-9._-]{1,64}$/;
/** Is this a person's screen (as opposed to the CLI, the assistant or a module)? */
export const isSurface = s => SURFACE.test(String(s || ""));

/**
 * @typedef {{ surface: string, thread: string|null, since: number, beat: number, input: number, leased?: number, by?: string,
 *   warned?: number, cancel?: (() => void) | null }} Takeover
 */

export class Keyboard extends EventEmitter {
  /**
   * @param {{ pool: import("./pool.js").Pool, call: (tool: string, input: any) => Promise<any>,
   *   emit: (type: string, payload: any, where?: any) => any, on?: (pattern: string, fn: (e: any) => void) => () => void,
   *   log?: (m: string) => void, now?: () => number, idleMs?: () => number,
   *   schedule?: (fn: () => void, ms: number) => () => void }} deps
   */
  constructor(deps) {
    super();
    this.pool = deps.pool;
    this.call = deps.call;
    this.send = deps.emit;
    this.log = deps.log || (() => {});
    this.now = deps.now || (() => deps.pool.now());
    /** The idle setting, read live so a change needs no restart. 0 is off. */
    this.idleMs = deps.idleMs || (() => idleMsOf(IDLE_DEFAULT_MIN));
    // One timer per take-over, armed once per idle window rather than reset per keystroke.
    this.schedule = deps.schedule || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    /** @type {Map<string, Takeover>} */
    this.takeovers = new Map();
    /** Threads whose lease we are moving ourselves: their lease.changed is our own echo. */
    this.quiet = new Set();
    this.off = deps.on ? deps.on("lease.changed", e => { try { this.onLease(e); } catch (err) { this.log(`lease.changed: ${err.message}`); } }) : () => {};
    this.pool.heldBy = agent => this.holder(agent);
  }

  /** The surface holding a live take-over, or null. Ends an expired one on the way. */
  holder(agent) {
    const t = this.takeovers.get(agent);
    if (!t) return null;
    if (this.now() - t.beat >= TTL) { this.end(agent, "lease expired"); return null; }
    return t.surface;
  }

  /**
   * A live sign from the holder's own stream (forwarded input, a pong) keeps its take-over alive
   * (ADR 0005, decision 2: the relay renews, never a client timer). Without it a person typing
   * steadily lost the keyboard 90 s after taking it. The thread's lease is renewed at most every
   * 30 s. Synchronous from the caller's side: Glass calls it per message. `input` marks a
   * keystroke or pointer event, which also resets the idle clock; a pong does not.
   * @returns {boolean} whether this surface still holds the keyboard
   */
  renew(agent, surface, input = false) {
    const t = this.takeovers.get(agent);
    if (!t || t.surface !== surface || this.holder(agent) !== surface) return false;
    const at = this.now();
    t.beat = at;
    if (input) this.touched(agent, t, at);
    if (t.thread && at - (t.leased || t.since) >= 30_000) {
      t.leased = at;
      Promise.resolve(this.call("threads.lease", { thread: t.thread, surface }))
        .then(r => { if (r && r.error && r.error.code !== "no_such_tool") this.log(`could not renew ${agent}'s thread lease: ${r.error.message}`); })
        .catch(() => {});
    }
    return true;
  }

  /** May this surface type into this computer? Synchronous, from memory: Glass asks per message. */
  canType(agent, surface) {
    return Boolean(surface) && this.holder(agent) === surface;
  }

  /** The thread using the computer: the checkout's, else the agent's latest. */
  async threadFor(agent) {
    const co = this.pool.checkouts.get(agent);
    if (co && co.thread) return co.thread;
    const r = await this.call("agents.threads", { agent });
    const list = r && Array.isArray(r.data) ? r.data : [];
    return list.length && list[0] && list[0].id ? String(list[0].id) : null;
  }

  /**
   * Take the computer for a person's surface. Calling it again from the same surface renews it
   * (and re-leases the thread), which is how Glass keeps a take-over alive.
   *
   * `caller` is whoever vyred says made this call (a module, or the channel a person came in on,
   * such as their tailnet login), never a string the input made up. There is no presence proof
   * for take-over (core/presence PERSON_ONLY). `giveback` requires the same caller, so a second
   * person cannot end someone else's take-over.
   * @param {string} agent @param {string} surface @param {string} [caller]
   * @returns {Promise<{ agent: string, surface: string, thread: string|null, previous: string|null }>}
   */
  async takeover(agent, surface, caller) {
    if (!isSurface(surface)) throw new Error(`"${surface}" is not a person's screen; a surface looks like glass:<device>, deck:<device>, phone:<device> or capsule:<device>`);
    const before = this.holder(agent);
    // A take-over needs the screen: it checks out (and thaws), and holds the checkout while it lasts.
    await this.pool.checkout(agent, { why: "take-over" });
    const thread = await this.threadFor(agent);
    let previous = before;
    let leased = thread;
    if (thread) {
      this.quiet.add(thread);
      let r;
      try { r = await this.call("threads.lease", { thread, surface }); } finally { this.quiet.delete(thread); }
      if (r.error) {
        if (r.error.code !== "no_such_tool") throw new Error(`could not take ${agent}'s thread: ${r.error.message}`);
        leased = null;
      } else if (!previous) previous = r.data && r.data.previous ? String(r.data.previous) : null;
    }
    const at = this.now();
    const t = this.takeovers.get(agent);
    if (t && t.surface === surface) {
      Object.assign(t, { beat: at, thread: leased, by: caller || t.by });
      this.touched(agent, t, at);
      return { agent, surface, thread: leased, previous };
    }
    if (t) this.disarm(t);
    this.takeovers.set(agent, { surface, thread: leased, since: at, beat: at, input: at, by: caller });
    this.arm(agent);
    this.send("computer.taken-over", { agent, surface, thread: leased }, leased ? { thread: leased } : {});
    this.log(`${surface} took over ${agent}'s computer`);
    this.emit("changed", { agent, surface });
    return { agent, surface, thread: leased, previous };
  }

  /**
   * Hand the keyboard back. Only the surface that has it can; and when it was taken over by a
   * caller vyred verified (not one moved here by the lease alone, see `onLease`), only that same
   * caller or a module can, so a second person cannot end someone else's take-over just by
   * naming their surface.
   */
  async giveback(agent, surface, caller) {
    const t = this.takeovers.get(agent);
    if (!t || t.surface !== surface) return { agent, handed_back: false };
    if (t.by && t.by !== caller && !String(caller || "").startsWith("module:")) return { agent, handed_back: false };
    this.takeovers.delete(agent);
    if (t.thread) {
      this.quiet.add(t.thread);
      try { await this.call("threads.release", { thread: t.thread, surface }); }
      catch {} finally { this.quiet.delete(t.thread); }
    }
    this.finish(agent, t, "gave back");
    return { agent, handed_back: true };
  }

  /**
   * @param {"gave back"|"lease expired"|"lease released"|"idle"} why
   * @param {"chat"|"released"} [how] for "lease released": the thread moved to a chat that is not
   *   a screen (the CLI, a module), or its lease was let go; the agent's thread is told which.
   */
  end(agent, why, how) {
    const t = this.takeovers.get(agent);
    if (!t) return;
    this.takeovers.delete(agent);
    this.finish(agent, t, why, undefined, how);
    if (how && t.thread) {
      // Typed to the agent, so it names the owner from the agent's side; surfaces phrase the
      // event's fields themselves ("Your take-over ended...").
      const from = t.surface.split(":")[0];
      const text = how === "chat" ? `The owner's take-over (from ${from}) ended when the thread moved to chat` : `The owner's take-over (from ${from}) ended when the thread's lease was released`;
      Promise.resolve(this.call("threads.send", { thread: t.thread, text }))
        .then(r => { if (r && r.error && r.error.code !== "no_such_tool") this.log(`could not note the lease release in ${agent}'s thread: ${r.error.message}`); })
        .catch(() => {});
    }
  }

  /**
   * @param {Takeover} t @param {string} why @param {number} [idle] the idle setting, for why "idle"
   * @param {"chat"|"released"} [how] for why "lease released"
   */
  finish(agent, t, why, idle, how) {
    this.disarm(t);
    // Structured, for surfaces to phrase: who had it (only the owner can take over; guests and
    // agents are refused), from what kind of device, and the reason in one word.
    const reason = why === "gave back" ? "gave back" : why === "idle" ? "idle" : why === "lease expired" ? "expired" : how === "chat" ? "chat" : "released";
    const payload = { agent, surface: t.surface, why, by: "owner", device: t.surface.split(":")[0], reason, ...(why === "idle" ? { idle_ms: idle } : {}) };
    this.send("computer.handed-back", payload, t.thread ? { thread: t.thread } : {});
    if (why === "idle" && t.thread) {
      const text = `Handed back to ${agent} after ${Math.round(Number(idle) / 60_000)} min idle`;
      Promise.resolve(this.call("threads.send", { thread: t.thread, text }))
        .then(r => { if (r && r.error && r.error.code !== "no_such_tool") this.log(`could not note the idle hand-back in ${agent}'s thread: ${r.error.message}`); })
        .catch(() => {});
    }
    this.log(`${agent}'s computer handed back by ${t.surface} (${why})`);
    // The idle clock starts now, not from the agent's last action before the take-over.
    this.pool.touch(agent);
    this.emit("changed", { agent, surface: null });
  }

  /** Follow the lease of every thread someone took over. */
  onLease(e) {
    if (!e || !e.thread || this.quiet.has(e.thread)) return;
    const holder = e.payload ? e.payload.holder : null;
    for (const [agent, t] of [...this.takeovers]) {
      if (t.thread !== e.thread) continue;
      if (!holder) this.end(agent, "lease released", "released");
      else if (holder === t.surface) t.beat = this.now();
      else if (isSurface(holder)) {
        const at = this.now();
        // The lease moved this, not a verified computers.takeover call: nobody to bind giveback
        // to but the surface itself, same as before presence existed.
        Object.assign(t, { surface: String(holder), since: at, beat: at, by: undefined });
        this.touched(agent, t, at);
        this.send("computer.taken-over", { agent, surface: t.surface, thread: t.thread }, { thread: t.thread });
        this.log(`${agent}'s take-over moved to ${t.surface}`);
        this.emit("changed", { agent, surface: t.surface });
      } else this.end(agent, "lease released", "chat");
    }
  }

  /**
   * May the agent's hands act now? Refused while it is paused or taken over, with who has the
   * keyboard. Allowed touches the checkout, which is what keeps a working agent's screen.
   */
  mayAct(agent, tool) {
    const what = tool ? String(tool) : "that";
    // The shield (core/computers/shield.js) sits in front of this and is checked before it is
    // ever called, so this has nothing to say about it.
    if (this.pool.isPaused(agent)) return { ok: false, why: `${agent} is paused; resume it before its hands can do ${what}` };
    const h = this.holder(agent);
    if (h) return { ok: false, why: `${h} has the keyboard of ${agent}'s computer; ${what} waits until it is handed back`, holder: h };
    this.pool.touch(agent);
    return { ok: true };
  }

  /** The holder acted: the idle clock restarts, and a warning already out is taken back. */
  touched(agent, t, at) {
    t.input = at;
    if (t.warned) {
      t.warned = 0;
      this.send("computer.idle-warning", { agent, surface: t.surface, at: null }, t.thread ? { thread: t.thread } : {});
    }
  }

  /** @param {Takeover} t */
  disarm(t) { if (t.cancel) { t.cancel(); t.cancel = null; } }

  /** Arm the idle timer for the next moment worth looking: the warning, or the hand-back. */
  arm(agent) {
    const t = this.takeovers.get(agent);
    if (!t) return;
    this.disarm(t);
    const idle = this.idleMs();
    if (!idle) return;
    const left = t.input + idle - this.now();
    const wait = t.warned ? left : left - IDLE_WARN_MS;
    t.cancel = this.schedule(() => { t.cancel = null; this.idleCheck(agent); }, Math.max(0, wait));
  }

  /** Warn, hand back, or re-arm, from the holder's last input and the live setting. */
  idleCheck(agent) {
    const t = this.takeovers.get(agent);
    if (!t) return;
    const idle = this.idleMs();
    if (!idle) {
      if (t.warned) this.touched(agent, t, t.input);
      this.disarm(t);
      return;
    }
    const left = t.input + idle - this.now();
    if (left <= 0) {
      this.takeovers.delete(agent);
      if (t.thread) Promise.resolve(this.call("threads.release", { thread: t.thread, surface: t.surface })).catch(() => {});
      this.finish(agent, t, "idle", idle);
      return;
    }
    if (left <= IDLE_WARN_MS && !t.warned) {
      t.warned = t.input + idle;
      this.send("computer.idle-warning", { agent, surface: t.surface, at: t.warned }, t.thread ? { thread: t.thread } : {});
    }
    if (!t.cancel) this.arm(agent);
  }

  /** End every take-over past its TTL or its idle time. The idle timer is the clock; this is its backstop. */
  sweep() {
    for (const agent of [...this.takeovers.keys()]) if (this.holder(agent)) this.idleCheck(agent);
  }

  stop() { for (const t of this.takeovers.values()) this.disarm(t); this.off(); this.removeAllListeners(); }
}
