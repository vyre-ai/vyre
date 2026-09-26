// @ts-check
// parse: a person's words to a proposed planner item (ADR 0025, decision 13). "alarm 7am" is an
// alarm at the next 07:00, "timer 10 min" a timer of 600000 ms, "remind me to call the printer at
// 6" a reminder at whichever 6 o'clock comes next, "todo call kit by friday !high" a todo due
// Friday at priority 3. Words that are not a planner phrase, or that name a time that cannot be
// placed ("remind me today at 6am" at noon), give null: the surface then asks, it never guesses.
//
// Pure: `now` (ms) and `tz` (IANA zone) come in, nothing runs, and only Intl is used for time.
// Wall times are read in `tz`, never the zone of the machine running the code.
//
// The time words and their readings are copied from the Capsule's apps router
// (local/apps/route.js on work/capsule-apps: parseDuration, parseClock, reminderParts) so both
// parse alike. Keep the two in step when either changes.
//
// Daylight saving: a duration ("in 20 minutes", a timer) is added to the instant. A wall time is
// turned into UTC in the zone; a time a spring change skips (02:30 that morning) moves forward
// by the gap (03:30), and a time a fall change repeats is the first of the two.

/**
 * @typedef {{ every: "day" | "weekday" | "week", days?: number[] }} Repeat
 * @typedef {{
 *   kind: "alarm" | "timer" | "reminder" | "todo" | "note", title: string, at?: string, wall?: string,
 *   date?: string, repeat?: Repeat, duration_ms?: number, list?: string, priority?: number, due?: string
 * }} Parsed
 * @typedef {{ y: number, mo: number, d: number, h: number, mi: number, dow: number }} Wall
 */

/** Longer text than this is never a command; refusing it early also bounds every regex below. */
export const MAX_TEXT = 2000;

// ---- Time words (copied from the apps router) -------------------------------------------

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
 * Seconds in "10 min", "1h30m", "1h30", "a 10-minute", "ten minutes", "half an hour"; null
 * unless the whole text is a duration.
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
 * @returns {{ h: number, mi: number, mer: "am" | "pm" | null } | null}
 */
export function parseClock(text) {
  const s = String(text).trim().toLowerCase();
  if (s === "noon") return { h: 12, mi: 0, mer: "pm" };
  if (s === "midnight") return { h: 0, mi: 0, mer: "am" };
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?m\.?)?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0, mer = m[3] ? (m[3] === "a" ? "am" : "pm") : null;
  if (mi > 59 || h > 23 || (mer && (h < 1 || h > 12))) return null;
  return { h, mi, mer };
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

/** The wall clock at `ms` in a zone. */
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

