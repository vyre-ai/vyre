// @ts-check
// route: a person's words to one app action. "timer 10 min" is Clock's timer for 600 seconds,
// "remind me to call juno at 6" is a reminder due at the next 6 o'clock, "whatsapp juno: running
// late" is a WhatsApp send to juno.
//
// Rules only, and a pure function: the moment and the time zone come in, a route or
// `{ambiguous, reason}` goes out, and nothing runs. What the rules cannot place is ambiguous, and
// the tool (index.js) may then ask a small model, through a seam this file knows nothing about.
//
// Times are wall-clock times in the given zone, never the zone of the machine running the code.
// A bare hour ("at 6") is whichever of 6:00 and 18:00 comes next. On a named later day it reads
// the way people mean it: 7 to 11 is the morning, 12 is noon, 1 to 6 is the afternoon.
//
// An @App scope (the Capsule's "@Notes buy milk") applies only that app's rules, and words that
// match none of them become the app's default action: a note, a reminder, a timer or alarm, the
// weather, or a message when the words name who it is for.

/**
 * @typedef {{ app: string, action: string, args: Record<string, any>, sends: boolean, said: string }} Route
 * @typedef {{ ambiguous: true, reason: string }} Ambiguous
 * @typedef {{ now: number, timeZone: string, app?: string }} RouteOptions
 */

const UNIT = "(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])";
const ONE = `\\d+(?:\\.\\d+)?\\s*${UNIT}`;
const DUR = `(?:half\\s+an\\s+hour|an?\\s+(?:hour|minute)|${ONE})(?:\\s*(?:,|and)?\\s*${ONE})*`;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = `(?:${DAYS.join("|")})`;
const CLOCK = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?|noon|midnight)";
const MESSENGERS = /** @type {Record<string, string>} */ ({ slack: "Slack", whatsapp: "WhatsApp" });

/**
 * Seconds in "10 min", "1h30m", "2 hours and 5 minutes", "half an hour"; null unless the whole
 * text is a duration.
 * @param {string} text
 */
