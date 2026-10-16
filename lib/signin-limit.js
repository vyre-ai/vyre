// @ts-check
// Sign-in guessing limits (owner, 17 Oct: attempts are rate-limited per username and per address). One small limiter that sits in front of the sign-in tools, keyed only on the username and the
// space's address the caller names, so it needs nothing from the sign-in protocol itself. Wrong guesses count against the username (5 in 15 minutes) and against the address (30 in 10 minutes);
// each lock lasts longer than the one before (1 minute doubling to 1 hour for a username, 5 minutes doubling to 1 hour for an address) until a day passes clean. A correct sign-in clears that
// username's count but never the address's. Every call, right or wrong, also counts against a burst limit. A name that does not exist is limited exactly like one that does, and a refusal says
// nothing about which limit was hit, so the limit cannot be used to find out who has an account. Memory only, bounded, with a snapshot for a daemon that wants to keep it across a restart.

const MIN = 60_000;
export const POLICY = Object.freeze({
  username: Object.freeze({ fails: 5, windowMs: 15 * MIN, lockMs: MIN, maxLockMs: 60 * MIN, burst: 10, burstMs: MIN }),
  address: Object.freeze({ fails: 30, windowMs: 10 * MIN, lockMs: 5 * MIN, maxLockMs: 60 * MIN, burst: 120, burstMs: MIN }),
  /** A lock level falls back to the first after this long with no new lock. */
  forgetMs: 24 * 60 * MIN,
  /** Most keys held at once. */
  maxKeys: 10_000,
});

/** @param {unknown} raw */
export const usernameKey = raw => { const s = String(raw ?? "").trim().toLowerCase(); return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : ""; };
/** The space's address as typed: `name.vyre.run`, a scheme or a trailing slash tolerated. @param {unknown} raw */
export const addressKey = raw => { const s = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, ""); return /^[a-z0-9][a-z0-9.-]{0,252}$/.test(s) ? s : ""; };

/** @typedef {{ fails: number[], locks: number, lockedUntil: number, lastLock: number, burst: number[] }} Row */

/**
 * @param {{ now?: () => number, policy?: typeof POLICY }} [o]
 */
