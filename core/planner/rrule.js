// @ts-check
// Recurrence for calendar events: the RFC 5545 RRULE a calendar keeps (FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH), read and expanded in the event's own
// zone so a weekly 09:00 stays 09:00 across a DST change. An Event record holds one rule as text (its `rrule` field); the planner expands it into the occurrences that fall
// in a window. A month without the day (the 31st) has no occurrence that month, as in every calendar app. Pure: no records, no clock.

import { localDate, localParts, toUTC, addDays, parseDate } from "./time.js";

const DAY = 86_400_000;
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
/** The most days a COUNT rule walks from its start looking for its last occurrence. */
const WALK_MAX = 40_000;

/**
 * @typedef {{ freq: string, interval: number, count: number | null, until: string | null, byday: { n: number, d: number }[], bymonthday: number[], bymonth: number[] }} Rule
 */

/** Read an RRULE, or throw with what is wrong in words a person can use. @param {string} text @returns {Rule} */
export function parseRule(text) {
  const src = String(text ?? "").trim().replace(/^RRULE:/i, "");
  if (!src) throw new Error("the rule is empty");
  /** @type {Record<string, string>} */ const kv = {};
  for (const part of src.split(";")) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(part.trim());
    if (!m) throw new Error(`"${part}" is not a rule part (NAME=value)`);
    const k = m[1].toUpperCase();
    if (k in kv) throw new Error(`${k} is given twice`);
    kv[k] = m[2];
  }
  const freq = (kv.FREQ || "").toUpperCase();
  if (!FREQS.includes(freq)) throw new Error(`FREQ is one of ${FREQS.join(", ")}`);
  for (const k of Object.keys(kv)) if (!["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"].includes(k)) throw new Error(`${k} is not supported`);
  const int = (/** @type {string} */ name, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ dflt) => {
    if (kv[name] === undefined) return dflt;
    const n = Number(kv[name]);
    if (!/^-?\d+$/.test(kv[name]) || n < lo || n > hi) throw new Error(`${name} is a whole number from ${lo} to ${hi}`);
    return n;
  };
  const interval = int("INTERVAL", 1, 366, 1);
  const count = kv.COUNT === undefined ? null : int("COUNT", 1, 1000, 1);
  if (kv.COUNT !== undefined && kv.UNTIL !== undefined) throw new Error("give COUNT or UNTIL, not both");
  let until = null;
  if (kv.UNTIL !== undefined) {
    if (!/^\d{8}(T\d{6}Z?)?$/.test(kv.UNTIL)) throw new Error("UNTIL is a date (20261231) or a time (20261231T235959Z)");
    until = kv.UNTIL;
  }
  const list = (/** @type {string} */ name, /** @type {(x: string) => any} */ one) => (kv[name] === undefined ? [] : kv[name].split(",").map(one));
  const byday = list("BYDAY", x => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(x.trim());
    if (!m) throw new Error(`BYDAY "${x}" is not a weekday (MO) or an nth weekday (2TU, -1FR)`);
    const n = m[1] ? Number(m[1]) : 0;
    if (n && (freq === "DAILY" || freq === "WEEKLY")) throw new Error("an nth weekday needs FREQ=MONTHLY or YEARLY");
    if (Math.abs(n) > 5) throw new Error("an nth weekday is from 1 to 5, or -1 to -5");
    return { n, d: DAYS[/** @type {keyof typeof DAYS} */ (m[2].toUpperCase())] };
  });
  const bymonthday = list("BYMONTHDAY", x => { const n = Number(x); if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 31) throw new Error("BYMONTHDAY is 1 to 31 or -1 to -31"); return n; });
  const bymonth = list("BYMONTH", x => { const n = Number(x); if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error("BYMONTH is 1 to 12"); return n; });
  if (bymonthday.length && (freq === "DAILY" || freq === "WEEKLY")) throw new Error("BYMONTHDAY needs FREQ=MONTHLY or YEARLY");
  if (bymonth.length && freq !== "YEARLY") throw new Error("BYMONTH needs FREQ=YEARLY");
  if (byday.length && bymonthday.length) throw new Error("give BYDAY or BYMONTHDAY, not both");
  return { freq, interval, count, until, byday, bymonthday, bymonth };
}

/** Does this text read as a rule? @param {any} text */
export const validRule = text => { try { parseRule(text); return true; } catch { return false; } };

