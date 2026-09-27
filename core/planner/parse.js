// @ts-check
// parse: a person's words to a proposed planner item (ADR 0025, decision 13). "alarm 7am" is an
// alarm at the next 07:00, "timer 10 min" a timer of 600000 ms, "remind me to call juno at 6" a
// reminder at whichever 6 o'clock comes next, "todo call kit by friday !high" a todo due Friday at
// priority 3. This file is the planner's one reader of time words.
//
// Three answers. An item: { kind, title, at, tz, ... } with `at` the next ring instant in UTC ms.
// Words that are a planner phrase but cannot be placed ("remind me today at 6am" at noon, "timer
// for the bread"): { ambiguous: true, reason }, and the surface asks, it never guesses. Words that
// are not a planner phrase at all ("whatsapp juno: running late"): null.
//
// A kind hint (o.kind) reads the words as that kind without its keyword: kind "timer" with "10
// min", kind "reminder" with "call juno at 6", kind "note" with anything.
//
// Pure: `now` (ms) and `tz` (IANA zone) come in, nothing runs, and only Intl is used for time.
// Wall times are read in `tz`, never the zone of the machine running the code.
//
// The time words and their readings are ported from the Capsule's apps router
// (local/apps/route.js on work/capsule-apps: parseDuration with its number words up to sixty,
// parseClock, fixed, and reminderParts with its rules for time words in the middle of a task,
// "tonight at 12" and "tonight at 1" to 4, the current minute, "today" after 09:00 and a
// trailing "please"). Keep the two in step when either changes.
//
// Daylight saving: a duration ("in 20 minutes", a timer) is added to the instant. A wall time is
// turned into UTC in the zone; a time a spring change skips (02:30 that morning) moves forward
// by the gap (03:30), and a time a fall change repeats is the first of the two.

/**
 * @typedef {"alarm" | "timer" | "reminder" | "todo" | "note"} Kind
 * @typedef {{ every: "day" | "weekday" | "week", days?: number[] }} Repeat
 * @typedef {{
 *   kind: Kind, title: string, at?: number, tz?: string, wall?: string, date?: string, repeat?: Repeat,
 *   duration?: number, duration_ms?: number, list?: string, priority?: number, due?: string
 * }} Parsed
 * @typedef {{ ambiguous: true, reason: string }} Ambiguous
 * @typedef {Parsed | Ambiguous} Result
 * @typedef {{ y: number, mo: number, d: number, h: number, mi: number, s: number, dow: number }} Wall
 * @typedef {{ now: number, w: Wall, tz: string }} Ctx
 */

/** Longer text than this is never a command; refusing it early also bounds every regex below. */
export const MAX_TEXT = 2000;

export const KINDS = /** @type {const} */ (["alarm", "timer", "reminder", "todo", "note"]);

// ---- Time words (ported from the apps router) --------------------------------------------

const UNIT = "(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])";
const ONE = `\\d+(?:\\.\\d+)?\\s*${UNIT}`;
const DUR = `(?:half\\s+an\\s+hour|an?\\s+(?:hour|minute)|${ONE})(?:\\s*(?:,|and)?\\s*${ONE})*`;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = `(?:${DAYS.join("|")})`;
const CLOCK = "(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:[ap]\\.?m\\.?)?|noon|midnight)";
const AMPM = "\\d{1,2}(?:[:.]\\d{2})?\\s*[ap]\\.?m\\.?";

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = /** @type {Record<string, number>} */ ({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 });

/** "twenty-five minutes" -> "25 minutes": number words from one to sixty, as digits. */
function numberWords(/** @type {string} */ s) {
  return s
    .replace(/\b(twenty|thirty|forty|fifty)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/g, (_, t, u) => String(TENS[t] + SMALL.indexOf(u)))
    .replace(/\b(twenty|thirty|forty|fifty|sixty)\b/g, t => String(TENS[t]))
    .replace(new RegExp(`\\b(${SMALL.slice(1).join("|")})\\b`, "g"), w => String(SMALL.indexOf(w)));
}

/**
 * Seconds in "10 min", "1h30m", "1h30", "a 10-minute", "ten minutes", "2 hours and 5 minutes",
 * "half an hour"; null unless the whole text is a duration.
 * @param {string} text
 */
