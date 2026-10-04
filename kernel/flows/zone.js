// @ts-check
// Cron in a time zone (the Space's), without a dependency: Intl gives the zone's wall clock, and these functions turn a wall time back into an instant.
// Daylight saving rules, written down because a schedule must mean one thing:
//   - a wall time that does not exist (spring forward, 02:30 on the night the clock jumps) runs once, at the first real minute after the gap;
//   - a wall time that happens twice (fall back, 01:30 twice) runs once, the first time it occurs;
//   - a run is never doubled by either, because the next search starts strictly after the instant that just ran.

const DAY = 86_400_000;
/** @type {Map<string, Intl.DateTimeFormat>} */ const fmts = new Map();

/** Is this an IANA time zone name this runtime knows? @param {string} tz */
export function validTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** @param {string} tz */
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" }); fmts.set(tz, f); }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The zone's wall clock at an instant. @param {number} t @param {string} tz @returns {{ y: number, mo: number, d: number, h: number, mi: number, dow: number }} */
export function wall(t, tz) {
  /** @type {Record<string, string>} */ const p = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), dow: /** @type {any} */ (WD)[p.weekday] };
}

/** The zone's offset from UTC at an instant, in ms (positive east). @param {number} t @param {string} tz */
export function offsetAt(t, tz) {
  const w = wall(t, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000;
}

/**
 * The instant a wall time happens in a zone, by the rules above: the first occurrence when it happens twice, and the first real minute after the gap when it never happens.
 * @param {number} y @param {number} mo @param {number} d @param {number} h @param {number} mi @param {string} tz
 */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  /** @type {number[]} */ const ok = [];
  for (const o of new Set([offsetAt(asUtc - DAY, tz), offsetAt(asUtc + DAY, tz)])) {
    const t = asUtc - o;
    if (offsetAt(t, tz) === o) ok.push(t);
  }
  if (ok.length) return Math.min(...ok);
  // In the gap: find the first minute whose offset is the new one.
  const lo0 = asUtc - offsetAt(asUtc + DAY, tz), hi0 = asUtc - offsetAt(asUtc - DAY, tz);
  let lo = Math.min(lo0, hi0), hi = Math.max(lo0, hi0);
  const after = offsetAt(asUtc + DAY, tz);
  while (hi - lo > 60_000) { const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000; if (offsetAt(mid, tz) === after) hi = mid; else lo = mid + 60_000; }
  return hi;
}

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
