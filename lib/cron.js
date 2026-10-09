// @ts-check
// cron: five-field schedules (minute hour day-of-month month day-of-week), the ONE parser and the ONE "next time" (consolidation inventory item 12). Flows and watchers both use it, so a watcher and a
// Flow with the same schedule fire at the same moment.
//
// Each field takes `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, and lists of those separated by commas. Day of week is 0 to 7, where both 0 and 7 are Sunday. As in classic cron, when both
// day fields are restricted a day matches if either one does. `@hourly`, `@daily`, `@midnight`, `@weekly` and `@monthly` are accepted as the usual shorthands.
//
// Time zone: `nextCron(src, after, tz)` runs in `tz` (an IANA zone: the Space's, which is the server's own unless the Space sets one). Without `tz` it runs in UTC. A wall time the clocks skip (02:30 on
// the spring-forward night) runs once, moved on by the gap; a wall time that happens twice (fall back) runs once, the first time (lib/time's rule). The conversion is lib/time's.

import { localParts, toUTC } from "./time/index.js";

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];
const SHORT = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };
const DAY = 86_400_000;

/**
 * @typedef {{ ok: true, sets: Set<number>[], domStar: boolean, dowStar: boolean, text: string }} Cron
 * @typedef {{ ok: false, message: string, detail: string }} CronError
 */

/** One field to its set, or a readable reason. @param {string} src @param {{ name: string, min: number, max: number }} f @param {boolean} strictSteps */
function field(src, { name, min, max }, strictSteps) {
  const out = new Set();
  for (const item of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!m) return `${name} "${item}" is not a number, range, list or step`;
    let lo = min, hi = max;
    if (m[1] !== "*") { const [a, b] = m[1].split("-").map(Number); lo = a; hi = b === undefined ? (m[2] ? max : a) : b; }
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (lo < min || hi > max || lo > hi) return `${name} "${item}" is outside ${min}-${max}`;
    if (step < 1) return `${name} "${item}" has a step below 1`;
    // "*/120" in minutes means only minute 0, i.e. hourly: never what was meant, so say so (watchers ask for this; Flows already saved with such steps keep working).
    if (strictSteps && m[2] !== undefined && step > hi - lo) {
      return `${name} "${item}" steps past the end of ${min}-${max}${name === "minute" ? `; for every ${step} minutes use hours, like "0 */${Math.max(1, Math.round(step / 60))} * * *"` : ""}`;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Parse a schedule. `message` is the short reason Flows shows; `detail` names the field (watchers show it).
 * @param {string} src @param {{ strictSteps?: boolean }} [o] @returns {Cron | CronError}
 */
export function parseCron(src, { strictSteps = false } = {}) {
  const text = String(src ?? "").trim();
  const parts = (SHORT[/** @type {keyof typeof SHORT} */ (text)] || text).split(/\s+/);
  if (parts.length !== 5) return { ok: false, message: "cron has five fields: minute hour day month weekday", detail: `schedule "${text}" needs five fields (minute hour day month weekday), like "*/15 * * * *"` };
  const sets = [];
  for (let i = 0; i < 5; i++) {
    const s = field(parts[i], FIELDS[i], strictSteps);
    if (typeof s === "string") return { ok: false, message: "a cron field is out of range or malformed", detail: s };
    if (!s.size) return { ok: false, message: "a cron field is out of range or malformed", detail: `${FIELDS[i].name} "${parts[i]}" matches nothing` };
    sets.push(s);
  }
  // Sunday is both 0 and 7; keep one spelling.
  if (sets[4].has(7)) { sets[4].delete(7); sets[4].add(0); }
  return { ok: true, sets, domStar: parts[2] === "*", dowStar: parts[4] === "*", text };
}

/**
 * The first instant strictly after `after` (ms) at which a schedule matches, in `tz` (an IANA zone) or UTC. Looks at most four years ahead; null when it never matches (February 30th).
 * @param {string | Cron} src @param {number} after @param {string} [tz] @returns {number|null}
 */
export function nextCron(src, after, tz) {
  const c = typeof src === "string" ? parseCron(src) : src;
  if (!c.ok) return null;
  const [mi, ho, dom, mo, dow] = c.sets;
  const { domStar, dowStar } = c;
  const dayOk = (/** @type {number} */ d, /** @type {number} */ wd) => (domStar && dowStar ? true : domStar ? dow.has(wd) : dowStar ? dom.has(d) : dom.has(d) || dow.has(wd));
  if (tz && tz !== "UTC") {
    const hours = [...ho].sort((a, b) => a - b), minutes = [...mi].sort((a, b) => a - b);
    const p = localParts(after, tz);
    // Walk local calendar days (UTC arithmetic on the wall date is exact: a date is a date).
    let day = Date.UTC(p.year, p.month - 1, p.day);
    const endDay = day + 4 * 366 * DAY;
    for (; day <= endDay; day += DAY) {
      const dt = new Date(day);
      const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
      if (!mo.has(m) || !dayOk(d, wd)) continue;
      let best = null;
      for (const h of hours) for (const n of minutes) {
        const t = toUTC({ year: y, month: m, day: d }, { hour: h, minute: n }, tz);
        if (t > after && (best === null || t < best)) best = t;
      }
      if (best !== null) return best;
    }
    return null;
  }
  const d = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const end = after + 4 * 366 * DAY;
  while (d.getTime() <= end) {
    if (!mo.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); continue; }
    if (!dayOk(d.getUTCDate(), d.getUTCDay())) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); continue; }
    if (!ho.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); continue; }
    if (!mi.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

/**
 * The schedule in words, for telling the user what they are turning on. Common shapes get a sentence; anything else is quoted back as written.
 * @param {string} expr
 */
export function describeCron(expr) {
  if (expr === "webhook") return "whenever its webhook is called";
  if (expr === "event") return "whenever the event it listens for happens";
  const c = parseCron(expr);
  if (!c.ok) return `"${expr}"`;
  const [mi, h, dom, mo, dow] = (SHORT[/** @type {keyof typeof SHORT} */ (c.text)] || c.text).split(/\s+/);
  const everyDay = dom === "*" && mo === "*" && dow === "*";
  let m;
  if (everyDay && h === "*" && mi === "*") return "every minute";
  if (everyDay && h === "*" && (m = /^\*\/(\d+)$/.exec(mi))) return `every ${m[1]} minutes`;
  if (everyDay && h === "*" && /^\d+$/.test(mi)) return mi === "0" ? "every hour" : `every hour at :${mi.padStart(2, "0")}`;
  if (everyDay && (m = /^\*\/(\d+)$/.exec(h)) && /^\d+$/.test(mi)) return `every ${m[1]} hours`;
  if (everyDay && /^\d+$/.test(h) && /^\d+$/.test(mi)) return `every day at ${h.padStart(2, "0")}:${mi.padStart(2, "0")}`;
  return `"${c.text}"`;
}
