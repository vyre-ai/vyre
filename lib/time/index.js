// @ts-check
// lib/time: the one time library (the user's time-zone ruling, option B). No team writes its own conversion.
//
// Three clocks: the person's own (from the device in use, following them when they travel), the space's home zone (a setting of each space), and the server's, which is never shown and never used.
// Everything is stored as UTC milliseconds; a zone is only ever used to read a wall time in, or to show one. This file has:
//   zones      validZone, systemZone, localParts, offset, toUTC, localDate, addDays, parseDate, parseWall, dateString, wallString, checkRepeat, nextOccurrence (zones.js; a daily 07:00 stays 07:00 across a DST change)
//   the device zoneFrom(value), personZone(meta): the zone the calling device says it is in, validated, else the fallback
//   which zone  scopeZone: a personal thing is read in the person's zone, a space thing in the space's; when it is unclear, the space's, and both are said
//   relative    resolve("tomorrow at 9", { now, zone }): a phrase to a UTC instant in a zone, daylight saving included, or { ambiguous } when it does not say
//   showing     showTimes(ms, { person, space }): "9:00 am PT · 9:00 pm your time"; zoneLabel; clock
//   for the AI  timeLine(...): the line every model call's brief carries: now for the person, the space and any contact in context
import { validZone, systemZone, localParts, offset, toUTC, localDate, addDays, parseDate, parseWall, dateString, wallString } from "./zones.js";

export * from "./zones.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// ---- The device's zone -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The header a device sends with a call: its own IANA zone ("Asia/Karachi"). The daemon validates it and hands it to a tool as `meta.zone`. */
export const ZONE_HEADER = "x-vyre-zone";

/** A zone from a value a client sent, or the fallback: only a zone Intl knows is believed. @param {any} v @param {string} [fallback] */
export function zoneFrom(v, fallback = "UTC") {
  const z = typeof v === "string" ? v.trim() : "";
  return z && z.length <= 64 && validZone(z) ? z : fallback;
}

/** The person's zone for a call: the device's (`meta.zone`), else the one they set, else the fallback. @param {any} meta @param {string} [set] @param {string} [fallback] */
export function personZone(meta, set, fallback = systemZone()) {
  return zoneFrom(meta && meta.zone, zoneFrom(set, fallback));
}

// ---- Which zone a time is read in ------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A personal thing (a reminder, a to-do of one's own) is read in the person's zone; a thing of the space (business hours, a deadline the team set, a Flow schedule) in the space's. When the scope
 * is not said, the space's zone is used and `both` is true, so the answer says both ("9:00 am PT, 9:00 pm for you").
 * @param {{ scope?: "personal" | "space" | undefined, person: string, space?: string | null }} o
 * @returns {{ zone: string, scope: "personal" | "space", both: boolean }}
 */
export function scopeZone({ scope, person, space }) {
  const sp = space && validZone(space) ? space : null;
  if (scope === "personal" || !sp) return { zone: person, scope: "personal", both: false };
  if (scope === "space") return { zone: sp, scope: "space", both: sp !== person };
  return { zone: sp, scope: "space", both: sp !== person };
}

// ---- Relative times ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

const DAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const UNITS = { second: 1000, sec: 1000, s: 1000, minute: MIN, min: MIN, m: MIN, hour: HOUR, hr: HOUR, h: HOUR, day: DAY, d: DAY, week: 7 * DAY, wk: 7 * DAY, w: 7 * DAY };
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "half an": 0.5 };

/** "9", "9:30", "9am", "9:30 pm", "15:30", "noon", "midnight" as a wall time, or null. A bare 1 to 7 with no am or pm is not guessed. */
function clockOf(/** @type {string} */ s) {
  const t = s.trim().toLowerCase();
  if (t === "noon") return { hour: 12, minute: 0, said: true };
  if (t === "midnight") return { hour: 0, minute: 0, said: true };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|a\.m\.|pm|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  const mer = m[3] ? m[3][0] : null;
  if (mer) { if (h < 1 || h > 12) return null; h = mer === "p" ? (h % 12) + 12 : h % 12; return { hour: h, minute: min, said: true }; }
  if (h > 23) return null;
  // 24 hour form ("15:30") or a bare hour 8 to 23 is a clock time; a bare 1 to 7 is too vague to guess.
  if (!m[2] && h < 8) return null;
  return { hour: h, minute: min, said: true };
}

