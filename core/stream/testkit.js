// @ts-check
// testkit: shared by the stream tests (not a test itself). A seeded PRNG, a virtual-time scheduler,
// and a fault-injecting link that cuts a connection at a random byte, direct or through a relay-like hop.

import { serve } from "./server.js";

/** mulberry32: a small seeded PRNG. @param {number} seed */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Virtual time: tasks run in (time, insertion) order, microtasks drain between them. */
export class Sched {
  constructor() { this.t = 0; this.n = 0; /** @type {any[]} */ this.q = []; }
  /** @param {() => void} fn @param {number} [ms] */
  setTimeout(fn, ms = 0) { const e = { at: this.t + Math.max(0, ms), n: this.n++, fn, dead: false }; this.q.push(e); return e; }
  /** @param {any} e */
  clearTimeout(e) { if (e) e.dead = true; }
  /** @param {() => void} fn @param {number} ms */
  setInterval(fn, ms) {
    const h = { dead: false, cur: /** @type {any} */ (null), unref() {} };
    const tick = () => { if (h.dead) return; fn(); if (!h.dead) h.cur = this.setTimeout(tick, ms); };
    h.cur = this.setTimeout(tick, ms);
    return h;
  }
  /** @param {any} h */
  clearInterval(h) { if (h) { h.dead = true; if (h.cur) h.cur.dead = true; } }
  /** Run until done() or the queue empties; returns the steps taken. @param {() => boolean} done @param {number} [max] */
  async run(done, max = 400_000) {
    let steps = 0;
    for (let i = 0; i < 6; i++) await null;
    while (!done() && steps < max) {
      let k = -1;
      for (let i = 0; i < this.q.length; i++) { const e = this.q[i]; if (e.dead) continue; if (k < 0 || e.at < this.q[k].at || (e.at === this.q[k].at && e.n < this.q[k].n)) k = i; }
      if (k < 0) break;
      const [e] = this.q.splice(k, 1);
      this.t = Math.max(this.t, e.at);
      e.fn();
      for (let i = 0; i < 6; i++) await null;
      steps++;
      if (this.q.length > 64) this.q = this.q.filter(x => !x.dead);
    }
    return steps;
  }
}

/**
 * A link factory. open() returns a client duplex; the server end is serve(log, conn). Each
 * connection gets a byte budget (or none): the message that crosses it is cut and everything after
 * is lost, and the link dies. A silent death leaves the client without a close event, so only the
 * heartbeat timeout can notice.
 * @param {{ log: import("./log.js").SessionLog, sched: Sched, rnd: () => number, relay?: boolean, faultRate?: number, silentRate?: number, dropRate?: number, dupRate?: number, serveOpts?: any, stats?: any }} o
 */
export function makeLink(o) {
  const { log, sched, rnd } = o;
  const stats = o.stats || (o.stats = { opens: 0, kills: 0, silent: 0, bytes: 0 });
  return async function open() {
    stats.opens++;
    const faulty = rnd() < (o.faultRate ?? 0.75);
    const silent = faulty && rnd() < (o.silentRate ?? 0.15);
    let budget = faulty ? 1 + Math.floor(rnd() * 3500) : Infinity;
    let dead = false;
    /** @type {((m: any) => void)[]} */ const cm = [];
    /** @type {(() => void)[]} */ const cc = [];
    /** @type {((m: any) => void)[]} */ const sm = [];
    /** @type {(() => void)[]} */ const sc = [];
    let s2cAt = 0, c2sAt = 0;
    const delay = () => (o.relay ? 1 + Math.floor(rnd() * 6) : 0);
    const kill = (/** @type {boolean} */ quiet) => {
      if (dead) return;
      dead = true; stats.kills++;
      sched.setTimeout(() => { for (const c of sc) c(); }, 0);
      if (quiet) stats.silent++; else sched.setTimeout(() => { for (const c of cc) c(); }, o.relay ? 3 : 0);
    };
    const conn = {
      send(/** @type {any} */ f) {
        if (dead) return;
        const s = JSON.stringify(f);
        const len = Buffer.byteLength(s);
        if (len > budget) { kill(silent); return; }
        budget -= len; stats.bytes += len;
        s2cAt = Math.max(s2cAt, sched.t + delay());
        const at = s2cAt, m = JSON.parse(s);
        // A buggy hop that loses or repeats a message while the link stays up.
        if (o.dropRate && rnd() < o.dropRate) return;
        const copies = o.dupRate && rnd() < o.dupRate ? 2 : 1;
        for (let k = 0; k < copies; k++) sched.setTimeout(() => { if (!dead) for (const c of cm) c(m); }, at - sched.t);
      },
      onClose(/** @type {() => void} */ cb) { sc.push(cb); },
      // A graceful close: what was written is delivered first, then the link ends.
      close() { sched.setTimeout(() => kill(false), Math.max(0, s2cAt - sched.t) + 1); },
      onMessage(/** @type {(m: any) => void} */ cb) { sm.push(cb); },
    };
    serve(log, conn, { heartbeatMs: 25_000, timers: sched, ...(o.serveOpts || {}) });
    return {
      send(/** @type {any} */ m) {
        if (dead) return;
        const s = JSON.stringify(m);
        c2sAt = Math.max(c2sAt, sched.t + delay());
        sched.setTimeout(() => { if (!dead) for (const c of sm) c(JSON.parse(s)); }, c2sAt - sched.t);
      },
      onMessage(/** @type {(m: any) => void} */ cb) { cm.push(cb); },
      onClose(/** @type {() => void} */ cb) { cc.push(cb); },
      close() { if (!dead) { dead = true; sched.setTimeout(() => { for (const c of sc) c(); }, 0); } },
    };
  };
}