/** A resolved wall time: the local date and time plus the UTC instant. */
function placed(/** @type {{ y: number, mo: number, d: number }} */ day, /** @type {number} */ h, /** @type {number} */ mi, /** @type {string} */ tz) {
  return { date: ymd(day), wall: `${pad(h)}:${pad(mi)}`, at: new Date(utcFor(day.y, day.mo, day.d, h, mi, tz)).toISOString() };
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
function nextRepeat(/** @type {Repeat} */ r, /** @type {number} */ h, /** @type {number} */ mi, /** @type {Wall} */ w, /** @type {string} */ tz) {
  const now = nowIso(w);
  for (let n = 0; n <= 7; n++) {
    const day = dayAfter(w, n);
    if (r.days && !r.days.includes(day.dow)) continue;
    const p = placed(day, h, mi, tz);
    if (`${p.date}T${p.wall}` > now) return p;
  }
  return null;
}

// ---- Timers and alarms -------------------------------------------------------------------

/** @returns {Parsed} */
function timer(/** @type {number} */ seconds, /** @type {number} */ now, /** @type {string} */ label) {
  return { kind: "timer", title: label || "Timer", duration_ms: seconds * 1000, at: new Date(now + seconds * 1000).toISOString() };
}

/**
 * An alarm's words after "alarm" or "wake me": a time, an optional day or repeat, an optional
 * label. The time reads as the router reads it: am/pm when said, a colon time as written, and a
 * bare hour in the morning. With no day, the next time the clock shows it.
 * @param {string} words @param {Wall} w @param {string} tz @returns {Parsed | null}
 */
function alarm(words, w, tz) {
  const { repeat, rest: r1 } = takeRepeat(words);
  let rest = ` ${r1} `, dayWord = null;
  const dm = new RegExp(`\\s(?:on\\s+)?((?:next\\s+)?${WEEKDAY}|today|tonight|tomorrow)(?=\\s)`, "i").exec(rest);
  if (dm) {
    dayWord = dm[1].toLowerCase().replace(/\s+/g, " ");
    rest = rest.slice(0, dm.index) + " " + rest.slice(dm.index + dm[0].length);
  }
  const m = new RegExp(`^(?:at\\s+|for\\s+)?(${CLOCK})(?:\\s+(?:for\\s+|to\\s+|called\\s+|-\\s+|:\\s*)?([\\s\\S]*))?$`, "i").exec(tidy(rest));
  const c = m ? parseClock(m[1]) : null;
  if (!m || !c || (repeat && dayWord)) return null;
  let h = fixed(c) ?? c.h;
  // Tonight runs past midnight, as in reminders: 12 is midnight, 1 to 4 the small hours after it.
  if (dayWord === "tonight" && c.mer === null && h <= 12) {
    if (h === 12 || h <= 4) dayWord = "tomorrow", h %= 12;
    else h += 12;
  }
  const title = (m[2] || "").trim() || "Alarm";
  if (repeat) {
    const p = nextRepeat(repeat, h, c.mi, w, tz);
    return p && { kind: "alarm", title, at: p.at, wall: p.wall, repeat };
  }
  const now = nowIso(w);
  let days;
  if (!dayWord) days = [0, 1];
  else if (dayWord === "today" || dayWord === "tonight") days = [0];
  else if (dayWord === "tomorrow") days = [1];
  else {
    const n = ahead(w, dayWord.replace(/^next /, ""), dayWord.startsWith("next "));
    days = n === 0 ? [0, 7] : [n];
  }
  for (const n of days) {
    const p = placed(dayAfter(w, n), h, c.mi, tz);
    if (`${p.date}T${p.wall}` > now) return { kind: "alarm", title, at: p.at, wall: p.wall, date: p.date };
  }
  return null;
}

/** @param {string} t @param {number} now @param {Wall} w @param {string} tz @returns {Parsed | null | undefined} undefined: not clock words */
function clockRules(t, now, w, tz) {
  let m = /^(?:(?:set|start)\s+)?(?:an?\s+)?timer(?:\s*:\s*|\s+(?:for\s+)?|$)(.*)$/i.exec(t);
  if (m) {
    const [, len, label] = /^(.*?)(?:\s+(?:for|called)\s+(.+))?$/i.exec(m[1]) || [];
    const s = len ? parseDuration(len) : null;
    return s ? timer(s, now, label) : null;
  }
  m = /^(?:(?:set|start)\s+)?(?:an?\s+)?(.+?)\s+timer(?:\s+(?:for|called)\s+(.+))?$/i.exec(t);
  if (m && parseDuration(m[1])) return timer(/** @type {number} */ (parseDuration(m[1])), now, m[2]);
  m = /^(?:(?:set|make)\s+)?(?:an?\s+)?alarm(?:\s*:\s*|\s+(?:for\s+|at\s+)?|$)(.*)$/i.exec(t) || /^wake\s+me(?:\s+up)?(?:\s+at)?\s+(.+)$/i.exec(t);
  if (m) return m[1] ? alarm(m[1], w, tz) : null;
  const s = parseDuration(t);
  if (s) return timer(s, now, "");
  return undefined;
}

// ---- Notes -------------------------------------------------------------------------------

/** @param {string} raw @returns {Parsed | null | undefined} */
function noteRules(raw) {
  // A dash separates only with spaces round it, so "note-taking tips" is not a note.
  const m = /^(?:(?:add|save)\s+(?:this\s+)?to\s+(?:my\s+)?notes?|new\s+note|make\s+a\s+note|take\s+a\s+note|note(?:\s+down)?)(?:\s*:\s*|\s+-\s+|\s+|$)([\s\S]*)$/i.exec(raw);
  if (!m) return undefined;
  const text = m[1].replace(/^(?:to\s+self\b\s*:?\s*|that\s+|of\s+)/i, "").trim();
  if (!text || /^(?:this|that|it)[.!]?$/i.test(text)) return null;
  return { kind: "note", title: text };
}

// ---- Reminders (reminderParts from the apps router, placed in UTC here) ------------------

/**
 * A reminder's words to its task and time. Time words are taken after "at", "on" or "in"
 * wherever they are, and bare ("tomorrow", "friday", "9am") only at the start or the end, so
 * "email about sunday brunch" and "take my 3pm pill" keep their words.
 * @param {string} words @param {number} now @param {Wall} w @param {string} tz @returns {Parsed | null}
 */
function reminder(words, now, w, tz) {
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
  if (!title) return null;

  if (got.dur) {
    if (repeat || got.time || got.day) return null;
    const s = parseDuration(got.dur[1]);
    return s ? { kind: "reminder", title, at: new Date(now + s * 1000).toISOString() } : null;
  }
  const clock = got.time ? parseClock(got.time[1]) : null;
  if (got.time && !clock) return null;
  if (repeat) {
    if (got.day) return null;
    // A repeat with no time rings at 9, as a named day with no time does.
    const h = !clock ? 9 : fixed(clock) ?? (clock.h >= 7 || clock.h === 0 ? clock.h : clock.h + 12);
    const p = nextRepeat(repeat, h, clock ? clock.mi : 0, w, tz);
    return p && { kind: "reminder", title, at: p.at, wall: p.wall, repeat };
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
    if (`${p.date}T${p.wall}` >= nowWall) return { kind: "reminder", title, ...p };
  }
  // "today" with no time, once 09:00 has gone, is a plain reminder; a named time that has gone is not.
  if (!clock && dayWord === "today") return { kind: "reminder", title };
  return null;
}

// ---- Todos -------------------------------------------------------------------------------

const PRIORITY = /** @type {Record<string, number>} */ ({ "!": 1, "!!": 2, "!!!": 3, "!low": 1, "!med": 2, "!medium": 2,
  "!high": 3, "!urgent": 3, "!0": 0, "!1": 1, "!2": 2, "!3": 3 });

/**
 * A todo's title, with a priority mark ("!high", "!!") and a due day ("by friday", "due
 * tomorrow") taken out. A due day is a date, not a moment.
 * @param {string} words @param {Wall} w @param {Record<string, string>} extra @returns {Parsed | null}
 */
function todo(words, w, extra) {
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
      if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
      due = word;
    } else {
      const n = word === "today" || word === "tonight" ? 0 : word === "tomorrow" ? 1 : ahead(w, word.replace(/^next /, ""), word.startsWith("next "));
      due = ymd(dayAfter(w, n));
    }
    rest = rest.slice(0, dm.index) + " " + rest.slice(dm.index + dm[0].length);
  }
  const title = tidy(rest);
  if (!title) return null;
  /** @type {Parsed} */
  const out = { kind: "todo", title, ...extra };
  if (due) out.due = due;
  if (priority !== undefined) out.priority = priority;
  return out;
}

