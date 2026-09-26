// @ts-check
// cron: five-field schedules: minute, hour, day of month, month, day of week.
//
// Each field takes `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, and lists of those
// separated by commas. Day of week is 0 to 7, where both 0 and 7 are Sunday. As in classic cron,
// when both day fields are restricted a day matches if either one does. `@hourly`, `@daily`,
// `@weekly` and `@monthly` are accepted as the usual shorthands. Times are local to the machine.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

const SHORT = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };

/** @typedef {{ sets: Set<number>[], domAny: boolean, dowAny: boolean, text: string }} Cron */

/**
 * Parse a schedule. Throws with a readable reason naming the field.
 * @param {string} expr
 * @returns {Cron}
 */
export function parse(expr) {
  const text = String(expr || "").trim();
  const parts = (SHORT[/** @type {keyof typeof SHORT} */ (text)] || text).split(/\s+/);
  if (parts.length !== 5) throw new Error(`schedule "${text}" needs five fields (minute hour day month weekday), like "*/15 * * * *"`);
  const sets = parts.map((p, i) => field(p, FIELDS[i]));
  // Sunday is both 0 and 7; keep one spelling.
  if (sets[4].has(7)) { sets[4].delete(7); sets[4].add(0); }
  return { sets, domAny: parts[2] === "*", dowAny: parts[4] === "*", text };
}

function field(src, { name, min, max }) {
  const out = new Set();
  for (const item of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!m) throw new Error(`${name} "${item}" is not a number, range, list or step`);
    let lo = min, hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a; hi = b === undefined ? (m[2] ? max : a) : b;
    }
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (lo < min || hi > max || lo > hi) throw new Error(`${name} "${item}" is outside ${min}-${max}`);
    if (step < 1) throw new Error(`${name} "${item}" has a step below 1`);
    // "*/120" in minutes means only minute 0, i.e. hourly: never what was meant, so say so.
    if (m[2] !== undefined && step > hi - lo) {
      throw new Error(`${name} "${item}" steps past the end of ${min}-${max}${name === "minute" ? `; for every ${step} minutes use hours, like "0 */${Math.max(1, Math.round(step / 60))} * * *"` : ""}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function dayMatches(c, d) {
  const dom = c.sets[2].has(d.getDate()), dow = c.sets[4].has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/**
 * The first minute strictly after `after` (ms) that the schedule matches, in ms. Skips whole
 * days and hours that cannot match, so a yearly schedule costs a few hundred steps, not half a
 * million. Returns null for a schedule that never matches (February 30th).
 * @param {Cron} c
 * @param {number} after
 */
export function next(c, after) {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.sets[3].has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.sets[1].has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.sets[0].has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

/**
 * The schedule in words, for telling the user what they are turning on. Common shapes get a
 * sentence; anything else is quoted back as written.
 * @param {string} expr
 */
export function describe(expr) {
  if (expr === "webhook") return "whenever its webhook is called";
  if (expr === "event") return "whenever the event it listens for happens";
  let c;
  try { c = parse(expr); } catch { return `"${expr}"`; }
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
