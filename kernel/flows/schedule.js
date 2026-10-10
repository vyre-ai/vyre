// @ts-check
// kernel/flows/schedule: when a time trigger fires (R032-09). Pure. A schedule is a cron line or an interval, in the Space's time zone (or its own), optionally limited to business hours and kept off
// holidays, with a rule for what to do about the times that passed while the server was off. The runner's one tick() and nextWake() read this and nothing else about time.
//
//   hours      { days?: ["mon", ...], from?: "09:00", to?: "17:00" } or true   the schedule fires only inside this window of the zone's week (default Monday to Friday, 9 to 5)
//   holidays   ["2026-12-25", "07-04"] or "space"   dates it never fires on: a full date, or month-day for every year; "space" is the Space's list (setting flows.holidays). With `hours` and no
//              `holidays`, the Space's list applies.
//   catch_up   "once" | "all" | "skip"   after downtime: run once for everything missed (default), run once for each time missed (at most 50), or run nothing for what was missed
//
// A cron time outside the window is skipped. An interval that lands outside the window waits for the window to open, then counts again from there. Both then count from the zone's wall clock, so
// daylight saving moves nothing (lib/time's rule for a skipped or repeated wall time).

import { nextCron } from "../../lib/cron.js";
import { localParts, toUTC } from "../../lib/time/index.js";