export function createSigninLimit(o = {}) {
  const now = o.now || Date.now;
  const P = o.policy || POLICY;
  /** @type {Map<string, Row>} */
  const rows = new Map();
  const blank = () => ({ fails: [], locks: 0, lockedUntil: 0, lastLock: 0, burst: [] });
  const keysOf = (/** @type {{ username?: unknown, address?: unknown }} */ id) => {
    const u = usernameKey(id && id.username), a = addressKey(id && id.address);
    return /** @type {[string, "username" | "address", string][]} */ ([[`u:${u}`, "username", u], [`a:${a}`, "address", a]]);
  };
  const row = (/** @type {string} */ k) => {
    let r = rows.get(k);
    if (!r) {
      if (rows.size >= P.maxKeys) sweep(true);
      r = blank(); rows.set(k, r);
    }
    return r;
  };
  /** Drop keys with nothing left to remember; when full, drop the oldest as well. @param {boolean} [force] */
  function sweep(force = false) {
    const t = now();
    for (const [k, r] of rows) {
      const kind = k[0] === "u" ? P.username : P.address;
      const live = r.lockedUntil > t || r.fails.some(f => t - f < kind.windowMs) || r.burst.some(b => t - b < kind.burstMs) || (r.locks > 0 && t - r.lastLock < P.forgetMs);
      if (!live) rows.delete(k);
    }
    if (force && rows.size >= P.maxKeys) for (const k of rows.keys()) { rows.delete(k); if (rows.size < P.maxKeys * 0.9) break; }
  }

  /**
   * May this attempt go ahead? Counts it against the burst limit when it may.
   * @param {{ username?: unknown, address?: unknown }} id
   * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
   */
  function check(id) {
    const t = now();
    let wait = 0;
    const ks = keysOf(id);
    for (const [k, kind] of ks) {
      const r = rows.get(k);
      if (!r) continue;
      if (r.lockedUntil > t) wait = Math.max(wait, r.lockedUntil - t);
      const pol = P[kind];
      r.burst = r.burst.filter(b => t - b < pol.burstMs);
      if (r.burst.length >= pol.burst) wait = Math.max(wait, pol.burstMs - (t - r.burst[0]));
    }
    if (wait > 0) return { ok: false, retryAfterMs: Math.max(1000, Math.ceil(wait)) };
    for (const [k] of ks) row(k).burst.push(t);
    return { ok: true };
  }

  /** A wrong guess. May lock the username or the address. @param {{ username?: unknown, address?: unknown }} id */
  function fail(id) {
    const t = now();
    for (const [k, kind] of keysOf(id)) {
      const pol = P[kind], r = row(k);
      r.fails = r.fails.filter(f => t - f < pol.windowMs);
      r.fails.push(t);
      if (r.fails.length >= pol.fails && r.lockedUntil <= t) {
        if (t - r.lastLock >= P.forgetMs) r.locks = 0;
        r.lockedUntil = t + Math.min(pol.maxLockMs, pol.lockMs * 2 ** r.locks);
        r.locks += 1; r.lastLock = t; r.fails = [];
      }
    }
  }

  /** A correct sign-in: that username starts clean. The address keeps its count: one person signing in does not wipe what a guesser did there. @param {{ username?: unknown }} id */
  function pass(id) {
    const r = rows.get(`u:${usernameKey(id && id.username)}`);
    if (r) { r.fails = []; r.locks = 0; r.lockedUntil = 0; }
  }

  return {
    check, fail, pass,
    /** Everything held, as JSON, for a daemon that keeps it across a restart. */
    snapshot: () => { sweep(); return { v: 1, rows: [...rows].map(([k, r]) => [k, r]) }; },
    /** @param {any} snap */
    restore(snap) {
      if (!snap || snap.v !== 1 || !Array.isArray(snap.rows)) return;
      for (const [k, r] of snap.rows.slice(0, P.maxKeys)) {
        if (typeof k !== "string" || !/^[ua]:/.test(k) || !r || !Array.isArray(r.fails) || !Array.isArray(r.burst)) continue;
        rows.set(k, { fails: r.fails.map(Number).filter(Number.isFinite), burst: r.burst.map(Number).filter(Number.isFinite), locks: Number(r.locks) || 0, lockedUntil: Number(r.lockedUntil) || 0, lastLock: Number(r.lastLock) || 0 });
      }
    },
    size: () => rows.size,
  };
}

const NOT_A_GUESS = new Set(["rate_limited", "unavailable", "unreachable", "bad_input", "locked", "not_ready", "timeout"]);

/** The plain words for a refusal: no scope, no count, nothing about whether the name exists. @param {number} ms */
export function waitWords(ms) {
  const m = Math.max(1, Math.ceil(ms / MIN));
  return m < 2 ? "Too many sign-in tries. Wait a minute and try again." : m < 60 ? `Too many sign-in tries. Wait ${m} minutes and try again.` : "Too many sign-in tries. Wait an hour and try again.";
}

/**
 * Put the limit in front of a sign-in tool's `run`. `begin` (the first step) only counts toward the burst limit; `finish` (the step that proves the password) counts a wrong answer against the
 * username and the address, and a right one clears the username. A step that failed for a reason that is not a guess (the server is busy, the input was malformed) is not counted as one.
 * @template I, O
 * @param {ReturnType<typeof createSigninLimit>} limiter
 * @param {(input: I, meta?: any) => Promise<O>} run
 * @param {{ kind: "begin" | "finish", who: (input: I, meta?: any) => { username?: unknown, address?: unknown }, wrong?: (result: O) => boolean }} o
 * @returns {(input: I, meta?: any) => Promise<O>}
 */
export function guardSignin(limiter, run, o) {
  return async (input, meta) => {
    const id = o.who(input, meta);
    const gate = limiter.check(id);
    if (!gate.ok) throw Object.assign(new Error(waitWords(gate.retryAfterMs)), { code: "rate_limited", retryAfterMs: gate.retryAfterMs });
    let result;
    try { result = await run(input, meta); }
    catch (e) {
      const code = String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "");
      if (o.kind === "finish" && !NOT_A_GUESS.has(code)) limiter.fail(id);
      throw e;
    }
    if (o.kind === "finish") { if (o.wrong && o.wrong(result)) limiter.fail(id); else limiter.pass(id); }
    return result;
  };
}
