// @ts-check
// route: a person's words to one app action. "timer 10 min" is Clock's timer for 600 seconds,
// "remind me to call juno at 6" is a reminder due at the next 6 o'clock, "whatsapp juno: running
// late" is a WhatsApp send to juno.
//
// Rules only, and a pure function: the moment and the time zone come in, a route or
// `{ambiguous, reason}` goes out, and nothing runs. What the rules cannot place is ambiguous, and
// the tool (index.js) may then ask a small model, through a seam this file knows nothing about.
// When in doubt the rules say ambiguous rather than guess: a wrong guess sets the wrong alarm or,
// worse, sends the wrong words to the wrong person.
//
// Times are wall-clock times in the given zone, never the zone of the machine running the code.
// A bare hour ("at 6") is whichever of 6:00 and 18:00 comes next; a time in the current minute
// counts as now. On a named later day it reads the way people mean it: 7 to 11 is the morning, 12
// is noon, 1 to 6 is the afternoon. "Tonight at 12" is midnight, and "tonight at 1" to 4 are the
// small hours after it.
//
// Daylight saving: "in 20 minutes" is added to the instant and then read on the zone's clock, so
// it lands right across a change. A named wall time is handed on as written; one that a spring
// change skips (02:30 on that morning) is left to Reminders to place.
//
// A message's words are sent exactly as typed: only who it is for is tidied. Who it is for must
// look like a name (one to three words, or a #channel or @handle); anything else is ambiguous.
//
// An @App scope (the Capsule's "@Notes buy milk") applies only that app's rules, and words that
// match none of them become the app's default action: a note, a reminder, a timer or alarm, the
// weather, or a message when the words name who it is for.

/**
 * @typedef {{ app: string, action: string, args: Record<string, any>, sends: boolean, said: string }} Route
 * @typedef {{ ambiguous: true, reason: string, needs: { app?: any[], recipient?: any[] }, ask: string, text: string, app?: string, action?: string, to?: string }} NeedsPrompt
 * @typedef {{ ambiguous: true, reason: string } | NeedsPrompt} Ambiguous
 * @typedef {{ now: number, timeZone: string, app?: string, planner?: "planner" | "apple" }} RouteOptions
 */

/** Longer text than this is never a command; refusing it early also bounds every regex below. */
export const MAX_TEXT = 2000;

const UNIT = "(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])";
const ONE = `\\d+(?:\\.\\d+)?\\s*${UNIT}`;
const DUR = `(?:half\\s+an\\s+hour|an?\\s+(?:hour|minute)|${ONE})(?:\\s*(?:,|and)?\\s*${ONE})*`;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = `(?:${DAYS.join("|")})`;
const CLOCK = "(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:[ap]\\.?m\\.?)?|noon|midnight)";
const AMPM = "\\d{1,2}(?:[:.]\\d{2})?\\s*[ap]\\.?m\\.?";
const MESSENGERS = /** @type {Record<string, string>} */ ({ slack: "Slack", whatsapp: "WhatsApp" });

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

/**
 * The wall clock at `now` in a zone.
 * @param {number} now @param {string} timeZone
 */
