// @ts-check
// governor: how fast and how much a signed-in account is used through a website Connection, so a person's real account is never put at risk. A professional network watches for automation;
// an account that is read too fast, too much, or at 3 a.m. gets a challenge or a ban. The governor keeps every call to the pace of a person, within daily caps, outside quiet hours, one at a
// time per account, and STOPS at the first challenge and stays stopped until the person clears it and says so. Nothing here is a rule written once: every number is a setting per account
// (the Connection's own), with a conservative default for the sites known to watch (PROFILES).
//
// Pure of the store and the clock: both are injected, so the rules are tested to the minute.

/** The day-to-day numbers of a strict profile. Defaults are a floor for safety: a person may change them for their own account (connectors.site.limits.set), nothing else does. */
export const STRICT = Object.freeze({
  reads_per_day: 80,
  writes_per_day: 15,
  gap_read_s: /** @type {[number, number]} */ ([20, 60]),
  gap_write_s: /** @type {[number, number]} */ ([120, 300]),
  quiet: /** @type {{ from: string, to: string } | null} */ ({ from: "22:00", to: "07:00" }),
  cooldown_min: 60,
});

/** Hosts whose accounts are watched, and the profile each gets unless the person sets another. */
const WATCHED = [/(^|\.)linkedin\.com$/i];

/** @param {string} host @returns {"strict" | "none"} */
export const profileFor = host => (WATCHED.some(r => r.test(host)) ? "strict" : "none");

const num = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const pair = (/** @type {any} */ v, /** @type {[number, number]} */ d) => (Array.isArray(v) && v.length === 2 ? /** @type {[number, number]} */ ([num(v[0], 0, 86_400, d[0]), Math.max(num(v[0], 0, 86_400, d[0]), num(v[1], 0, 86_400, d[1]))]) : d);
const hhmm = (/** @type {any} */ v) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);

/**
 * The settings in force for a Connection: its profile's numbers, then the person's own over them. `profile: "none"` governs nothing. Returns null when nothing governs it.
 * @param {string} host @param {any} [own] the Connection's `governor` setting
 * @returns {null | { profile: string, reads_per_day: number, writes_per_day: number, gap_read_s: [number, number], gap_write_s: [number, number], quiet: { from: string, to: string } | null, cooldown_min: number, tz: string }}
 */
export function settingsOf(host, own) {
  const o = own && typeof own === "object" ? own : {};
  const profile = o.profile === "none" || o.profile === "strict" ? o.profile : profileFor(host);
  const anySet = ["reads_per_day", "writes_per_day", "gap_read_s", "gap_write_s", "quiet", "cooldown_min"].some(k => o[k] !== undefined);
  if (profile === "none" && !anySet) return null;
  const base = STRICT;
  const quiet = o.quiet === null ? null : o.quiet && hhmm(o.quiet.from) && hhmm(o.quiet.to) ? { from: /** @type {string} */ (hhmm(o.quiet.from)), to: /** @type {string} */ (hhmm(o.quiet.to)) } : profile === "none" ? null : base.quiet;
  const tz = typeof o.tz === "string" && o.tz ? o.tz : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return { profile, reads_per_day: num(o.reads_per_day, 0, 100_000, profile === "none" ? 100_000 : base.reads_per_day), writes_per_day: num(o.writes_per_day, 0, 100_000, profile === "none" ? 100_000 : base.writes_per_day),
    gap_read_s: pair(o.gap_read_s, profile === "none" ? [0, 0] : base.gap_read_s), gap_write_s: pair(o.gap_write_s, profile === "none" ? [0, 0] : base.gap_write_s), quiet, cooldown_min: num(o.cooldown_min, 0, 10_080, base.cooldown_min), tz };
}