const dayNumber = (/** @type {{ year: number, month: number, day: number }} */ d) => Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY);
const weekday = (/** @type {{ year: number, month: number, day: number }} */ d) => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
const monthLength = (/** @type {number} */ y, /** @type {number} */ m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The Monday of a date's week, as a day number (weeks start on Monday, the rule's default). */
const monday = (/** @type {{ year: number, month: number, day: number }} */ d) => dayNumber(d) - ((weekday(d) + 6) % 7);

/** Does this weekday entry (MO, 2TU, -1FR) match the day, counting within its month? */
function dayMatches(/** @type {{ n: number, d: number }} */ e, /** @type {{ year: number, month: number, day: number }} */ d) {
  if (weekday(d) !== e.d) return false;
  if (!e.n) return true;
  const len = monthLength(d.year, d.month);
  return e.n > 0 ? Math.ceil(d.day / 7) === e.n : Math.floor((len - d.day) / 7) + 1 === -e.n;
}

/** Does the rule, anchored at its first day, fall on this day? */
function onDay(/** @type {Rule} */ r, /** @type {{ year: number, month: number, day: number }} */ a, /** @type {{ year: number, month: number, day: number }} */ d) {
  const n = dayNumber(d) - dayNumber(a);
  if (n < 0) return false;
  const inMonth = () => {
    if (r.bymonthday.length) { const len = monthLength(d.year, d.month); return r.bymonthday.some(x => (x > 0 ? x : len + 1 + x) === d.day); }
    if (r.byday.length) return r.byday.some(e => dayMatches(e, d));
    return d.day === a.day && d.day <= monthLength(d.year, d.month);
  };
  switch (r.freq) {
    case "DAILY": return n % r.interval === 0 && (!r.byday.length || r.byday.some(e => e.d === weekday(d)));
    case "WEEKLY": {
      const days = r.byday.length ? r.byday.map(e => e.d) : [weekday(a)];
      return days.includes(weekday(d)) && Math.floor((monday(d) - monday(a)) / 7) % r.interval === 0;
    }
    case "MONTHLY": return ((d.year - a.year) * 12 + (d.month - a.month)) % r.interval === 0 && inMonth();
    case "YEARLY": {
      if ((d.year - a.year) % r.interval !== 0) return false;
      if (r.bymonth.length && !r.bymonth.includes(d.month)) return false;
      if (!r.bymonth.length && d.month !== a.month) return false;
      return inMonth();
    }
  }
  return false;
}

/** The last moment a rule may start an occurrence, or Infinity. A date means through the end of that day in the zone. */
function untilMs(/** @type {Rule} */ r, /** @type {string} */ tz) {
  if (!r.until) return Infinity;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(r.until);
  if (!m) return Infinity;
  if (m[4] === undefined) { const d = parseDate(`${m[1]}-${m[2]}-${m[3]}`); return d ? toUTC(addDays(d, 1), { hour: 0, minute: 0 }, tz) - 1 : Infinity; }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * The starts (UTC ms) of a rule's occurrences inside [from, to), in the zone the event was made in. The first start is the event's own.
 * @param {{ rule: Rule | string, start: number, tz: string, from: number, to: number, limit?: number }} o
 * @returns {number[]}
 */
export function occurrences({ rule, start, tz, from, to, limit = 1000 }) {
  const r = typeof rule === "string" ? parseRule(rule) : rule;
  const anchor = localDate(start, tz);
  const p = localParts(start, tz);
  const wall = { hour: p.hour, minute: p.minute };
  const end = untilMs(r, tz);
  const out = [];
  let seen = 0;
  // Without COUNT the walk can begin near the window; with COUNT it must count from the first start.
  const first = dayNumber(anchor);
  let d = r.count ? anchor : (() => { const w = addDays(localDate(from, tz), -2); return dayNumber(w) > first ? w : anchor; })();
  for (let i = 0; i < WALK_MAX; i++, d = addDays(d, 1)) {
    if (!onDay(r, anchor, d)) continue;
    const t = toUTC(d, wall, tz);
    if (t < start) continue;
    if (t > end || t >= to) break;
    seen++;
    if (r.count && seen > r.count) break;
    if (t >= from) { out.push(t); if (out.length >= limit) break; }
  }
  return out;
}
