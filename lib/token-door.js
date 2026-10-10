// @ts-check
// lib/token-door: the rate and lock-out rules for a bearer-token door (the Vault MCP, /agents-mcp). A token bucket per source and per credential, and a lock-out for a source that sends too many wrong
// tokens. Pure of sockets and clocks: the caller passes `now`. The outside module uses it; the Vault's pass adopts it so there is one set of numbers (trust owns that change).

/** Bad tokens from one source before it is locked out, within the window, and for how long. */
export const LOCKOUT = Object.freeze({ bad: 5, windowMs: 10 * 60_000, forMs: 10 * 60_000 });

/** `size` tokens, refilled at `perMinute`, worked out from the clock when asked. */
export class Bucket {
  /** @param {number} size @param {number} perMinute @param {() => number} now */
  constructor(size, perMinute, now) { this.size = size; this.rate = perMinute / 60_000; this.now = now; this.tokens = size; this.at = now(); }
  take() { const t = this.now(); this.tokens = Math.min(this.size, this.tokens + (t - this.at) * this.rate); this.at = t; if (this.tokens < 1) return false; this.tokens -= 1; return true; }
}

/**
 * @param {{ now: () => number, perSource?: number, lockout?: typeof LOCKOUT }} o
 * `admit(source)` is asked first for every request: a locked-out or too-busy source gets `{ ok: false, status: 429, why }`. `miss(source)` counts a wrong token; `clear(source)` forgets a source's misses after a right one.
 * `credit(id, perMinute)` takes one token from a credential's own bucket (its rate), false when it has none.
 */
export function createDoor({ now, perSource = 120, lockout = LOCKOUT }) {
  /** @type {Map<string, { n: number, since: number, until: number }>} */ const misses = new Map();
  /** @type {Map<string, Bucket>} */ const sources = new Map();
  /** @type {Map<string, Bucket>} */ const credentials = new Map();
  return {
    /** @param {string} source @returns {{ ok: true } | { ok: false, status: 429, why: string }} */
    admit(source) {
      const t = now(), m = misses.get(source);
      if (m && m.until > t) return { ok: false, status: 429, why: "locked out" };
      let b = sources.get(source);
      if (!b) sources.set(source, b = new Bucket(perSource, perSource, now));
      return b.take() ? { ok: true } : { ok: false, status: 429, why: "too many requests" };
    },
    /** @param {string} source */
    miss(source) {
      const t = now(), m = misses.get(source);
      const x = m && t - m.since < lockout.windowMs ? m : { n: 0, since: t, until: 0 };
      x.n += 1; if (x.n >= lockout.bad) x.until = t + lockout.forMs;
      misses.set(source, x);
    },
    /** @param {string} source */
    clear(source) { misses.delete(source); },
    /** @param {string} id @param {number} perMinute */
    credit(id, perMinute) {
      let b = credentials.get(id);
      if (!b) credentials.set(id, b = new Bucket(perMinute, perMinute, now));
      return b.take();
    },
    /** Forget a credential's bucket (it was ended or its rate changed). @param {string} id */
    forget(id) { credentials.delete(id); },
  };
}