/** The local date and minutes-from-midnight in a time zone. @param {number} ms @param {string} tz */
export function localParts(ms, tz) {
  let f;
  try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  /** @type {Record<string, string>} */ const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Is `minutes` inside a quiet window (which may cross midnight)? @param {number} minutes @param {{ from: string, to: string }} q */
export function inQuiet(minutes, q) {
  const [fh, fm] = q.from.split(":").map(Number), [th, tm] = q.to.split(":").map(Number);
  const a = fh * 60 + fm, b = th * 60 + tm;
  return a === b ? false : a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** Whether a failed call was a challenge the person has to clear (not a plain refusal of one entity). @param {string} cls @param {string} [reason] */
export const isChallenge = (cls, reason) => cls === "blocked" && !/no login or challenge markers/i.test(String(reason || "")) && /challenge page|challenge \(|checkpoint|captcha|verify you|unusual activity/i.test(String(reason || ""));

/**
 * @typedef {{ day: string, reads: number, writes: number, last: number, stopped_at: number | null, stopped_reason: string | null, cooldown_until: number }} State
 * @typedef {{ get: (id: string) => State | null, put: (id: string, s: State) => void }} Store
 */

/**
 * @param {{ store: Store, now?: () => number, random?: () => number, maxWaitMs?: number }} deps
 */
export function createGovernor({ store, now = Date.now, random = Math.random, maxWaitMs = 60_000 }) {
  /** @param {string} id @param {string} day @returns {State} */
  const load = (id, day) => {
    const s = store.get(id);
    return s && s.day === day ? s : { day, reads: 0, writes: 0, last: s ? s.last : 0, stopped_at: s ? s.stopped_at : null, stopped_reason: s ? s.stopped_reason : null, cooldown_until: s ? s.cooldown_until : 0 };
  };
  const hm = (/** @type {number} */ ms, /** @type {string} */ tz) => { const m = localParts(ms, tz).minutes; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const between = (/** @type {[number, number]} */ r) => (r[0] + (r[1] - r[0]) * random()) * 1000;

  return {
    /**
     * May this call go now? ok with the wait that keeps the pace, or not ok with the class and a plain reason. A refusal never falls through to another way of reaching the account.
     * @param {{ id: string, kind: string, settings: NonNullable<ReturnType<typeof settingsOf>> }} q
     * @returns {{ ok: true, waitMs: number } | { ok: false, class: "blocked" | "rate", reason: string }}
     */
    admit({ id, kind, settings }) {
      const t = now();
      const { day, minutes } = localParts(t, settings.tz);
      const s = load(id, day);
      if (s.stopped_at) return { ok: false, class: "blocked", reason: `stopped after a challenge on ${new Date(s.stopped_at).toISOString().slice(0, 16).replace("T", " ")} UTC (${s.stopped_reason || "the site asked for a check"}): a person clears it in the browser, then resumes this Connection` };
      if (s.cooldown_until > t) return { ok: false, class: "rate", reason: `cooling down after the site said to slow down, until ${hm(s.cooldown_until, settings.tz)} (${settings.tz})` };
      if (settings.quiet && inQuiet(minutes, settings.quiet)) return { ok: false, class: "rate", reason: `quiet hours: no calls until ${settings.quiet.to} (${settings.tz})` };
      const write = kind !== "read";
      const cap = write ? settings.writes_per_day : settings.reads_per_day;
      if ((write ? s.writes : s.reads) >= cap) return { ok: false, class: "rate", reason: `the daily limit of ${cap} ${write ? "writes" : "reads"} is reached; it resets at midnight (${settings.tz})` };
      const gap = between(write ? settings.gap_write_s : settings.gap_read_s);
      const waitMs = Math.max(0, s.last + gap - t);
      if (waitMs > maxWaitMs) return { ok: false, class: "rate", reason: `pacing: the next call is allowed in ${Math.ceil(waitMs / 1000)} s` };
      return { ok: true, waitMs: Math.round(waitMs) };
    },
    /**
     * What a call found. A call that reached the account counts toward the day; a challenge stops the account until a person resumes it; a slowdown starts the cooldown.
     * @param {{ id: string, kind: string, settings: NonNullable<ReturnType<typeof settingsOf>>, cls: string, reason?: string }} q
     */
    record({ id, kind, settings, cls, reason }) {
      const t = now();
      const s = load(id, localParts(t, settings.tz).day);
      // a call that never reached the site (a bad input, a hold, no browser) used none of the account's day
      if (!["input", "held", "no_browser"].includes(cls)) { if (kind !== "read") s.writes++; else s.reads++; s.last = t; }
      if (isChallenge(cls, reason)) { s.stopped_at = t; s.stopped_reason = String(reason || "").slice(0, 160); }
      if (cls === "rate") s.cooldown_until = t + settings.cooldown_min * 60_000;
      store.put(id, s);
      return { stopped: !!s.stopped_at, cooldown_until: s.cooldown_until };
    },
    /** A person cleared the challenge. @param {string} id */
    resume(id) { const s = store.get(id); if (!s) return false; store.put(id, { ...s, stopped_at: null, stopped_reason: null }); return true; },
    /** Today's use, for the Connection page. @param {string} id @param {NonNullable<ReturnType<typeof settingsOf>>} settings */
    usage(id, settings) { const s = load(id, localParts(now(), settings.tz).day); return { day: s.day, reads: s.reads, writes: s.writes, stopped: !!s.stopped_at, stopped_reason: s.stopped_reason, cooldown_until: s.cooldown_until > now() ? s.cooldown_until : null }; },
  };
}