/**
 * A phrase as a UTC instant, read in a zone. Daylight saving is the zone's: "tomorrow at 9" across a change is 9:00 on that day's wall, not 24 hours on. A phrase that gives no day means the next time
 * that clock comes round (today if it is still ahead). Returns null for words it does not read, and `{ ambiguous, reason }` when it reads them but they do not say (a time with no am or pm that could be either).
 * @param {string} text @param {{ now: number, zone: string, defaultTime?: { hour: number, minute: number } }} o
 * @returns {{ at: number, zone: string, date: string, wall: string } | { ambiguous: true, reason: string } | null}
 */
export function resolve(text, { now, zone, defaultTime = { hour: 9, minute: 0 } }) {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^at /, "");
  if (!raw) return null;
  const out = (/** @type {number} */ at) => { const p = localParts(at, zone); return { at, zone, date: dateString(p), wall: wallString(p) }; };
  if (raw === "now") return out(now);
  // in 20 minutes, in 2 hours, in a day, in half an hour
  const rel = /^in (half an|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|\d+(?:\.\d+)?) ?(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?)$/.exec(raw);
  if (rel) {
    const n = /** @type {any} */ (WORDS)[rel[1]] ?? Number(rel[1]);
    const unit = /** @type {any} */ (UNITS)[rel[2].replace(/s$/, "")];
    if (!Number.isFinite(n) || !unit) return null;
    // A day or a week is calendar days on the wall (so it keeps its time of day over a clock change); smaller units are elapsed time.
    if (unit >= DAY) { const d = addDays(localDate(now, zone), Math.round((n * unit) / DAY)); const p = localParts(now, zone); return out(toUTC(d, { hour: p.hour, minute: p.minute }, zone)); }
    return out(now + Math.round(n * unit));
  }
  // [day] [at] [time]
  /** @type {{ year: number, month: number, day: number } | null} */ let day = null;
  let rest = raw;
  const today = localDate(now, zone);
  const m1 = /^(today|tonight|tomorrow|day after tomorrow|next week)\b ?(.*)$/.exec(rest);
  const m2 = /^(?:(next|this|on) )?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b ?(.*)$/.exec(rest);
  const m3 = /^(\d{4}-\d{2}-\d{2})\b ?(.*)$/.exec(rest);
  /** @type {{ hour: number, minute: number } | null} */ let pm = null;
  if (m1) {
    rest = m1[2];
    if (m1[1] === "today") day = today;
    else if (m1[1] === "tonight") { day = today; pm = { hour: 20, minute: 0 }; }
    else if (m1[1] === "tomorrow") day = addDays(today, 1);
    else if (m1[1] === "next week") day = addDays(today, 7);
    else day = addDays(today, 2);
  } else if (m2) {
    rest = m2[3];
    const want = /** @type {any} */ (DAYS)[m2[2]];
    const cur = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let ahead = (want - cur + 7) % 7;
    if (ahead === 0 && m2[1] !== "this") ahead = 7;
    day = addDays(today, ahead);
  } else if (m3) {
    const d = parseDate(m3[1]);
    if (!d) return null;
    day = d; rest = m3[2];
  }
  rest = rest.replace(/^at /, "").replace(/^(in the )?(morning|afternoon|evening)$/, (_, __, w) => w).trim();
  /** @type {{ hour: number, minute: number } | null} */ let time = null;
  if (rest) {
    if (rest === "morning") time = { hour: 9, minute: 0 };
    else if (rest === "afternoon") time = { hour: 15, minute: 0 };
    else if (rest === "evening") time = { hour: 18, minute: 0 };
    else {
      const c = clockOf(rest);
      if (!c) {
        // "9" or "5" alone, with no am or pm, could be either
        if (/^\d{1,2}(:\d{2})?$/.test(rest)) return { ambiguous: true, reason: `"${rest}" could be morning or evening: say am or pm` };
        return null;
      }
      time = c;
    }
  } else if (!day) return null;
  const wall = time || pm || defaultTime;
  if (day) return out(toUTC(day, wall, zone));
  // a clock time alone: the next time it comes round
  let t = toUTC(today, wall, zone);
  if (t <= now) t = toUTC(addDays(today, 1), wall, zone);
  return out(t);
}

