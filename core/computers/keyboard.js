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
//   - unheard from for the lease's TTL: it ends, "lease expired". A closing lid ends it this way.
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

const SURFACE = /^(glass|deck|phone|capsule):[A-Za-z0-9._-]{1,64}$/;
/** Is this a person's screen (as opposed to the CLI, the assistant or a module)? */
export const isSurface = s => SURFACE.test(String(s || ""));

/**
 * @typedef {{ surface: string, thread: string|null, since: number, beat: number, leased?: number }} Takeover
 */

export class Keyboard extends EventEmitter {
  /**
   * @param {{ pool: import("./pool.js").Pool, call: (tool: string, input: any) => Promise<any>,
   *   emit: (type: string, payload: any, where?: any) => any, on?: (pattern: string, fn: (e: any) => void) => () => void,
   *   log?: (m: string) => void, now?: () => number }} deps
   */
  constructor(deps) {
    super();
    this.pool = deps.pool;
    this.call = deps.call;
    this.send = deps.emit;
    this.log = deps.log || (() => {});
    this.now = deps.now || (() => deps.pool.now());
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
   * 30 s. Synchronous from the caller's side: Glass calls it per message.
   * @returns {boolean} whether this surface still holds the keyboard
   */
  renew(agent, surface) {
    const t = this.takeovers.get(agent);
    if (!t || t.surface !== surface || this.holder(agent) !== surface) return false;
    const at = this.now();
    t.beat = at;
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
   * @returns {Promise<{ agent: string, surface: string, thread: string|null, previous: string|null }>}
   */
  async takeover(agent, surface) {
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
      Object.assign(t, { beat: at, thread: leased });
      return { agent, surface, thread: leased, previous };
    }
    this.takeovers.set(agent, { surface, thread: leased, since: at, beat: at });
    this.send("computer.taken-over", { agent, surface, thread: leased }, leased ? { thread: leased } : {});
    this.log(`${surface} took over ${agent}'s computer`);
    this.emit("changed", { agent, surface });
    return { agent, surface, thread: leased, previous };
  }

  /** Hand the keyboard back. Only the surface that has it can; anyone else changes nothing. */
  async giveback(agent, surface) {
    const t = this.takeovers.get(agent);
    if (!t || t.surface !== surface) return { agent, handed_back: false };
    this.takeovers.delete(agent);
    if (t.thread) {
      this.quiet.add(t.thread);
      try { await this.call("threads.release", { thread: t.thread, surface }); }
      catch {} finally { this.quiet.delete(t.thread); }
    }
    this.finish(agent, t, "gave back");
    return { agent, handed_back: true };
  }

  /** @param {"gave back"|"lease expired"|"lease released"} why */
  end(agent, why) {
    const t = this.takeovers.get(agent);
    if (!t) return;
    this.takeovers.delete(agent);
    this.finish(agent, t, why);
  }

  /** @param {Takeover} t */
  finish(agent, t, why) {
    this.send("computer.handed-back", { agent, surface: t.surface, why }, t.thread ? { thread: t.thread } : {});
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
      if (!holder) this.end(agent, "lease released");
      else if (holder === t.surface) t.beat = this.now();
      else if (isSurface(holder)) {
        const at = this.now();
        Object.assign(t, { surface: String(holder), since: at, beat: at });
        this.send("computer.taken-over", { agent, surface: t.surface, thread: t.thread }, { thread: t.thread });
        this.log(`${agent}'s take-over moved to ${t.surface}`);
        this.emit("changed", { agent, surface: t.surface });
      } else this.end(agent, "lease released");
    }
  }

  /**
   * May the agent's hands act now? Refused while it is paused or taken over, with who has the
   * keyboard. Allowed touches the checkout, which is what keeps a working agent's screen.
   */
  mayAct(agent, tool) {
    const what = tool ? String(tool) : "that";
    if (this.pool.isPaused(agent)) return { ok: false, why: `${agent} is paused; resume it before its hands can do ${what}` };
    const h = this.holder(agent);
    if (h) return { ok: false, why: `${h} has the keyboard of ${agent}'s computer; ${what} waits until it is handed back`, holder: h };
    this.pool.touch(agent);
    return { ok: true };
  }

  /** End every take-over past its TTL. */
  sweep() {
    for (const agent of [...this.takeovers.keys()]) this.holder(agent);
  }

  stop() { this.off(); this.removeAllListeners(); }
}