export function parseDuration(text) {
  const s = String(text).trim().toLowerCase();
  if (!new RegExp(`^${DUR}$`).test(s)) return null;
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
 * "7", "6:45", "7am", "3:30 p.m.", "noon" -> hour, minute, and am/pm when said.
 * @param {string} text
 * @returns {{ h: number, mi: number, mer: "am" | "pm" | null, colon: boolean } | null}
 */
export function parseClock(text) {
  const s = String(text).trim().toLowerCase();
  if (s === "noon") return { h: 12, mi: 0, mer: "pm", colon: false };
  if (s === "midnight") return { h: 0, mi: 0, mer: "am", colon: false };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?$/.exec(s);
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

/** How far ahead a weekday is: 0 today, up to 6. */
const ahead = (/** @type {ReturnType<typeof wall>} */ w, /** @type {string} */ name) => (DAYS.indexOf(name.toLowerCase()) - w.dow + 7) % 7;

/** @returns {Ambiguous} */
const unsure = (/** @type {string} */ reason) => ({ ambiguous: true, reason });

/** Collapse spaces and trim trailing punctuation a person adds to a request. */
const tidy = (/** @type {string} */ s) => String(s).replace(/\s+/g, " ").trim().replace(/[?!.]+$/, "").trim();

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
  let m = /^(?:(?:set|start)\s+)?(?:an?\s+)?timer(?:\s+(?:for\s+)?(.+))?$/i.exec(t);
  if (m) {
    const s = m[1] ? parseDuration(m[1]) : null;
    return s ? timer(s) : unsure("how long a timer?");
  }
  m = /^(?:(?:set|start)\s+)?(?:an?\s+)?(.+?)\s+timer$/i.exec(t);
  if (m && parseDuration(m[1])) return timer(/** @type {number} */ (parseDuration(m[1])));
  m = /^(?:(?:set|make)\s+)?(?:an?\s+)?alarm(?:\s+(?:for|at))?(?:\s+(.+))?$/i.exec(t) || /^wake\s+me(?:\s+up)?(?:\s+at)?\s+(.+)$/i.exec(t);
  if (m) return m[1] ? alarm(m[1]) : unsure("an alarm for what time?");
  return null;
}

// ---- Notes -------------------------------------------------------------------------------

/** @returns {Route} */
const note = (/** @type {string} */ text) => ({ app: "Notes", action: "create", args: { text }, sends: false, said: `Note: ${text.split("\n")[0]}` });

/** @param {string} raw @returns {Route | Ambiguous | null} */
function noteRules(raw) {
  const m = /^(?:(?:add|save)\s+(?:this\s+)?to\s+(?:my\s+)?notes?|new\s+note|make\s+a\s+note|take\s+a\s+note|note(?:\s+down)?)(?:\s*[:\-]\s*|\s+|$)([\s\S]*)$/i.exec(raw.trim());
  if (!m) return null;
  const text = m[1].trim();
  return text ? note(text) : unsure("a note saying what?");
}

// ---- Reminders ---------------------------------------------------------------------------

/**
 * The due time a reminder's words name, and the words left over for the task.
 * @param {string} words @param {RouteOptions} o
 * @returns {{ task: string, due: string | null, when: string } | Ambiguous}
 */
function reminderParts(words, o) {
  let rest = ` ${words} `;
  const take = (/** @type {RegExp} */ re) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    return m;
  };
  const inDur = take(new RegExp(`\\sin\\s+(${DUR})(?=[\\s,.!?])`, "i"));
  const atTime = take(new RegExp(`\\s(?:at\\s+(${CLOCK})|(\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?))(?=[\\s,.!?])`, "i"));
  const day = take(new RegExp(`\\s(?:on\\s+)?(today|tonight|tomorrow|${WEEKDAY})(?=[\\s,.!?])`, "i"));
  const task = tidy(rest).replace(/^(?:to|that|about)\s+/i, "").replace(/\s+(?:to|at|on)$/i, "").trim();
  if (!task) return unsure("remind you of what?");

  const w = wall(o.now, o.timeZone);
  if (inDur) {
    const s = parseDuration(inDur[1]);
    if (!s) return unsure(`"in ${inDur[1]}" is not a length of time`);
    const due = nowIso(wall(Math.ceil((o.now + s * 1000) / 60000) * 60000, o.timeZone));
    return { task, due, when: `in ${DURATION_WORDS(s)}` };
  }
  const clock = atTime ? parseClock(atTime[1] || atTime[2]) : null;
  if (atTime && !clock) return unsure(`"${atTime[0].trim()}" is not a time`);
  const dayWord = day ? day[1].toLowerCase() : null;
  const tonight = dayWord === "tonight";
  /** @type {number | null} days ahead the words fix, or null for "the next one" */
  let offset = dayWord === "today" || tonight ? 0 : dayWord === "tomorrow" ? 1 : dayWord ? ahead(w, dayWord) : null;
  if (!clock && offset === null) return { task, due: null, when: "" };

  // The hours the words could mean, earliest first.
  /** @type {number[]} */
  let hours;
  const mi = clock ? clock.mi : 0;
  if (!clock) hours = [tonight ? 20 : 9];
  else if (fixed(clock) !== null) hours = [/** @type {number} */ (fixed(clock))];
  else if (clock.h === 0 || clock.h > 12) hours = [clock.h];
  else if (tonight) hours = [clock.h === 12 ? 12 : clock.h + 12];
  else if (clock.h === 12) hours = [12];
  else if (offset !== null && offset > 0) hours = [clock.h >= 7 ? clock.h : clock.h + 12];
  else hours = [clock.h, clock.h + 12];

  const now = nowIso(w);
  const at = (/** @type {number} */ n, /** @type {number} */ h) => `${dayAfter(w, n)}T${pad(h)}:${pad(mi)}`;
  // A weekday that is today, with its time gone, means next week's.
  const days = offset === null ? [0, 1] : dayWord && DAYS.includes(dayWord) && offset === 0 ? [0, 7] : [offset];
  for (const n of days) {
    for (const h of hours) {
      if (at(n, h) > now) return { task, due: at(n, h), when: "" };
    }
  }
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
  const m = /^(?:please\s+)?remind\s+me(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  return m[1] ? reminder(m[1], o) : unsure("remind you of what?");
}

// ---- Weather -----------------------------------------------------------------------------

const WX_WORDS = /\b(weather|forecast|rain|raining|rainy|snow|snowing|sunny|cloudy|cold|hot|warm|temperature|umbrella|windy)\b/i;

/**
 * The day and place in weather words. `bare` (the @Weather scope) takes leftover words as the
 * place: "@Weather London".
 * @param {string} words @param {RouteOptions} o @param {boolean} bare
 */
function weatherArgs(words, o, bare) {
  let rest = ` ${tidy(words)} `;
  /** @type {Record<string, string>} */
  const args = { day: "today" };
  const d = new RegExp(`\\s(?:on\\s+|for\\s+)?(today|tonight|tomorrow|${WEEKDAY})(?=\\s)`, "i").exec(rest);
  if (d) {
    const word = d[1].toLowerCase();
    rest = rest.slice(0, d.index) + " " + rest.slice(d.index + d[0].length);
    if (word === "tomorrow") args.day = "tomorrow";
    else if (DAYS.includes(word)) {
      const n = ahead(wall(o.now, o.timeZone), word);
      args.day = n === 0 ? "today" : dayAfter(wall(o.now, o.timeZone), n);
    }
  }
  const p = /\s(?:in|for|at)\s+([a-z][a-z .'-]*?)\s*$/i.exec(rest);
  if (p) args.place = p[1].trim();
  else if (bare && tidy(rest)) args.place = tidy(rest);
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
  m = /^(?:will|is|does|do|should|am|are)\b(.*)$/i.exec(t);
  if (m && WX_WORDS.test(t)) return weather(weatherArgs(m[1], o, false));
  return null;
}

// ---- Messages ----------------------------------------------------------------------------

/** @returns {Route | Ambiguous} */
function message(/** @type {string} */ app, /** @type {string} */ to, /** @type {string} */ text) {
  const who = tidy(to).replace(/^the\s+/i, "");
  const what = String(text).trim().replace(/^(?:that|saying)\s+/i, "").replace(/^:\s*/, "").trim();
  if (!who) return unsure(`send it to whom on ${app}?`);
  if (!what) return unsure(`what should the ${app} message say?`);
  return { app, action: "send", args: { to: who, text: what }, sends: true, said: `${app} → ${who}: ${what}` };
}

/**
 * Message words, for any messenger, or only `only` inside its @App scope.
 * @param {string} t @param {string | null} only
 * @returns {Route | Ambiguous | null}
 */
function messageRules(t, only) {
  const APP = "(slack|whatsapp)";
  const pats = [
    new RegExp(`^tell\\s+(.+?)\\s+on\\s+${APP}\\s+(?:that\\s+)?(.+)$`, "i"),
    new RegExp(`^(?:message|text|msg)\\s+(.+?)\\s+on\\s+${APP}\\s*:?\\s+(.+)$`, "i"),
    new RegExp(`^send\\s+(.+?)\\s+a\\s+message\\s+on\\s+${APP}\\s*(?:saying|that|:)?\\s+(.+)$`, "i"),
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (!m) continue;
    const app = MESSENGERS[m[2].toLowerCase()];
    if (only && app !== only) return unsure(`those words are for ${app}, not ${only}`);
    return message(app, m[1], m[3]);
  }
  const m = new RegExp(`^${APP}\\s+([^:]+?)\\s*:\\s*([\\s\\S]+)$`, "i").exec(t);
  if (m) {
    const app = MESSENGERS[m[1].toLowerCase()];
    if (only && app !== only) return unsure(`those words are for ${app}, not ${only}`);
    return message(app, m[2], m[3]);
  }
  if (!only && new RegExp(`^${APP}\\b`, "i").test(t)) return unsure("who is the message for? Say it as: whatsapp juno: the message");
  return null;
}

/** Inside a messenger's scope: "juno: text", "tell juno text", or its own full sentence. */
function scopedMessage(/** @type {string} */ t, /** @type {string} */ app) {
  const own = messageRules(t, app);
  if (own) return own;
  let m = /^([^:]{1,60}?)\s*:\s*([\s\S]+)$/.exec(t);
  if (m) return message(app, m[1], m[2]);
  m = /^(?:tell|message|text|msg)\s+(\S+)\s+([\s\S]+)$/i.exec(t);
  if (m) return message(app, m[1], m[2]);
  return unsure(`who is the ${app} message for? Say it as: juno: the message`);
}

// ---- The router --------------------------------------------------------------------------

const SCOPES = /** @type {Record<string, string>} */ ({ clock: "Clock", notes: "Notes", reminders: "Reminders", weather: "Weather", slack: "Slack", whatsapp: "WhatsApp" });

/**
 * Words to one route, or ambiguous with the reason.
 * @param {string} text @param {RouteOptions} o
 * @returns {Route | Ambiguous}
 */
export function route(text, o) {
  const raw = String(text || "").trim();
  const t = tidy(raw);
  if (!t) return unsure("nothing to do");
  if (o.app !== undefined && o.app !== null && o.app !== "") {
    const app = SCOPES[String(o.app).trim().toLowerCase()];
    if (!app) return unsure(`Vyre has no words for ${o.app} yet`);
    if (app === "Notes") return noteRules(raw) || note(raw);
    if (app === "Reminders") return reminderRules(t, o) || reminder(t, o);
    if (app === "Weather") return weatherRules(t, o) || weather(weatherArgs(t, o, true));
    if (app === "Clock") {
      const c = clockRules(t);
      if (c) return c;
      const s = parseDuration(t);
      if (s) return timer(s);
      if (parseClock(t)) return alarm(t);
      return unsure("a timer needs a length and an alarm a time");
    }
    return scopedMessage(t, app);
  }
  return clockRules(t) || noteRules(raw) || reminderRules(t, o) || messageRules(t, null) || weatherRules(t, o)
    || unsure(`Vyre does not know what "${t.slice(0, 60)}" should do`);
}
