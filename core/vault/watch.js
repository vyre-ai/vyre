// @ts-check
// watch: lock the vault when the Mac sleeps or its screen locks (ADR 0006, decision 2).
//
// Two sources, because either can miss:
//   - mac/watch.swift, a child that waits on the run loop and prints a line per signal. It costs
//     nothing between signals. Started only on a Mac, in the local role, when config asks for it.
//   - A wall-clock gap check, once a minute: if a minute's timer fires much later than a minute,
//     the machine was asleep (or suspended), and the vault acts as if it had heard so.
// Both run only while there is something to protect (an open session or our copy on the
// clipboard), so an idle vyred has neither a child nor a timer from here (SPEC principle 8).

import { lines } from "./mac/helper.js";

export const TICK_MS = 60_000;
/** A tick this late means the machine slept. Timers drift by seconds under load, not by a minute. */
export const GAP_MS = 150_000;

/** Which config switch covers each signal the helper sends. */
const COVERS = { sleep: "onSleep", "screen-sleep": "onScreenLock", "screen-lock": "onScreenLock", resign: "onScreenLock" };

export class LockWatch {
  /**
   * @param {{ helper?: import("./mac/helper.js").Helper | null, onSleep?: boolean, onScreenLock?: boolean,
   *   platform?: string, role?: string, onSignal: (why: string) => void, now?: () => number,
   *   timers?: { every: (fn: () => void, ms: number) => any, cancel: (t: any) => void }, log?: (m: string) => void }} deps
   */
  constructor({ helper = null, onSleep = true, onScreenLock = true, platform = process.platform, role = "local", onSignal, now = Date.now, timers, log = () => {} }) {
    this.helper = helper;
    this.opts = { onSleep, onScreenLock };
    this.native = platform === "darwin" && role === "local" && (onSleep || onScreenLock);
    this.onSignal = onSignal;
    this.now = now;
    this.log = log;
    this.timers = timers || {
      every: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
      cancel: t => clearInterval(t),
    };
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this.child = null;
    this.tick = null;
    this.last = 0;
    this.active = false;
  }

  /** Start watching, if not already. Safe to call on every session open and every copy. */
  async ensure() {
    if (this.active) return;
    this.active = true;
    if (this.opts.onSleep) {
      this.last = this.now();
      this.tick = this.timers.every(() => this.check(), TICK_MS);
    }
    if (this.native && this.helper && this.helper.usable() && !this.child) {
      try {
        const c = await this.helper.spawn([]);
        if (!this.active) { c.stdin.end(); return; }
        this.child = c;
        lines(c.stdout, msg => { if (msg && typeof msg.signal === "string") this.signal(msg.signal); });
        c.stderr.resume();
        c.stdin.on("error", () => {});
        c.on("error", () => { if (this.child === c) this.child = null; });
        c.on("exit", () => { if (this.child === c) { this.child = null; if (this.active) this.log("vault lock watcher stopped; the wall-clock check still runs"); } });
      } catch (e) {
        this.log(`vault lock watcher unavailable: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  /** @param {string} s */
  signal(s) {
    const key = COVERS[/** @type {keyof typeof COVERS} */ (s)];
    if (!key || !this.opts[/** @type {"onSleep"|"onScreenLock"} */ (key)]) return;
    this.onSignal(s);
  }

  check() {
    const t = this.now();
    const gap = t - this.last;
    this.last = t;
    if (gap > GAP_MS) this.onSignal("wake-gap");
  }

  /** Stop watching: nothing is left to protect, or vyred is stopping. */
  idle() {
    this.active = false;
    if (this.tick) { this.timers.cancel(this.tick); this.tick = null; }
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin.end(); } catch { /* gone */ } try { c.kill(); } catch { /* gone */ } }
  }
}