export const CATCH_UP = Object.freeze(["once", "all", "skip"]);
export const DAYS = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
export const SCHEDULE_KEYS = Object.freeze(["hours", "holidays", "catch_up"]);
export const CATCH_UP_CAP = 50;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const DAY = 86_400_000;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(?:\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The window as numbers: day numbers (0 = Sunday), minutes from midnight. @param {any} h @returns {{ days: Set<number>, from: number, to: number } | null} */
export function windowOf(h) {
  if (h === undefined || h === false || h === null) return null;
  const o = h === true ? {} : h;
  const mins = (/** @type {string} */ s, /** @type {number} */ d) => { const m = HM.exec(String(s ?? "")); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
  return { days: new Set((Array.isArray(o.days) && o.days.length ? o.days : WEEKDAYS).map((/** @type {string} */ d) => DAYS.indexOf(d))), from: mins(o.from, 9 * 60), to: mins(o.to, 17 * 60) };
}

/**
 * Check the schedule keys of a time trigger. @param {any} t @param {{ path: string, message: string }[]} out
 */
export function checkSchedule(t, out) {
  if (t.hours !== undefined && t.hours !== true) {
    const h = t.hours;
    if (h === null || typeof h !== "object" || Array.isArray(h)) out.push({ path: "trigger.hours", message: "hours is true (weekdays, 9:00 to 17:00) or { days, from, to }" });
    else {
      for (const k of Object.keys(h)) if (!["days", "from", "to"].includes(k)) out.push({ path: `trigger.hours.${k}`, message: `${k} is not part of hours (days, from, to)` });
      if (h.days !== undefined && !(Array.isArray(h.days) && h.days.length >= 1 && h.days.every((/** @type {string} */ d) => DAYS.includes(d)))) out.push({ path: "trigger.hours.days", message: `days is a list of ${DAYS.join(", ")}` });
      for (const k of ["from", "to"]) if (h[k] !== undefined && !HM.test(String(h[k]))) out.push({ path: `trigger.hours.${k}`, message: `${k} is a time like 09:00 (24-hour)` });
      const w = windowOf(h);
      if (w && w.from >= w.to) out.push({ path: "trigger.hours", message: "from must be earlier than to (a window does not run past midnight)" });
    }
  }
  if (t.holidays !== undefined && t.holidays !== "space") {
    if (!Array.isArray(t.holidays) || t.holidays.length > 100 || !t.holidays.every((/** @type {string} */ d) => typeof d === "string" && DATE.test(d))) out.push({ path: "trigger.holidays", message: "holidays is \"space\" or a list of up to 100 dates like 2026-12-25, or 07-04 for every year" });
  }
  if (t.catch_up !== undefined && !CATCH_UP.includes(t.catch_up)) out.push({ path: "trigger.catch_up", message: `catch_up is ${CATCH_UP.join(", ")}` });
  if ((t.hours !== undefined || t.holidays !== undefined) && t.at !== undefined) out.push({ path: "trigger", message: "hours and holidays go with a cron line or an interval, not a single set time" });
}

/** The Space's holidays as the setting holds them: dates separated by commas, spaces or lines. @param {any} v @returns {string[]} */
export function holidaysFrom(v) {
  return String(v ?? "").split(/[\s,;]+/).filter(d => DATE.test(d));
}

/**
 * Is this instant a time the schedule may fire? Inside the hours of the zone's week and not on a holiday.
 * @param {number} ms @param {any} t the trigger @param {string} zone @param {string[]} spaceHolidays
 */
export function allowedAt(ms, t, zone, spaceHolidays = []) {
  const w = windowOf(t.hours);
  const list = holidayList(t, spaceHolidays);
  if (!w && !list.length) return true;
  const p = localParts(ms, zone);
  if (isHoliday(p, list)) return false;
  if (!w) return true;
  const m = p.hour * 60 + p.minute;
  return w.days.has(p.weekday) && m >= w.from && m < w.to;
}

/** @param {any} t @param {string[]} space @returns {string[]} */
function holidayList(t, space) {
  if (Array.isArray(t.holidays)) return t.holidays;
  return t.holidays === "space" || t.hours !== undefined ? space : [];
}
/** @param {{ year: number, month: number, day: number }} p @param {string[]} list */
function isHoliday(p, list) {
  const md = `${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return list.some(d => d === md || d === `${p.year}-${md}`);
}

/**
 * The first instant at or after `from` when the window is open: inside the hours, on a day it keeps, not a holiday. Walks calendar days of the zone, at most two years.
 * @param {number} from @param {any} t @param {string} zone @param {string[]} space @returns {number | null}
 */
export function nextOpen(from, t, zone, space) {
  if (allowedAt(from, t, zone, space)) return from;
  const w = windowOf(t.hours) || { days: new Set([0, 1, 2, 3, 4, 5, 6]), from: 0, to: 24 * 60 };
  const list = holidayList(t, space);
  const p0 = localParts(from, zone);
  let day = Date.UTC(p0.year, p0.month - 1, p0.day);
  for (let i = 0; i < 740; i++, day += DAY) {
    const dt = new Date(day);
    const date = { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
    if (!w.days.has(dt.getUTCDay()) || isHoliday(date, list)) continue;
    const open = toUTC(date, { hour: Math.floor(w.from / 60), minute: w.from % 60 }, zone);
    const close = toUTC(date, { hour: Math.floor((w.to - 1) / 60), minute: (w.to - 1) % 60 }, zone) + 60_000;
    if (close <= from) continue;
    return Math.max(open, from);
  }
  return null;
}

/**
 * The next time the schedule fires after `after`. A cron time outside the window jumps to when the window opens; an interval waits for the window to open when it lands outside.
 * @param {any} t a time trigger (cron or every_ms; `at` is not scheduled here) @param {number} after @param {string} zone @param {string[]} [space]
 * @returns {number | null}
 */
export function nextFire(t, after, zone, space = []) {
  if (t.cron !== undefined) {
    let at = after;
    for (let i = 0; i < 2000; i++) {
      const n = nextCron(t.cron, at, zone);
      if (n === null) return null;
      if (allowedAt(n, t, zone, space)) return n;
      // outside the window: go straight to when it opens and take the first cron time from there (a once-a-minute line must not be walked through the night, a minute at a time)
      const open = nextOpen(n, t, zone, space);
      if (open === null) return null;
      at = open - 1;
    }
    return null;
  }
  if (t.every_ms !== undefined) return nextOpen(after + t.every_ms, t, zone, space);
  return null;
}

/**
 * Every time the schedule was due in (last, now], oldest first, at most `cap`; and how many more there were. For catch_up "all" and for counting what "once" skipped.
 * @param {any} t @param {number} last @param {number} now @param {string} zone @param {string[]} space @param {number} cap
 * @returns {{ times: number[], more: number }}
 */
export function dueTimes(t, last, now, zone, space, cap = CATCH_UP_CAP) {
  /** @type {number[]} */ const times = [];
  let more = 0, at = last;
  // (a zone-aware line costs a scan of its day, so the walk stops after a thousand times: a week of a once-a-minute line is "a thousand or more")
  for (let i = 0; i < 1000; i++) {
    const n = nextFire(t, at, zone, space);
    if (n === null || n > now) break;
    if (times.length < cap) times.push(n); else more++;
    at = n;
  }
  return { times, more };
}

/** The window in words, for the canvas and the approval card. @param {any} t */
export function describeWindow(t) {
  const bits = [];
  const w = windowOf(t.hours);
  if (w) {
    const days = [...w.days].sort((a, b) => a - b);
    const wk = days.length === 5 && [1, 2, 3, 4, 5].every(d => w.days.has(d));
    const hm = (/** @type {number} */ m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
    bits.push(`${wk ? "weekdays" : days.map(d => DAYS[d]).join(", ")} ${hm(w.from)} to ${hm(w.to)}`);
  }
  if (Array.isArray(t.holidays) ? t.holidays.length : t.holidays === "space" || w) bits.push(Array.isArray(t.holidays) ? `not on ${t.holidays.length} listed day${t.holidays.length === 1 ? "" : "s"}` : "not on the Space's holidays");
  if (t.catch_up === "all") bits.push("after downtime, once for each time missed");
  else if (t.catch_up === "skip") bits.push("after downtime, skips what was missed");
  return bits.join("; ");
}