// ---- Showing a time ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** @type {Map<string, Intl.DateTimeFormat>} */
const clockFormats = new Map();
/** "9:00 am" in a zone. @param {number} ms @param {string} zone */
export function clock(ms, zone) {
  let f = clockFormats.get(zone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }); clockFormats.set(zone, f); }
  return f.format(new Date(ms)).replace(/ | /g, " ").replace(/ ?(AM|PM)$/, (_, a) => ` ${a.toLowerCase()}`);
}

/** The short name of a zone at an instant: "PT" for America/Los_Angeles, "ET", "CT"; a zone with no short generic name gets its offset ("GMT+5"). @param {string} zone @param {number} [ms] */
export function zoneLabel(zone, ms = Date.now()) {
  for (const style of /** @type {const} */ (["shortGeneric", "short"])) {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style }).formatToParts(new Date(ms)).find(p => p.type === "timeZoneName");
      const v = part ? part.value : "";
      if (/^[A-Z]{2,5}$/.test(v)) return v;
      if (style === "short" && v) return v;
    } catch { /* try the next */ }
  }
  return zone;
}

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A time as the person reads it, and, when the space's zone is a different clock at that instant, the space's too: "9:00 am PT · 9:00 pm your time". A different day on one side says which
 * ("9:00 am PT · 2:00 am Tue your time"). `person` is the reader's zone; with no `space` (a personal thing) it is only their clock.
 * @param {number} ms @param {{ person: string, space?: string | null, youSay?: string }} o
 * @returns {{ text: string, person: string, space: string | null }}
 */
export function showTimes(ms, { person, space = null, youSay = "your time" }) {
  const mine = clock(ms, person);
  if (!space || !validZone(space) || offset(ms, space) === offset(ms, person)) return { text: mine, person: mine, space: null };
  const theirs = clock(ms, space);
  const pd = localParts(ms, person), sd = localParts(ms, space);
  const sameDay = pd.year === sd.year && pd.month === sd.month && pd.day === sd.day;
  const mineTag = sameDay ? mine : `${mine} ${WEEK[pd.weekday]}`;
  return { text: `${theirs} ${zoneLabel(space, ms)} · ${mineTag} ${youSay}`, person: mine, space: theirs };
}

// ---- For the AI -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** "Mon 5 Oct 2026, 9:41 pm" in a zone. @param {number} ms @param {string} zone */
export function stamp(ms, zone) {
  const p = localParts(ms, zone);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][p.month - 1];
  return `${WEEK[p.weekday]} ${p.day} ${mon} ${p.year}, ${clock(ms, zone)}`;
}

/**
 * The time line every model call's brief carries, from every entry point: now for the person, the space's zone, and any contact in context.
 * @param {{ now: number, person: string, space?: string | null, contacts?: { name: string, zone: string }[] }} o
 */
export function timeLine({ now, person, space = null, contacts = [] }) {
  const parts = [`Time: it is ${stamp(now, person)} for the person (${person}).`];
  if (space && validZone(space) && space !== person) parts.push(`This space keeps ${space}, where it is ${stamp(now, space)}.`);
  for (const c of contacts.filter(x => x && validZone(x.zone)).slice(0, 5)) parts.push(`${c.name} is in ${c.zone}, where it is ${clock(now, c.zone)}.`);
  parts.push(space && space !== person
    ? "A relative time (\"tomorrow at 9\") is read in the person's zone for personal things and in the space's zone for things of the space; when it is unclear, use the space's zone and say both."
    : "A relative time (\"tomorrow at 9\") is read in the person's zone.");
  return parts.join(" ");
}
