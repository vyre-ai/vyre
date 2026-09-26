// @ts-check
// session: a surface's unlocked window (ADR 0006, decision 2). The Deck, the Capsule and the
// extension open one with a presence proof, and while it lasts they may reveal, copy and read a
// code for items that do not ask for a fresh proof each time.
//
// Why it is built this way:
//   - The token is 32 random bytes and lives only with the surface. vyred keeps its SHA-256, in
//     memory, so neither vyre.db nor a heap snapshot of this map holds anything that opens a value.
//   - A session ends on the first of: idle too long, its lifetime, the surface closing it, sleep or
//     screen lock (watch.js), or `vault.lock`. Expiry is checked on every use, and each session
//     has at most one timer, so an idle vyred does no work at all (SPEC principle 8).
//   - When the last session ends, the personal vault's key is dropped (if this vault has one).
//   - Events say which surface and how many sessions, never a token.

import crypto from "node:crypto";

export const SURFACES = ["deck", "capsule", "extension"];
export const DEFAULTS = { idle: 10 * 60_000, max: 12 * 3600_000 };

const sha = v => crypto.createHash("sha256").update(String(v)).digest("hex");

/**
 * "10m", "12h", "30s", "1d" or a number of seconds, to milliseconds.
 * @param {unknown} v @param {number} fallback ms
 */
export function duration(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 1000;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(v).trim());
  if (!m) return fallback;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[m[2]];
}

/** The `vault.lock` block of config.json, with defaults. */
export function lockConfig(config) {
  const c = (config && config.vault && config.vault.lock) || {};
  return {
    idle: duration(c.idle, DEFAULTS.idle),
    max: duration(c.max, DEFAULTS.max),
    onSleep: c.onSleep !== false,
    onScreenLock: c.onScreenLock !== false,
  };
}

/**
 * Whether an item asks for a fresh proof every time. The flag lives in the sealed meta once the
 * crypto v2 work lands; until then cards count as reprompt, which is the default ADR 0006 gives
 * them, and an item nobody can find never skips.
 * @param {any} vault @param {string} name
 */
export function reprompt(vault, name) {
  let r;
  try { r = vault.row(name); } catch { return true; }
  if (!r) return true;
  let meta = r.meta;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = null; } }
  if (meta && typeof meta === "object" && typeof meta.reprompt === "boolean") return meta.reprompt;
  if (r.reprompt !== undefined && r.reprompt !== null) return Boolean(r.reprompt);
  return r.kind === "card";
}

/**
 * @typedef {{ surface: string, created: number, last: number, until: number, timer: any }} Session
 */

export class Sessions {
  /**
   * @param {{ vault: any, config?: any, emit?: (type: string, payload: object) => void, now?: () => number,
   *   timers?: { set: (fn: () => void, ms: number) => any, clear: (t: any) => void },
   *   onLastClose?: (why: string) => void, onFirstOpen?: () => void }} deps
   */
  constructor({ vault, config, emit = () => {}, now = Date.now, timers, onLastClose, onFirstOpen }) {
    this.vault = vault;
    this.opts = lockConfig(config);
    this.emit = emit;
    this.now = now;
    this.timers = timers || {
      set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clear: t => clearTimeout(t),
    };
    this.onLastClose = onLastClose || (() => {
      // The personal vault's key, once the crypto v2 work gives the vault one.
      const a = vault && vault.account;
      if (a && typeof a.lock === "function") a.lock();
    });
    this.onFirstOpen = onFirstOpen || (() => {});
    /** @type {Map<string, Session>} keyed by the token's SHA-256 */
    this.open_ = new Map();
  }

  count() { return this.open_.size; }

  /** @param {Session} s */
  expiry(s) { return Math.min(s.until, s.last + this.opts.idle); }

  /**
   * Open a session for a surface. The caller has already proved presence.
   * @param {string} surface @param {number} [ttl_s] lifetime asked for, capped at `max`
   */
  open(surface, ttl_s) {
    if (!SURFACES.includes(surface)) throw new Error(`a session is for ${SURFACES.join(", ")}`);
    const t = this.now();
    const life = ttl_s !== undefined && ttl_s !== null ? Math.min(this.opts.max, Math.max(1, Number(ttl_s) || 0) * 1000) : this.opts.max;
    const token = crypto.randomBytes(32).toString("base64url");
    /** @type {Session} */
    const s = { surface, created: t, last: t, until: t + life, timer: null };
    const key = sha(token);
    const first = this.open_.size === 0;
    this.open_.set(key, s);
    this.arm(key, s);
    if (first) this.onFirstOpen();
    this.emit("vault.unlocked", { surface, sessions: this.open_.size });
    return { session: token, expires: this.expiry(s), surface };
  }

  /** One timer per session, set for when it would end if nothing touched it. */
  arm(key, s) {
    if (s.timer) this.timers.clear(s.timer);
    s.timer = this.timers.set(() => {
      s.timer = null;
      if (this.open_.get(key) !== s) return;
      if (this.now() >= this.expiry(s)) this.end(key, s, "expired");
      else this.arm(key, s);
    }, Math.max(1000, this.expiry(s) - this.now()));
  }

  /** @returns {[string, Session] | null} a live session, or null (an expired one is ended here) */
  find(token) {
    if (typeof token !== "string" || !token || token.length > 200) return null;
    const key = sha(token);
    const s = this.open_.get(key);
    if (!s) return null;
    if (this.now() >= this.expiry(s)) { this.end(key, s, "expired"); return null; }
    return [key, s];
  }

  /**
   * Whether a session covers a use without a fresh proof: it is live, and the item (if named)
   * does not ask for a proof every time. A yes counts as use and pushes the idle limit back.
   * @param {string|undefined} token @param {string} [name]
   */
  ok(token, name) {
    const f = this.find(token);
    if (!f) return false;
    if (name !== undefined && reprompt(this.vault, name)) return false;
    f[1].last = this.now();
    return true;
  }

  /** The surface a live session belongs to, or null. Does not count as use. */
  surfaceOf(token) {
    const f = this.find(token);
    return f ? f[1].surface : null;
  }

  /** @param {string|undefined} token */
  status(token) {
    const f = this.find(token);
    if (!f) return { unlocked: false, expires: null, surface: null };
    return { unlocked: true, expires: this.expiry(f[1]), surface: f[1].surface };
  }

  /** @param {string|undefined} token */
  close(token, why = "closed") {
    const f = this.find(token);
    if (!f) return { closed: false };
    this.end(f[0], f[1], why);
    return { closed: true };
  }

  /** End every session now: sleep, screen lock, `vault.lock`, or vyred stopping. */
  closeAll(why = "lock") {
    const n = this.open_.size;
    for (const s of this.open_.values()) if (s.timer) this.timers.clear(s.timer);
    this.open_.clear();
    if (n) {
      this.emit("vault.locked", { surface: "all", why, ended: n, sessions: 0 });
      this.onLastClose(why);
    }
    return n;
  }

  /** @param {string} key @param {Session} s @param {string} why */
  end(key, s, why) {
    if (s.timer) this.timers.clear(s.timer);
    s.timer = null;
    if (!this.open_.delete(key)) return;
    this.emit("vault.locked", { surface: s.surface, why, ended: 1, sessions: this.open_.size });
    if (this.open_.size === 0) this.onLastClose(why);
  }
}