export function wall(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const y = Number(p.year), mo = Number(p.month), d = Number(p.day);
  return { y, mo, d, h: Number(p.hour), mi: Number(p.minute), dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/** The calendar date `n` days after a wall date, as "YYYY-MM-DD". */
function dayAfter(/** @type {{ y: number, mo: number, d: number }} */ w, /** @type {number} */ n) {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const nowIso = (/** @type {ReturnType<typeof wall>} */ w) => `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;

/**
 * How many days ahead a weekday is: 0 today, up to 6. With `next`, the one in next week (weeks
 * start on Monday): on a Thursday, "next monday" is in four days and "next friday" in eight.
 */
function ahead(/** @type {ReturnType<typeof wall>} */ w, /** @type {string} */ name, next = false) {
  const target = DAYS.indexOf(name.toLowerCase());
  if (!next) return (target - w.dow + 7) % 7;
  const toMonday = (1 - w.dow + 7) % 7 || 7;
  return toMonday + (target - 1 + 7) % 7;
}

/** @returns {Ambiguous} */
const unsure = (/** @type {string} */ reason) => ({ ambiguous: true, reason });

/** Collapse spaces, and drop the "please" and end punctuation a person adds to a request. */
const tidy = (/** @type {string} */ s) => String(s).replace(/\s+/g, " ").trim()
  .replace(/[?!.]+$/, "").replace(/[\s,]+please$/i, "").replace(/^please\s+/i, "").replace(/[?!.]+$/, "").trim();

const DURATION_WORDS = (/** @type {number} */ s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const one = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [h && one(h, "hour"), m && one(m, "minute"), x && one(x, "second")].filter(Boolean).join(" ");
};

// ---- Clock -------------------------------------------------------------------------------

/** @returns {Route} */
function timer(/** @type {number} */ seconds) {
  return { app: "Clock", action: "timer", args: { seconds }, sends: false, said: `Timer for ${DURATION_WORDS(seconds)}` };
}

/** An alarm's time: am/pm when said, a colon time as written, and a bare hour in the morning. */
function alarm(/** @type {string} */ when) {
  const c = parseClock(when);
  if (!c) return unsure(`"${when}" is not a time Vyre can set an alarm for`);
  const h = fixed(c) ?? c.h;
  const time = `${pad(h)}:${pad(c.mi)}`;
  return /** @type {Route} */ ({ app: "Clock", action: "alarm", args: { time }, sends: false, said: `Alarm at ${h}:${pad(c.mi)}` });
}

/** @param {string} t @returns {Route | Ambiguous | null} */
function clockRules(t) {
  let m = /^(?:(?:set|start)\s+)?(?:an?\s+)?timer(?:\s*:\s*|\s+(?:for\s+)?|$)(.*)$/i.exec(t);
  if (m) {
    const s = m[1] ? parseDuration(m[1]) : null;
    return s ? timer(s) : unsure("how long a timer?");
  }
  m = /^(?:(?:set|start)\s+)?(.+?)\s+timer$/i.exec(t);
  if (m && parseDuration(m[1])) return timer(/** @type {number} */ (parseDuration(m[1])));
  m = /^(?:(?:set|make)\s+)?(?:an?\s+)?alarm(?:\s*:\s*|\s+(?:for\s+|at\s+)?|$)(.*)$/i.exec(t) || /^wake\s+me(?:\s+up)?(?:\s+at)?\s+(.+)$/i.exec(t);
  if (m) return m[1] ? alarm(m[1]) : unsure("an alarm for what time?");
  const s = parseDuration(t);
  if (s) return timer(s);
  return null;
}

// ---- Notes -------------------------------------------------------------------------------

/** @returns {Route} */
const note = (/** @type {string} */ text) => ({ app: "Notes", action: "create", args: { text }, sends: false, said: `Note: ${text.split("\n")[0]}` });

/** @param {string} raw @returns {Route | Ambiguous | null} */
function noteRules(raw) {
  // A dash separates only with spaces round it, so "note-taking tips" is not a note.
  const m = /^(?:(?:add|save)\s+(?:this\s+)?to\s+(?:my\s+)?notes?|new\s+note|make\s+a\s+note|take\s+a\s+note|note(?:\s+down)?)(?:\s*:\s*|\s+-\s+|\s+|$)([\s\S]*)$/i.exec(raw.trim());
  if (!m) return null;
  const text = m[1].replace(/^(?:to\s+self\b\s*:?\s*|that\s+|of\s+)/i, "").trim();
  // "make a note of this" names nothing to write down.
  if (!text || /^(?:this|that|it)[.!]?$/i.test(text)) return unsure("a note saying what?");
  return note(text);
}

// ---- Reminders ---------------------------------------------------------------------------

/**
 * The due time a reminder's words name, and the words left over for the task. Time words are
 * taken after "at", "on" or "in" wherever they are, and bare ("tomorrow", "friday", "9am") only at
 * the start or the end, so "email about sunday brunch" and "take my 3pm pill" keep their words.
 * @param {string} words @param {RouteOptions} o
 * @returns {{ task: string, due: string | null } | Ambiguous}
 */
function reminderParts(words, o) {
  let rest = ` ${words} `;
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
  const task = tidy(rest).replace(/^(?:to|that|about)\s+/i, "").replace(/\s+(?:to|at|on|in)$/i, "").trim();
  if (!task) return unsure("remind you of what?");

  const w = wall(o.now, o.timeZone);
  if (got.dur) {
    const s = parseDuration(got.dur[1]);
    if (!s) return unsure(`"in ${got.dur[1]}" is not a length of time`);
    return { task, due: nowIso(wall(Math.ceil((o.now + s * 1000) / 60000) * 60000, o.timeZone)) };
  }
  const clock = got.time ? parseClock(got.time[1]) : null;
  if (got.time && !clock) return unsure(`"${got.time[1].trim()}" is not a time`);
  const dayWord = got.day ? got.day[1].toLowerCase().replace(/\s+/g, " ") : null;
  const next = Boolean(dayWord && dayWord.startsWith("next "));
  const weekday = dayWord ? dayWord.replace(/^next /, "") : null;
  const isWeekday = Boolean(weekday && DAYS.includes(weekday));
  const tonight = dayWord === "tonight";
  /** @type {number | null} days ahead the words fix, or null for "the next one" */
  const offset = dayWord === "today" || tonight ? 0 : dayWord === "tomorrow" ? 1 : isWeekday ? ahead(w, /** @type {string} */ (weekday), next) : null;
  if (!clock && offset === null) return { task, due: null };

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
  const now = nowIso(w);
  for (const [n, h] of tries) {
    const due = `${dayAfter(w, n)}T${pad(h)}:${pad(mi)}`;
    if (due >= now) return { task, due };
  }
  // "today" with no time, once 09:00 has gone, is a plain reminder; a named time that has gone is not.
  if (!clock && dayWord === "today") return { task, due: null };
  return unsure(offset === 0 ? "that time has already passed today" : "that time has passed");
}

/** "today at 18:00", "tomorrow at 9:00", "Friday at 9:00", or a date. */
function whenWords(/** @type {string} */ due, /** @type {RouteOptions} */ o) {
  const w = wall(o.now, o.timeZone);
  const date = due.slice(0, 10), h = Number(due.slice(11, 13)), time = `${h}:${due.slice(14, 16)}`;
  for (let n = 0; n < 7; n++) {
    if (dayAfter(w, n) === date) {
      const name = n === 0 ? "today" : n === 1 ? "tomorrow" : DAYS[(w.dow + n) % 7].replace(/^./, c => c.toUpperCase());
      return `${name} at ${time}`;
    }
  }
  return `${date} at ${time}`;
}

/** @param {string} words @param {RouteOptions} o @returns {Route | Ambiguous} */
function reminder(words, o) {
  const p = reminderParts(words, o);
  if ("ambiguous" in p) return p;
  const args = /** @type {Record<string, string>} */ ({ text: p.task });
  if (p.due) args.due = p.due;
  const when = p.due ? `, ${whenWords(p.due, o)}` : "";
  return { app: "Reminders", action: "create", args, sends: false, said: `Reminder: ${p.task}${when}` };
}

/** @param {string} t @param {RouteOptions} o @returns {Route | Ambiguous | null} */
function reminderRules(t, o) {
  const m = /^remind\s+me(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  return m[1] ? reminder(m[1], o) : unsure("remind you of what?");
}

// ---- Weather -----------------------------------------------------------------------------

const WX_WORDS = /\b(weather|forecast|rain|raining|rainy|snow|snowing|sunny|cloudy|cold|hot|warm|temperature|umbrella|windy)\b/i;

/**
 * The day and place in weather words. `bare` (the @Weather scope) takes leftover words as the
 * place: "@Weather London". The place is what follows the last " in ", " for " or " at ".
 * @param {string} words @param {RouteOptions} o @param {boolean} bare
 */
function weatherArgs(words, o, bare) {
  let rest = ` ${tidy(words)} `;
  /** @type {Record<string, string>} */
  const args = { day: "today" };
  const d = new RegExp(`\\s(?:on\\s+|for\\s+)?(today|tonight|tomorrow|(?:this\\s+|the\\s+)?weekend|${WEEKDAY})(?=\\s)`, "i").exec(rest);
  if (d) {
    const word = d[1].toLowerCase();
    rest = rest.slice(0, d.index) + " " + rest.slice(d.index + d[0].length);
    if (word === "tomorrow") args.day = "tomorrow";
    else if (/weekend$/.test(word)) args.day = "saturday";
    else if (DAYS.includes(word)) {
      const n = ahead(wall(o.now, o.timeZone), word);
      args.day = n === 0 ? "today" : dayAfter(wall(o.now, o.timeZone), n);
    }
  }
  const lower = rest.toLowerCase();
  const cut = Math.max(...[" in ", " for ", " at "].map(k => { const i = lower.lastIndexOf(k); return i < 0 ? -1 : i + k.length; }));
  const after = cut > 0 ? rest.slice(cut).trim() : "";
  if (after && /^[a-z][a-z .'-]{0,60}$/i.test(after)) args.place = after;
  else if (bare && cut < 0 && /^[a-z][a-z .'-]{0,60}$/i.test(tidy(rest))) args.place = tidy(rest);
  return args;
}

/** @param {Record<string, string>} args @returns {Route} */
function weather(args) {
  const day = args.day === "today" || args.day === "tomorrow" ? args.day : `on ${args.day}`;
  return { app: "Weather", action: "get", args, sends: false, said: `Weather ${day}${args.place ? ` in ${args.place}` : ""}` };
}

/** @param {string} t @param {RouteOptions} o @returns {Route | null} */
function weatherRules(t, o) {
  let m = /^(?:(?:what'?s|what\s+is|how'?s|how\s+is)\s+)?(?:the\s+)?(?:weather|forecast)\b(.*)$/i.exec(t);
  if (m) return weather(weatherArgs(m[1], o, false));
  // A question about the weather has "it" or "outside" for its subject, or names a place: "is it
  // cold in Lahore", "will it rain". "Is the coffee hot" is not one.
  m = /^(?:will|is|does|do|should|am|are)\s+(.*)$/i.exec(t);
  if (m && WX_WORDS.test(t) && (/^(?:it|it's|outside)\b/i.test(m[1]) || /\s(?:in|at)\s+[A-Z]/.test(t))) return weather(weatherArgs(m[1], o, false));
  return null;
}

// ---- Messages ----------------------------------------------------------------------------

/** Words that mean the "recipient" was really the start of the message. */
const NOT_A_NAME = new Set(["i", "i'm", "im", "i'll", "i've", "i'd", "we", "we're", "you", "you're", "me", "my", "he", "she",
  "they", "it", "it's", "that", "this", "at", "on", "in", "now", "tonight", "today", "tomorrow"]);

/** Who a message is for, tidied, or null when it does not look like one name, channel or handle. */
function recipient(/** @type {string} */ to) {
  const who = String(to).replace(/\s+/g, " ").trim().replace(/^the\s+/i, "");
  if (!/^[@#]?[\w.' -]{1,40}$/.test(who) || /\d:/.test(who)) return null;
  const words = who.split(" ");
  if (words.length > 3 || words.some(x => NOT_A_NAME.has(x.toLowerCase()))) return null;
  return who;
}

/**
 * A message whose recipient is unclear: not a plain "ambiguous" but a question with the words
 * kept, so a surface can ask "Who should get this?" and send them on. `to` is the name as typed,
 * for the tool to look up among the app's people; the rules never guess who that is.
 * @returns {NeedsPrompt}
 */
function needRecipient(/** @type {string} */ app, /** @type {string} */ text, /** @type {string} */ to = "") {
  return { ambiguous: true, reason: `who is the ${app} message for?`, needs: { recipient: [] }, ask: "Who should get this?",
    text: text.trim(), app, action: "send", ...(to ? { to } : {}) };
}

/** A message whose app is unclear: "tell juno I'm running late". @returns {NeedsPrompt} */
function needApp(/** @type {string} */ text, /** @type {string} */ to) {
  return { ambiguous: true, reason: "which app should this go through?", needs: { app: [] }, ask: "Which app?", text: text.trim(), action: "send", to };
}

/** The words after "tell <name>", as one first-word name and the message, for asking about either. */
const TELL = /^(?:tell|message|text|msg)\s+(\S+)\s+(?:that\s+)?([\s\S]+)$/i;

/** @returns {Route | Ambiguous} */
function message(/** @type {string} */ app, /** @type {string} */ to, /** @type {string} */ text, /** @type {string} */ raw = "") {
  const who = recipient(to);
  // The words go exactly as typed, but for a leading "that" or "saying" joining them on.
  const what = String(text).replace(/^\s*(?:that|saying)\s+/i, "").replace(/^\s*:\s*/, "").trim();
  if (!who) {
    // "tell mom I'm on slack now": read it again as "tell <name> <message>" and ask who.
    const m = TELL.exec(raw);
    return m ? needRecipient(app, m[2], m[1]) : needRecipient(app, what || raw, "");
  }
  if (!what) return unsure(`what should the ${app} message say?`);
  return { app, action: "send", args: { to: who, text: what }, sends: true, said: `${app} → ${who}: ${what}` };
}

/**
 * Message words, for any messenger, or only `only` inside its @App scope. `raw` is as typed.
 * @param {string} raw @param {string | null} only
 * @returns {Route | Ambiguous | null}
 */
function messageRules(raw, only) {
  const APP = "(slack|whatsapp)";
  const pats = [
    new RegExp(`^tell\\s+(.+?)\\s+on\\s+${APP}(?:\\s*:\\s*|\\s+)((?:that\\s+)?[\\s\\S]+)$`, "i"),
    new RegExp(`^(?:message|text|msg)\\s+(.+?)\\s+on\\s+${APP}(?:\\s*:\\s*|\\s+)([\\s\\S]+)$`, "i"),
    new RegExp(`^send\\s+(.+?)\\s+a\\s+message\\s+on\\s+${APP}(?:\\s*(?:saying|that|:)\\s*|\\s+)([\\s\\S]+)$`, "i"),
  ];
  for (const re of pats) {
    const m = re.exec(raw);
    if (!m) continue;
    const app = MESSENGERS[m[2].toLowerCase()];
    if (only && app !== only) return unsure(`those words are for ${app}, not ${only}`);
    return message(app, m[1], m[3], raw);
  }
  // "whatsapp juno: text". The name must not end in a digit, so "at 10:30" is not a colon form.
  const m = new RegExp(`^${APP}\\s+([^:\\n]*[^:\\d\\s])\\s*:\\s*([\\s\\S]+)$`, "i").exec(raw);
  if (m) {
    const app = MESSENGERS[m[1].toLowerCase()];
    if (only && app !== only) return unsure(`those words are for ${app}, not ${only}`);
    return message(app, m[2], m[3]);
  }
  // "whatsapp running late": the app is named and who is not. Everything after it is the message.
  const bare = new RegExp(`^${APP}\\s+([\\s\\S]+)$`, "i").exec(raw);
  if (bare && (!only || MESSENGERS[bare[1].toLowerCase()] === only)) {
    return needRecipient(MESSENGERS[bare[1].toLowerCase()], bare[2], bare[2].trim().split(/\s+/)[0]);
  }
  if (only) return null;
  // Words that mention a messenger but match no form are left alone rather than guessed at.
  if (new RegExp(`^(?:tell|message|text|msg|send)\\b[\\s\\S]*\\bon\\s+${APP}\\b`, "i").test(raw)) {
    return unsure("who is the message for, and what does it say? Say it as: whatsapp juno: the message");
  }
  // "tell juno I'm running late": a message, to someone, through no app yet.
  const t = TELL.exec(raw);
  if (t && recipient(t[1])) return needApp(t[2], t[1]);
  return null;
}

/**
 * A message to someone a person picked (a candidate from a question, or a name they typed), with
 * the words kept from the question: no sentence to read, so no colon or "tell" is needed.
 * @param {string} app @param {string} to @param {string} text
 * @returns {Route | Ambiguous}
 */
export function sendTo(app, to, text) {
  const a = MESSENGERS[String(app).trim().toLowerCase()];
  if (!a) return unsure(`Vyre cannot send through ${app}`);
  return message(a, to, text);
}

/** Inside a messenger's scope: "juno: text", "tell juno text", or its own full sentence. */
function scopedMessage(/** @type {string} */ raw, /** @type {string} */ app) {
  const own = messageRules(raw, app);
  if (own) return own;
  let m = /^([^:\n]{0,59}[^:\d\s])\s*:\s*([\s\S]+)$/.exec(raw);
  if (m) return message(app, m[1], m[2]);
  m = TELL.exec(raw);
  if (m) return message(app, m[1], m[2], raw);
  return needRecipient(app, raw);
}

// ---- Todos -------------------------------------------------------------------------------

/** "todo buy milk", "to do: call kit", "add buy milk to my todo list", "add call kit to my todos". */
function todoText(/** @type {string} */ raw) {
  const r = raw.trim();
  let m = /^(?:todo|to-do|to\s+do)(?:\s*:\s*|\s+-\s+|\s+)([\s\S]+)$/i.exec(r);
  if (m) return m[1].trim();
  m = /^add\s+([\s\S]+?)\s+to\s+(?:my\s+|the\s+)?(?:todo|to-do|to\s+do)s?(?:\s+list)?[.!]?$/i.exec(r);
  return m ? m[1].trim() : null;
}

// ---- Apple, and the Planner --------------------------------------------------------------

/**
 * Words that ask for the Mac's own app: "in Apple Notes", "in notes app", "on my Mac's Clock",
 * "apple reminders". Returns that app and the words without the phrase, or null.
 * @param {string} raw
 */
export function appleAsked(raw) {
  const re = /(?:\s*\b(?:in|on|to|into|with|using)\s+(?:the\s+)?(?:my\s+)?)?\b(?:(?:mac'?s?|apple)\s+(notes|clock|reminders)(?:\s+app)?|(notes|clock|reminders)\s+app)\b/i;
  const m = re.exec(raw);
  if (!m) return null;
  const app = SCOPES[(m[1] || m[2]).toLowerCase()];
  // "apple reminders: remind me ..." leaves a colon at the front; it joined the phrase on.
  const rest = (raw.slice(0, m.index) + " " + raw.slice(m.index + m[0].length)).replace(/[ \t]+/g, " ").trim().replace(/^[:,-]\s*/, "");
  return { app, text: rest };
}

/** The same request, for the box's planner: the person's own words and the kind. @returns {Route} */
function toPlanner(/** @type {Route} */ r, /** @type {string} */ kind, /** @type {string} */ raw) {
  return { app: "Planner", action: "add", args: { text: raw, kind }, sends: false, said: r.said };
}

// ---- The router --------------------------------------------------------------------------

const SCOPES = /** @type {Record<string, string>} */ ({ clock: "Clock", notes: "Notes", reminders: "Reminders", weather: "Weather",
  slack: "Slack", whatsapp: "WhatsApp", planner: "Planner" });

/**
 * Words to one route, or ambiguous with the reason (and, for a message, what to ask).
 *
 * Timers, alarms, reminders, todos and notes go to the Planner (the box's own, ADR 0025) unless
 * the words ask for the Mac's app, the scope is that app, or o.planner is "apple".
 * @param {string} text @param {RouteOptions} o
 * @returns {Route | Ambiguous}
 */
export function route(text, o) {
  if (String(text || "").length > MAX_TEXT) return unsure(`that is more than ${MAX_TEXT} characters`);
  const raw = String(text || "").trim();
  const t = tidy(raw);
  if (!t) return unsure("nothing to do");
  if (o.app !== undefined && o.app !== null && o.app !== "") {
    const app = SCOPES[String(o.app).trim().toLowerCase()];
    if (!app) return unsure(`Vyre has no words for ${o.app} yet`);
    if (app === "Planner") {
      const r = route(raw, { ...o, app: undefined, planner: "planner" });
      return "ambiguous" in r || r.app !== "Planner" ? { app: "Planner", action: "add", args: { text: raw }, sends: false, said: `Planner: ${t}` } : r;
    }
    if (app === "Notes") return noteRules(raw) || note(raw);
    if (app === "Reminders") return reminderRules(t, o) || todoRoute(raw) || reminder(t, o);
    if (app === "Weather") return weatherRules(t, o) || weather(weatherArgs(t, o, true));
    if (app === "Clock") {
      const c = clockRules(t);
      if (c) return c;
      if (parseClock(t)) return alarm(t);
      return unsure("a timer needs a length and an alarm a time");
    }
    return scopedMessage(raw, app);
  }
  const apple = appleAsked(raw);
  if (apple) return route(apple.text, { ...o, app: apple.app });
  /** @type {[string, Route | Ambiguous | null][]} */
  const tries = [["clock", clockRules(t)], ["note", noteRules(raw)], ["todo", todoRoute(raw)], ["reminder", reminderRules(t, o)]];
  const hit = tries.find(([, r]) => r);
  if (hit) {
    const r = /** @type {Route | Ambiguous} */ (hit[1]);
    if ("ambiguous" in r || o.planner === "apple") return r;
    return toPlanner(r, hit[0] === "clock" ? (r.action === "alarm" ? "alarm" : "timer") : hit[0], raw);
  }
  return messageRules(raw, null) || weatherRules(t, o) || unsure(`Vyre does not know what "${t.slice(0, 60)}" should do`);
}

/** A todo, on the Mac: a reminder with no time. @returns {Route | null} */
function todoRoute(/** @type {string} */ raw) {
  const text = todoText(raw);
  if (text === null) return null;
  return { app: "Reminders", action: "create", args: { text }, sends: false, said: `Todo: ${text}` };
}