export function parseDuration(text) {
  let s = numberWords(String(text).trim().toLowerCase());
  s = s.replace(/^an?\s+(?=\d)/, "").replace(/(\d)-(?=[a-z])/g, "$1 ").replace(/^(\d+)\s*h\s*(\d{1,2})$/, "$1h$2m");
  if (s.length > 80 || !new RegExp(`^${DUR}$`).test(s)) return null;
  let total = 0;
  if (/^half\s+an\s+hour/.test(s)) total += 1800;
  else if (/^an?\s+hour/.test(s)) total += 3600;
  else if (/^an?\s+minute/.test(s)) total += 60;
  for (const m of s.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})`, "g"))) {
    const u = m[2][0];
    total += Number(m[1]) * (u === "h" ? 3600 : u === "m" ? 60 : 1);
  }
  return total > 0 ? Math.round(total) : null;
}

/**
 * "7", "6:45", "7.30", "7am", "3:30 p.m.", "noon" -> hour, minute, and am/pm when said.
 * @param {string} text
 * @returns {{ h: number, mi: number, mer: "am" | "pm" | null, colon: boolean } | null}
 */
export function parseClock(text) {
  const s = String(text).trim().toLowerCase();
  if (s === "noon") return { h: 12, mi: 0, mer: "pm", colon: false };
  if (s === "midnight") return { h: 0, mi: 0, mer: "am", colon: false };
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?m\.?)?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0, mer = m[3] ? (m[3] === "a" ? "am" : "pm") : null;
  if (mi > 59 || h > 23 || (mer && (h < 1 || h > 12))) return null;
  return { h, mi, mer, colon: Boolean(m[2]) };
}

/** A clock time on a 24-hour dial, when it can be only one. */
function fixed(/** @type {{ h: number, mer: string | null }} */ c) {
  if (c.mer === "am") return c.h % 12;
  if (c.mer === "pm") return (c.h % 12) + 12;
  return null;
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** @type {Map<string, Intl.DateTimeFormat>} one formatter per zone; building them is the slow part */
const FORMATS = new Map();

/** The wall clock at `ms` in a zone. @returns {Wall} */
function wall(/** @type {number} */ ms, /** @type {string} */ tz) {
  let f = FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    FORMATS.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const y = Number(p.year), mo = Number(p.month), d = Number(p.day);
  return { y, mo, d, h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/** The zone's offset from UTC at an instant, in ms (Karachi is +5 h). */
function offsetAt(/** @type {number} */ ms, /** @type {string} */ tz) {
  const w = wall(ms, tz);
  const t = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - t;
}

/**
 * The UTC instant of a wall time in a zone. Guess with the offset at the naive instant, then
 * again with the offset at that guess; when neither lands on the wall time it is in a spring
 * gap, and the later guess is the wall time moved forward by the gap.
 * @param {number} y @param {number} mo 1-12 @param {number} d @param {number} h @param {number} mi @param {string} tz
 */
export function utcFor(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const t1 = naive - offsetAt(naive, tz);
  const t2 = naive - offsetAt(t1, tz);
  if (t1 === t2) return t1;
  const w = wall(t2, tz);
  if (w.h === h && w.mi === mi) return t2;
  return Math.max(t1, t2);
}

/** The calendar date `n` days after a wall date, as parts. */
function dayAfter(/** @type {{ y: number, mo: number, d: number }} */ w, /** @type {number} */ n) {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

const ymd = (/** @type {{ y: number, mo: number, d: number }} */ x) => `${x.y}-${pad(x.mo)}-${pad(x.d)}`;
const nowIso = (/** @type {Wall} */ w) => `${ymd(w)}T${pad(w.h)}:${pad(w.mi)}`;

/**
 * How many days ahead a weekday is: 0 today, up to 6. With `next`, the one in next week (weeks
 * start on Monday): on a Thursday, "next monday" is in four days and "next friday" in eight.
 */
function ahead(/** @type {Wall} */ w, /** @type {string} */ name, next = false) {
  const target = DAYS.indexOf(name.toLowerCase());
  if (!next) return (target - w.dow + 7) % 7;
  const toMonday = (1 - w.dow + 7) % 7 || 7;
  return toMonday + (target - 1 + 7) % 7;
}

/** Collapse spaces, and drop the "please" and end punctuation a person adds to a request. */
const tidy = (/** @type {string} */ s) => String(s).replace(/\s+/g, " ").trim()
  .replace(/[?!.]+$/, "").replace(/[\s,]+please$/i, "").replace(/^please\s+/i, "").replace(/[?!.]+$/, "").trim();

/** @returns {Ambiguous} */
const unsure = (/** @type {string} */ reason) => ({ ambiguous: true, reason });

/** A resolved wall time: the local date and time, and the UTC instant (ms). */
function placed(/** @type {{ y: number, mo: number, d: number }} */ day, /** @type {number} */ h, /** @type {number} */ mi, /** @type {string} */ tz) {
  return { date: ymd(day), wall: `${pad(h)}:${pad(mi)}`, at: utcFor(day.y, day.mo, day.d, h, mi, tz) };
}

// ---- Repeats -----------------------------------------------------------------------------

const REPEAT = new RegExp(`(?:^|\\s)(?:(?:every|each)\\s+(day|weekday|weekend(?:\\s+day)?|${WEEKDAY})|(?:on\\s+)?(weekdays|weekends)|(daily)|(?:on\\s+|every\\s+)?(${WEEKDAY})s)(?=\\s|$)`, "i");

/**
 * "every day", "daily", "weekdays", "every weekday", "weekends", "every monday", "mondays",
 * and the words left over.
 * @param {string} s
 * @returns {{ repeat: Repeat | null, rest: string }}
 */
function takeRepeat(s) {
  const m = REPEAT.exec(s);
  if (!m) return { repeat: null, rest: s };
  const rest = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  const word = (m[1] || m[2] || m[3] || m[4]).toLowerCase();
  /** @type {Repeat} */
  let repeat;
  if (word === "day" || word === "daily") repeat = { every: "day" };
  else if (word === "weekday" || word === "weekdays") repeat = { every: "weekday", days: [1, 2, 3, 4, 5] };
  else if (word.startsWith("weekend")) repeat = { every: "week", days: [0, 6] };
  else repeat = { every: "week", days: [DAYS.indexOf(word)] };
  return { repeat, rest };
}

/** The first moment at h:mi on a day the rule allows, strictly after now. */
function nextRepeat(/** @type {Repeat} */ r, /** @type {number} */ h, /** @type {number} */ mi, /** @type {Ctx} */ c) {
  const now = nowIso(c.w);
  for (let n = 0; n <= 7; n++) {
    const day = dayAfter(c.w, n);
    if (r.days && !r.days.includes(day.dow)) continue;
    const p = placed(day, h, mi, c.tz);
    if (`${p.date}T${p.wall}` > now) return p;
  }
  return null;
}

// ---- Timers and alarms -------------------------------------------------------------------

/** @returns {Parsed} */
function timer(/** @type {number} */ seconds, /** @type {Ctx} */ c, /** @type {string | undefined} */ label) {
  const ms = seconds * 1000;
  return { kind: "timer", title: (label || "").trim() || "Timer", at: c.now + ms, tz: c.tz, duration: ms, duration_ms: ms };
}

/** @param {string} t @param {Ctx} c @returns {Result | undefined} undefined: not timer words */
function timerRules(t, c) {
  let m = /^(?:(?:set|start)\s+)?(?:an?\s+)?timer(?:\s*:\s*|\s+(?:for\s+)?|$)(.*)$/i.exec(t);
  if (m) {
    const [, len, label] = /^(.*?)(?:\s+(?:for|called)\s+(.+))?$/i.exec(m[1]) || [];
    const s = len ? parseDuration(len) : null;
    return s ? timer(s, c, label) : unsure(len ? `"${len}" is not a length of time` : "how long a timer?");
  }
  m = /^(?:(?:set|start)\s+)?(?:an?\s+)?(.+?)\s+timer(?:\s+(?:for|called)\s+(.+))?$/i.exec(t);
  if (m && parseDuration(m[1])) return timer(/** @type {number} */ (parseDuration(m[1])), c, m[2]);
  return undefined;
}

/**
 * An alarm's words after "alarm" or "wake me": a time, an optional day or repeat, an optional
 * label. The time reads as the router reads it: am/pm when said, a colon time as written, and a
 * bare hour in the morning. With no day, the next time the clock shows it (strictly after now:
 * an alarm for the current minute would ring at once, so it is the next one).
 * @param {string} words @param {Ctx} c @returns {Result}
 */
function alarm(words, c) {
  const { repeat, rest: r1 } = takeRepeat(words);
  let rest = ` ${r1} `, dayWord = null;
  const dm = new RegExp(`\\s(?:on\\s+)?((?:next\\s+)?${WEEKDAY}|today|tonight|tomorrow)(?=\\s)`, "i").exec(rest);
  if (dm) {
    dayWord = dm[1].toLowerCase().replace(/\s+/g, " ");
    rest = rest.slice(0, dm.index) + " " + rest.slice(dm.index + dm[0].length);
  }
  const m = new RegExp(`^(?:at\\s+|for\\s+)?(${CLOCK})(?:\\s+(?:for\\s+|to\\s+|called\\s+|-\\s+|:\\s*)?([\\s\\S]*))?$`, "i").exec(tidy(rest));
  if (!m) return unsure(`"${tidy(words).slice(0, 60)}" is not a time Vyre can set an alarm for`);
  const cl = parseClock(m[1]);
  if (!cl) return unsure(`"${m[1].trim()}" is not a time Vyre can set an alarm for`);
  if (repeat && dayWord) return unsure("a repeating alarm cannot also be for one day");
  let h = fixed(cl) ?? cl.h;
  // Tonight runs past midnight, as in reminders: 12 is midnight, 1 to 4 the small hours after it.
  if (dayWord === "tonight" && cl.mer === null && h <= 12) {
    if (h === 12 || h <= 4) dayWord = "tomorrow", h %= 12;
    else h += 12;
  }
  const title = (m[2] || "").trim() || "Alarm";
  if (repeat) {
    const p = nextRepeat(repeat, h, cl.mi, c);
    return p ? { kind: "alarm", title, at: p.at, tz: c.tz, wall: p.wall, repeat } : unsure("that rule has no time left to ring");
  }
  const now = nowIso(c.w);
  let days;
  if (!dayWord) days = [0, 1];
  else if (dayWord === "today" || dayWord === "tonight") days = [0];
  else if (dayWord === "tomorrow") days = [1];
  else {
    const n = ahead(c.w, dayWord.replace(/^next /, ""), dayWord.startsWith("next "));
    days = n === 0 ? [0, 7] : [n];
  }
  for (const n of days) {
    const p = placed(dayAfter(c.w, n), h, cl.mi, c.tz);
    if (`${p.date}T${p.wall}` > now) return { kind: "alarm", title, at: p.at, tz: c.tz, wall: p.wall, date: p.date };
  }
  return unsure("that time has already passed today");
}

/** @param {string} t @param {Ctx} c @returns {Result | undefined} undefined: not alarm words */
function alarmRules(t, c) {
  const m = /^(?:(?:set|make)\s+)?(?:an?\s+)?alarm(?:\s*:\s*|\s+(?:for\s+|at\s+)?|$)(.*)$/i.exec(t) || /^wake\s+me(?:\s+up)?(?:\s+at)?\s+(.+)$/i.exec(t);
  if (!m) return undefined;
  return m[1] ? alarm(m[1], c) : unsure("an alarm for what time?");
}

/** Timer and alarm words, and a bare duration ("5 min") as a timer. @returns {Result | undefined} */
function clockRules(/** @type {string} */ t, /** @type {Ctx} */ c) {
  const r = timerRules(t, c) ?? alarmRules(t, c);
  if (r) return r;
  const s = parseDuration(t);
  return s ? timer(s, c, "") : undefined;
}

// ---- Notes -------------------------------------------------------------------------------

/** @param {string} raw @returns {Result | undefined} */
function noteRules(raw) {
  // A dash separates only with spaces round it, so "note-taking tips" is not a note.
  const m = /^(?:(?:add|save)\s+(?:this\s+)?to\s+(?:my\s+)?notes?|new\s+note|make\s+a\s+note|take\s+a\s+note|note(?:\s+down)?)(?:\s*:\s*|\s+-\s+|\s+|$)([\s\S]*)$/i.exec(raw);
  if (!m) return undefined;
  const text = m[1].replace(/^(?:to\s+self\b\s*:?\s*|that\s+|of\s+)/i, "").trim();
  // "make a note of this" names nothing to write down.
  if (!text || /^(?:this|that|it)[.!]?$/i.test(text)) return unsure("a note saying what?");
  return { kind: "note", title: text };
}

// ---- Reminders (reminderParts from the apps router, placed in UTC here) ------------------

/**
 * A reminder's words to its task and time. Time words are taken after "at", "on" or "in"
 * wherever they are, and bare ("tomorrow", "friday", "9am") only at the start or the end, so
 * "email about sunday brunch" and "take my 3pm pill" keep their words. A time in the current
 * minute counts as now: `at` is then now itself, never a moment already gone.
 * @param {string} words @param {Ctx} c @returns {Result}
 */
function reminder(words, c) {
  const { now, w, tz } = c;
  const { repeat, rest: r1 } = takeRepeat(words);
  let rest = ` ${r1} `;
  /** @type {Record<string, RegExpExecArray | null>} */
  const got = { dur: null, time: null, day: null };
  /** @type {[keyof typeof got, RegExp][]} */
  const rules = [
    ["dur", new RegExp(`\\sin\\s+(${DUR})(?=\\s)`, "i")],
    ["time", new RegExp(`\\sat\\s+(${CLOCK})(?=\\s)`, "i")],
    ["time", new RegExp(`^\\s+(${AMPM})(?=\\s)`, "i")],
    ["time", new RegExp(`\\s(${AMPM})\\s*$`, "i")],
    ["day", new RegExp(`\\son\\s+((?:next\\s+)?${WEEKDAY})(?=\\s)`, "i")],
    ["day", new RegExp(`^\\s+((?:next\\s+)?${WEEKDAY}|today|tonight|tomorrow)(?=\\s)`, "i")],
    ["day", new RegExp(`\\s((?:next\\s+)?${WEEKDAY}|today|tonight|tomorrow)\\s*$`, "i")],
  ];
  // Taking one phrase can bring another to an edge ("tomorrow at 9 to ..."), so go round again.
  for (let round = 0, moved = true; moved && round < 4; round++) {
    moved = false;
    for (const [k, re] of rules) {
      if (got[k]) continue;
      const m = re.exec(rest);
      if (!m) continue;
      got[k] = m;
      rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length) + " ";
      moved = true;
    }
  }
  const title = tidy(rest).replace(/^(?:to|that|about)\s+/i, "").replace(/\s+(?:to|at|on|in)$/i, "").trim();
  if (!title) return unsure("remind you of what?");

  if (got.dur) {
    if (repeat || got.time || got.day) return unsure("say either a length of time or a time of day, not both");
    const s = parseDuration(got.dur[1]);
    return s ? { kind: "reminder", title, at: now + s * 1000, tz } : unsure(`"in ${got.dur[1]}" is not a length of time`);
  }
  const clock = got.time ? parseClock(got.time[1]) : null;
  if (got.time && !clock) return unsure(`"${got.time[1].trim()}" is not a time`);
  if (repeat) {
    if (got.day) return unsure("a repeating reminder cannot also be for one day");
    // A repeat with no time rings at 9, as a named day with no time does.
    const h = !clock ? 9 : fixed(clock) ?? (clock.h >= 7 || clock.h === 0 ? clock.h : clock.h + 12);
    const p = nextRepeat(repeat, h, clock ? clock.mi : 0, c);
    return p ? { kind: "reminder", title, at: p.at, tz, wall: p.wall, repeat } : unsure("that rule has no time left to ring");
  }
  const dayWord = got.day ? got.day[1].toLowerCase().replace(/\s+/g, " ") : null;
  const next = Boolean(dayWord && dayWord.startsWith("next "));
  const weekday = dayWord ? dayWord.replace(/^next /, "") : null;
  const isWeekday = Boolean(weekday && DAYS.includes(weekday));
  const tonight = dayWord === "tonight";
  /** @type {number | null} days ahead the words fix, or null for "the next one" */
  const offset = dayWord === "today" || tonight ? 0 : dayWord === "tomorrow" ? 1 : isWeekday ? ahead(w, /** @type {string} */ (weekday), next) : null;
  if (!clock && offset === null) return { kind: "reminder", title };

  // Candidate (days ahead, hour) pairs, earliest first; the first not yet past wins.
  const mi = clock ? clock.mi : 0;
  /** @type {[number, number][]} */
  let tries;
  if (tonight) {
    // Tonight runs past midnight: 12 is midnight, 1 to 4 the small hours after it.
    const f = clock ? fixed(clock) : null;
    const h = !clock ? 20 : f !== null ? f : clock.h === 12 ? 0 : clock.h <= 4 ? clock.h : clock.h < 12 ? clock.h + 12 : clock.h;
    tries = [[h < 5 ? 1 : 0, h]];
  } else {
    /** @type {number[]} */
    let hours;
    if (!clock) hours = [9];
    else if (fixed(clock) !== null) hours = [/** @type {number} */ (fixed(clock))];
    else if (clock.h === 0 || clock.h > 12) hours = [clock.h];
    else if (clock.h === 12) hours = [12];
    else if (offset !== null && offset > 0) hours = [clock.h >= 7 ? clock.h : clock.h + 12];
    else hours = [clock.h, clock.h + 12];
    // No day: today, then tomorrow. A weekday that is today, with its time gone, is next week's.
    const days = offset === null ? [0, 1] : isWeekday && offset === 0 ? [0, 7] : [offset];
    tries = days.flatMap(n => hours.map(h => /** @type {[number, number]} */ ([n, h])));
  }
  const nowWall = nowIso(w);
  for (const [n, h] of tries) {
    const p = placed(dayAfter(w, n), h, mi, tz);
    if (`${p.date}T${p.wall}` >= nowWall) return { kind: "reminder", title, at: Math.max(p.at, now), tz, wall: p.wall, date: p.date };
  }
  // "today" with no time, once 09:00 has gone, is a plain reminder; a named time that has gone is not.
  if (!clock && dayWord === "today") return { kind: "reminder", title };
  return unsure(offset === 0 ? "that time has already passed today" : "that time has passed");
}

/** @param {string} t @param {Ctx} c @returns {Result | undefined} */
function reminderRules(t, c) {
  const m = /^remind\s+me(?:\s+(.*))?$/i.exec(t);
  if (!m) return undefined;
  return m[1] ? reminder(m[1], c) : unsure("remind you of what?");
}

/**
 * A time said first, the way people jot one down: "6pm call Harlow Legal", "at 6:30 pick up juno".
 * Only a time that cannot be a count (am/pm, a colon, noon) leads: "3 apples" stays a note.
 * @param {string} t @param {Ctx} c @returns {Result | undefined}
 */
function timeFirstRules(t, c) {
  if (!new RegExp(`^(?:at\\s+)?(?:${AMPM}|\\d{1,2}:\\d{2}|noon)\\s+\\S`, "i").test(t)) return undefined;
  const r = reminder(/^at\s/i.test(t) ? t : `at ${t}`, c);
  return "ambiguous" in r || r.at === undefined ? undefined : r;
}

// ---- Todos -------------------------------------------------------------------------------

const PRIORITY = /** @type {Record<string, number>} */ ({ "!": 1, "!!": 2, "!!!": 3, "!low": 1, "!med": 2, "!medium": 2,
  "!high": 3, "!urgent": 3, "!0": 0, "!1": 1, "!2": 2, "!3": 3 });

/**
 * A todo's title, with a priority mark ("!high", "!!") and a due day ("by friday", "due
 * tomorrow") taken out. A due day is a date, not a moment.
 * @param {string} words @param {Ctx} c @param {Record<string, string>} extra @returns {Result}
 */
function todo(words, c, extra) {
  let rest = ` ${words.replace(/\s+/g, " ")} `;
  /** @type {number | undefined} */
  let priority;
  rest = rest.replace(/\s(!{1,3}|![a-z0-9]+)(?=\s)/gi, (all, mark) => {
    const p = PRIORITY[mark.toLowerCase()];
    if (p === undefined || priority !== undefined) return all;
    priority = p;
    return " ";
  });
  /** @type {string | undefined} */
  let due;
  const dm = new RegExp(`\\s(?:by|due|due\\s+on|due\\s+by)\\s+((?:next\\s+)?${WEEKDAY}|today|tonight|tomorrow|\\d{4}-\\d{2}-\\d{2})(?=\\s)`, "i").exec(rest);
  if (dm) {
    const word = dm[1].toLowerCase().replace(/\s+/g, " ");
    if (/^\d{4}-\d{2}-\d{2}$/.test(word)) {
      const [y, mo, d] = word.split("-").map(Number);
      const t = new Date(Date.UTC(y, mo - 1, d));
      if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return unsure(`"${word}" is not a date`);
      due = word;
    } else {
      const n = word === "today" || word === "tonight" ? 0 : word === "tomorrow" ? 1 : ahead(c.w, word.replace(/^next /, ""), word.startsWith("next "));
      due = ymd(dayAfter(c.w, n));
    }
    rest = rest.slice(0, dm.index) + " " + rest.slice(dm.index + dm[0].length);
  }
  const title = tidy(rest);
  if (!title) return unsure("a todo saying what?");
  /** @type {Parsed} */
  const out = { kind: "todo", title, ...extra };
  if (due) Object.assign(out, { due, tz: c.tz });
  if (priority !== undefined) out.priority = priority;
  return out;
}

/** @param {string} raw @param {Ctx} c @returns {Result | undefined} */
function todoRules(raw, c) {
  let m = /^(?:add\s+(?:a\s+)?)?(?:todo|to-do|to\s+do|task)(?:\s*:\s*|\s+-\s+|\s+|$)([\s\S]*)$/i.exec(raw);
  if (m) return todo(m[1], c, {});
  // "add milk to shopping list", "add milk to my shopping list", "put eggs on the list".
  m = /^(?:add|put)\s+([\s\S]+?)\s+(?:to|on(?:to)?)\s+(?:my\s+|the\s+|our\s+)?(?:([\w' -]{1,40}?)\s+)?list$/i.exec(tidy(raw));
  if (m) {
    const name = (m[2] || "").trim().toLowerCase();
    return todo(m[1], c, name && !/^(?:todo|to-do|to do|task)$/.test(name) ? { list: name } : {});
  }
  return undefined;
}

// ---- The parser --------------------------------------------------------------------------

/**
 * Words read as one kind, as the router reads words inside an @App scope: that kind's own
 * phrases first, then the bare words as that kind.
 * @param {Kind} kind @param {string} raw @param {string} t @param {Ctx} c @returns {Result}
 */
function asKind(kind, raw, t, c) {
  if (kind === "note") {
    const n = noteRules(raw);
    return n && !("ambiguous" in n) ? n : { kind: "note", title: raw };
  }
  if (kind === "todo") return todoRules(raw, c) ?? todo(raw, c, {});
  if (kind === "reminder") return reminderRules(t, c) ?? reminder(t, c);
  if (kind === "timer") {
    const r = timerRules(t, c);
    if (r) return r;
    const s = parseDuration(t);
    return s ? timer(s, c, "") : unsure("a timer needs a length, like 10 min");
  }
  const r = alarmRules(t, c);
  if (r) return r;
  return parseClock(t) || /\d/.test(t) ? alarm(t, c) : unsure("an alarm needs a time, like 7am");
}

/**
 * Words to a proposed planner item; { ambiguous, reason } when they are a planner phrase that
 * cannot be placed; null when they are not a planner phrase.
 * @param {string} text @param {{ now?: number, tz?: string, kind?: string }} [o]
 * @returns {Result | null}
 */
export function parse(text, o = {}) {
  const now = o.now ?? Date.now(), tz = o.tz || "UTC";
  if (String(text ?? "").length > MAX_TEXT) return null;
  const raw = String(text ?? "").trim();
  const t = tidy(raw);
  const kind = /** @type {Kind | undefined} */ (KINDS.find(k => k === String(o.kind ?? "").trim().toLowerCase()));
  if (!t) return kind ? unsure(`a ${kind} saying what?`) : null;
  /** @type {Ctx} */
  const c = { now, w: wall(now, tz), tz };
  if (kind) return asKind(kind, raw, t, c);
  return clockRules(t, c) ?? noteRules(raw) ?? todoRules(raw, c) ?? reminderRules(t, c) ?? timeFirstRules(t, c) ?? null;
}