/** @param {string} raw @param {Wall} w @returns {Parsed | null | undefined} */
function todoRules(raw, w) {
  let m = /^(?:add\s+(?:a\s+)?)?(?:todo|to-do|to\s+do|task)(?:\s*:\s*|\s+-\s+|\s+|$)([\s\S]*)$/i.exec(raw);
  if (m) return todo(m[1], w, {});
  // "add milk to shopping list", "add milk to my shopping list", "put eggs on the list".
  m = /^(?:add|put)\s+([\s\S]+?)\s+(?:to|on(?:to)?)\s+(?:my\s+|the\s+|our\s+)?(?:([\w' -]{1,40}?)\s+)?list$/i.exec(tidy(raw));
  if (m) {
    const name = (m[2] || "").trim().toLowerCase();
    return todo(m[1], w, name && !/^(?:todo|to-do|to do|task)$/.test(name) ? { list: name } : {});
  }
  return undefined;
}

// ---- The parser --------------------------------------------------------------------------

/**
 * Words to a proposed planner item, or null when they are not one or cannot be placed.
 * @param {string} text @param {{ now?: number, tz?: string }} [o]
 * @returns {Parsed | null}
 */
export function parse(text, o = {}) {
  const now = o.now ?? Date.now(), tz = o.tz || "UTC";
  if (String(text ?? "").length > MAX_TEXT) return null;
  const raw = String(text ?? "").trim();
  const t = tidy(raw);
  if (!t) return null;
  const w = wall(now, tz);
  for (const rule of [() => clockRules(t, now, w, tz), () => noteRules(raw), () => todoRules(raw, w)]) {
    const r = rule();
    if (r !== undefined) return r;
  }
  const m = /^remind\s+me(?:\s+(.*))?$/i.exec(t);
  if (m) return m[1] ? reminder(m[1], now, w, tz) : null;
  return null;
}
