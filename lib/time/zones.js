// @ts-check
// Zone math with Intl alone. An item keeps its time as UTC plus a zone (ADR 0025 point 3); these
// turn a wall time on a date in a zone into UTC and back, and find the next time a repeating rule
// comes round in its zone, so a daily 07:00 stays 07:00 across a DST change.

const DAY = 86_400_000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();
function format(tz) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formats.set(tz, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Is this a zone Intl knows? */
export function validZone(tz) {
  try { format(String(tz)); return true; } catch { return false; }
}

/** The zone this process runs in. */
export const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * What a UTC instant reads as on a wall in a zone.
 * @param {number} ms @param {string} tz
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 */
export function localParts(ms, tz) {
  /** @type {any} */
  const o = {};
  for (const p of format(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { year: Number(o.year), month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute),
    second: Number(o.second), weekday: WEEKDAYS[/** @type {keyof typeof WEEKDAYS} */ (o.weekday)] };
}

/** The zone's offset from UTC at an instant, in ms (Karachi is +5 h). */
export function offset(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DD" and "HH:MM" readers; null when malformed. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const back = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return back.getUTCMonth() === d.month - 1 && back.getUTCDate() === d.day ? d : null;
}
export function parseWall(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}
const pad = n => String(n).padStart(2, "0");
export const dateString = d => `${d.year}-${pad(d.month)}-${pad(d.day)}`;
export const wallString = w => `${pad(w.hour)}:${pad(w.minute)}`;

/**
 * A wall time on a date in a zone, as UTC ms. A time the clocks skip (02:30 on the spring-forward
 * night) moves forward by the gap, as a phone does; a time that happens twice takes the first.
 * @param {{ year: number, month: number, day: number }} date @param {{ hour: number, minute: number }} wall @param {string} tz
 */
export function toUTC(date, wall, tz) {
  const guess = Date.UTC(date.year, date.month - 1, date.day, wall.hour, wall.minute);
  const before = offset(guess - DAY, tz), after = offset(guess + DAY, tz);
  const fits = [...new Set([before, after])].map(o => guess - o).filter(t => {
    const p = localParts(t, tz);
    return p.year === date.year && p.month === date.month && p.day === date.day && p.hour === wall.hour && p.minute === wall.minute;
  });
  if (fits.length) return Math.min(...fits);
  // In the gap: read the wall with the offset from before the change, which lands past it.
  return guess - before;
}

/** The local date of an instant, and n days on from a date (calendar days, no zone involved). */
export const localDate = (ms, tz) => { const p = localParts(ms, tz); return { year: p.year, month: p.month, day: p.day }; };
export function addDays(d, n) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + n * DAY);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
const dayNumber = d => Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY);
const weekday = d => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
const monthLength = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const EVERY = ["day", "weekday", "week", "month", "year"];

/**
 * Check a repeat rule and return it tidy, or throw with what is wrong.
 * @param {any} r
 * @returns {{ every: string, interval: number, days?: number[], until?: string, start?: string } | null}
 */
export function checkRepeat(r) {
  if (r === null || r === undefined) return null;
  if (typeof r !== "object" || !EVERY.includes(r.every)) throw new Error(`repeat.every is one of ${EVERY.join(", ")}`);
  const interval = r.interval === undefined ? 1 : Number(r.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) throw new Error("repeat.interval is a whole number from 1 to 366");
  const out = /** @type {any} */ ({ every: r.every, interval });
  if (r.days !== undefined) {
    if (!Array.isArray(r.days) || !r.days.length || r.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("repeat.days is a list of weekdays 0 (Sunday) to 6");
    out.days = [...new Set(r.days)].sort();
  }
  if (r.until !== undefined && r.until !== null) {
    if (!parseDate(r.until) && Number.isNaN(Date.parse(String(r.until)))) throw new Error("repeat.until is a date (YYYY-MM-DD) or an ISO time");
    out.until = String(r.until);
  }
  if (r.start !== undefined) { if (!parseDate(r.start)) throw new Error("repeat.start is a date (YYYY-MM-DD)"); out.start = String(r.start); }
  return out;
}

/** Does the rule, anchored at start, fall on day d? */
function onDay(rule, start, d) {
  const n = dayNumber(d) - dayNumber(start);
  if (n < 0) return false;
  const i = rule.interval || 1;
  switch (rule.every) {
    case "day": return n % i === 0;
    case "weekday": { const w = weekday(d); return w >= 1 && w <= 5; }
    case "week": {
      const days = rule.days || [weekday(start)];
      if (!days.includes(weekday(d))) return false;
      // Weeks counted from the Sunday of the start's week, so a Mon/Thu rule every 2 weeks keeps both days together.
      const weeks = Math.floor((dayNumber(d) - (dayNumber(start) - weekday(start))) / 7);
      return weeks % i === 0;
    }
    case "month": {
      const months = (d.year - start.year) * 12 + (d.month - start.month);
      if (months % i !== 0) return false;
      // The 31st in a shorter month rings on its last day.
      return d.day === Math.min(start.day, monthLength(d.year, d.month));
    }
    case "year": {
      if ((d.year - start.year) % i !== 0 || d.month !== start.month) return false;
      return d.day === Math.min(start.day, monthLength(d.year, d.month));
    }
  }
  return false;
}

/** The end of a rule's life as UTC ms, or Infinity. A date means through the end of that day. */
function untilMs(rule, tz) {
  if (!rule.until) return Infinity;
  const d = parseDate(rule.until);
  return d ? toUTC(addDays(d, 1), { hour: 0, minute: 0 }, tz) - 1 : Date.parse(rule.until);
}

/**
 * The next time a wall time comes round after an instant, in a zone: with a rule, the rule's next
 * day (anchored at rule.start, or the day of `after`); without one, today or tomorrow.
 * @param {{ wall: string, tz: string, after: number, repeat?: any, start?: string | null }} o
 * @returns {number | null} UTC ms, or null when the rule has ended
 */
export function nextOccurrence({ wall, tz, after, repeat = null, start = null }) {
  const w = parseWall(wall);
  if (!w) throw new Error(`"${wall}" is not a time (HH:MM)`);
  const today = localDate(after, tz);
  const anchor = parseDate(start || (repeat && repeat.start) || "") || today;
  const end = repeat ? untilMs(repeat, tz) : Infinity;
  // Start a day early: the zone's "today" may be behind the instant's own day.
  let d = dayNumber(anchor) > dayNumber(today) ? anchor : addDays(today, -1);
  const limit = 366 * ((repeat && repeat.interval) || 1) + 8;
  for (let i = 0; i < limit; i++, d = addDays(d, 1)) {
    if (repeat && !onDay(repeat, anchor, d)) continue;
    const t = toUTC(d, w, tz);
    if (t > end) return null;
    if (t > after) return t;
  }
  return null;
}
