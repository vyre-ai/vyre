// @ts-check
// Cron in a time zone (the Space's). The conversion is lib/time's, the one time library (the user's time-zone ruling, option B): no team writes its own. Daylight saving, as lib/time has it and
// as a phone does: a wall time the clocks skip (02:30 on the spring-forward night) runs once, moved on by the gap (03:30); a wall time that happens twice (fall back) runs once, the first time. A run is
// never doubled by either, because the next search starts strictly after the instant that just ran. The server's own zone is never used: a Space with no zone set runs in UTC.
import { validZone, localParts, toUTC } from "../../lib/time/index.js";

const DAY = 86_400_000;

/** Is this an IANA time zone name this runtime knows? @param {string} tz */
export const validTimeZone = tz => typeof tz === "string" && tz.length > 0 && validZone(tz);

/** The zone's wall clock at an instant. @param {number} t @param {string} tz @returns {{ y: number, mo: number, d: number, h: number, mi: number, dow: number }} */
export function wall(t, tz) {
  const p = localParts(t, tz);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, dow: p.weekday };
}

/** The instant a wall time happens in a zone (lib/time's rule). @param {number} y @param {number} mo @param {number} d @param {number} h @param {number} mi @param {string} tz */
export const zonedToUtc = (y, mo, d, h, mi, tz) => toUTC({ year: y, month: mo, day: d }, { hour: h, minute: mi }, tz);

/**
 * The first instant strictly after `after` (ms) at which a parsed cron matches in `tz`. `sets` are parseCron's [minute, hour, day, month, weekday]; `domStar` and `dowStar` say
 * whether the day fields were `*` (cron's day rule: both given means either).
 * @param {Set<number>[]} sets @param {boolean} domStar @param {boolean} dowStar @param {number} after @param {string} tz @returns {number|null}
 */
export function nextCronZoned(sets, domStar, dowStar, after, tz) {
  const [mi, ho, dom, mo, dow] = sets;
  const hours = [...ho].sort((a, b) => a - b), minutes = [...mi].sort((a, b) => a - b);
  const start = wall(after, tz);
  // Walk local calendar days (UTC arithmetic on the wall date is exact: a date is a date).
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  const endDay = day + 4 * 366 * DAY;
  for (; day <= endDay; day += DAY) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    if (!mo.has(m)) continue;
    const dayOk = domStar && dowStar ? true : domStar ? dow.has(wd) : dowStar ? dom.has(d) : dom.has(d) || dow.has(wd);
    if (!dayOk) continue;
    let best = null;
    for (const h of hours) for (const n of minutes) {
      const t = zonedToUtc(y, m, d, h, n, tz);
      if (t > after && (best === null || t < best)) best = t;
    }
    if (best !== null) return best;
  }
  return null;
}
