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
// Times are not read here. The rules say which app and which kind (a timer, an alarm, a
// reminder); planner.parse (ADR 0025, the one reader of time words) says when, through the tool
// (index.js: askFor, then fromPlanner). A timed route for a Mac app carries `time` until then.
// Words the rules cannot place at all ("5 min", "10 minute timer please") are asked of the planner
// too, so it alone decides what counts as a duration or a clock time.
//
// A message's words are sent exactly as typed: only who it is for is tidied. Who it is for must
// look like a name (one to three words, or a #channel or @handle); anything else is ambiguous.
//
// An @App scope (the Capsule's "@Notes buy milk") applies only that app's rules, and words that
// match none of them become the app's default action: a note, a reminder, a timer or alarm, the
// weather, or a message when the words name who it is for.

/**
 * @typedef {{ app: string, action: string, args: Record<string, any>, sends: boolean, said: string, time?: string }} Route
 * @typedef {{ ambiguous: true, reason: string, needs: { app?: any[], recipient?: any[] }, ask: string, text: string, app?: string, action?: string, to?: string, firstWordIsTo?: boolean }} NeedsPrompt
 * @typedef {{ ambiguous: true, reason: string } | NeedsPrompt} Ambiguous
 * @typedef {{ now: number, timeZone: string, app?: string, planner?: "planner" | "apple" }} RouteOptions
 */

/** Longer text than this is never a command; refusing it early also bounds every regex below. */
export const MAX_TEXT = 2000;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = `(?:${DAYS.join("|")})`;
const MESSENGERS = /** @type {Record<string, string>} */ ({ slack: "Slack", whatsapp: "WhatsApp" });

/** Words with a length of time in them ("10 min", "1h30", "half an hour"): inside @Clock, a timer. */
const LENGTH_WORDS = /\d\s*[hms](?![a-z])|\b(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b|\bhalf\s+an\s+hour\b|\ban?\s+(?:hour|minute)\b/i;

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

/**
 * A Clock timer or alarm. Its args wait for planner.parse (`time` says which kind it reads).
 * @param {"timer" | "alarm"} action @returns {Route}
 */
const clock = action => ({ app: "Clock", action, args: {}, sends: false, said: "", time: action });

/**
 * "timer ...", "alarm ...", "wake me ...". Other timer words ("10 min timer", "5 min") match no
 * rule and are the planner's to read.
 * @param {string} t @returns {Route | Ambiguous | null}
 */
function clockRules(t) {
  let m = /^(?:(?:set|start)\s+)?(?:an?\s+)?timer(?:\s*:\s*|\s+(?:for\s+)?|$)(.*)$/i.exec(t);
  if (m) return m[1] ? clock("timer") : unsure("how long a timer?");
  m = /^(?:(?:set|make)\s+)?(?:an?\s+)?alarm(?:\s*:\s*|\s+(?:for\s+|at\s+)?|$)(.*)$/i.exec(t) || /^wake\s+me(?:\s+up)?(?:\s+at)?\s+(.+)$/i.exec(t);
  if (m) return m[1] ? clock("alarm") : unsure("an alarm for what time?");
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

/** A reminder in Reminders. Its task and due time wait for planner.parse. @returns {Route} */
const reminder = () => ({ app: "Reminders", action: "create", args: {}, sends: false, said: "", time: "reminder" });

/** @param {string} t @returns {Route | Ambiguous | null} */
function reminderRules(t) {
  const m = /^remind\s+me(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  return m[1] ? reminder() : unsure("remind you of what?");
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
    // The first word may be who, or the message's first word: the tool decides once it has
    // looked for that name among the app's people (firstWordIsTo).
    return { ...needRecipient(MESSENGERS[bare[1].toLowerCase()], bare[2], bare[2].trim().split(/\s+/)[0]), firstWordIsTo: true };
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
  // A timer, alarm or reminder has no line of its own until planner.parse has read it.
  return { app: "Planner", action: "add", args: { text: raw, kind }, sends: false, said: r.said || `${kind[0].toUpperCase()}${kind.slice(1)}: ${tidy(raw)}` };
}

// ---- The planner's reading ----------------------------------------------------------------

/**
 * The kind of time words a route carries, for planner.parse's hint: a Planner add says it, a
 * Clock timer or alarm and a Reminders reminder carry it as `time`. Null for a route with none.
 * @param {Route} r @returns {string | null}
 */
export function timeKind(r) {
  if (r.app === "Planner") return typeof r.args.kind === "string" ? r.args.kind : null;
  return typeof r.time === "string" ? r.time : null;
}

/**
 * What to ask planner.parse about a route, or null when it has no time to read: a timed route's
 * words (without "in Apple Clock") and its kind, or, for words no rule could place, the words
 * alone, so the planner may read them as an item ("5 min", "alarm 6pm every weekday"). Never a
 * message, a question about one, or words inside an app's scope.
 * @param {Route | Ambiguous} r @param {string} text @param {RouteOptions} o
 * @returns {{ text: string, kind?: string } | null}
 */
export function askFor(r, text, o) {
  if ("needs" in r || ("sends" in r && r.sends)) return null;
  if ("ambiguous" in r) return o.app || appleAsked(text) ? null : { text: String(text).trim() };
  const kind = timeKind(r);
  if (!kind) return null;
  const words = r.app === "Planner" ? String(r.args.text) : (appleAsked(text) || { text }).text;
  return { text: String(words).trim(), kind };
}

/** A Mac app's route for an item the planner read from words no rule placed. @returns {Route | null} */
function macFor(/** @type {string} */ kind) {
  if (kind === "timer" || kind === "alarm") return clock(kind);
  if (kind === "reminder" || kind === "todo") return { ...reminder(), time: kind };
  if (kind === "note") return { app: "Notes", action: "create", args: {}, sends: false, said: "", time: kind };
  return null;
}

/**
 * The route, once planner.parse has answered `p` (its data, or null): the planner's no is the
 * answer, and a Mac app's timed route it could not read is refused rather than guessed at.
 * @param {Route | Ambiguous} r @param {string} text @param {any} p @param {RouteOptions} o
 * @returns {Route | Ambiguous}
 */
export function fromPlanner(r, text, p, o) {
  const item = p && typeof p === "object" && !p.ambiguous && typeof p.kind === "string" ? p : null;
  if ("ambiguous" in r) {
    if (!item) return r;
    const base = o.planner === "apple" ? macFor(item.kind) : { app: "Planner", action: "add", args: { text: String(text).trim(), kind: item.kind }, sends: false, said: "" };
    return base ? withParsed(base, item, o) : r;
  }
  if (p && p.ambiguous) return unsure(String(p.reason || "the planner could not place that time"));
  if (item) return withParsed(r, item, o);
  // A Planner add is read again by planner.add; a Mac app has nothing to set without a time.
  return r.app === "Planner" ? r : unsure(`Vyre could not read a time in "${String(text).trim().slice(0, 60)}"`);
}

/**
 * The same route, with the time read by planner.parse (ADR 0025, the one reader of time words):
 * the Planner's line, or the Mac app's args and line. `p` is planner.parse's item. A Mac app's
 * route that the item does not fit is refused.
 * @param {Route} r @param {any} p @param {RouteOptions} o @returns {Route | Ambiguous}
 */
export function withParsed(r, p, o) {
  const at = typeof p.at === "number" ? nowIso(wall(p.at, o.timeZone)) : null;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const ms = typeof p.duration_ms === "number" ? p.duration_ms : typeof p.duration === "number" ? p.duration : null;
  const { time: _, ...plain } = r;
  const no = () => (r.app === "Planner" ? plain : unsure(`Vyre could not read a ${r.time || "time"} in those words`));
  /** @type {string} */
  let said;
  if (p.kind === "timer" && ms) said = `Timer for ${DURATION_WORDS(Math.max(1, Math.round(ms / 1000)))}`;
  else if (p.kind === "alarm" && at) said = `Alarm ${p.repeat ? `every ${p.repeat.every} at ${Number(at.slice(11, 13))}:${at.slice(14, 16)}` : whenWords(at, o)}${title && title !== "Alarm" ? `: ${title}` : ""}`;
  else if (p.kind === "reminder") said = `Reminder: ${title}${at ? `, ${whenWords(at, o)}` : ""}`;
  else if (p.kind === "todo") said = `Todo: ${title}`;
  else if (p.kind === "note") said = `Note: ${title}`;
  else return no();
  if (r.app === "Planner") return { ...plain, said };
  if (r.app === "Clock" && r.action === "timer" && p.kind === "timer" && ms) return { ...plain, args: { seconds: Math.max(1, Math.round(ms / 1000)) }, said };
  if (r.app === "Clock" && r.action === "alarm" && p.kind === "alarm" && at) {
    // Clock's alarm is the next time on the clock: it cannot repeat, or wait for another day.
    if (p.repeat) return unsure("an Apple Clock alarm from Vyre cannot repeat; leave out Apple Clock and the planner keeps it");
    if (at.slice(0, 10) !== dayAfter(wall(o.now, o.timeZone), 0) && at.slice(0, 10) !== dayAfter(wall(o.now, o.timeZone), 1)) {
      return unsure("an Apple Clock alarm from Vyre rings at the next time on the clock; leave out Apple Clock and the planner keeps the day");
    }
    return { ...plain, args: { time: at.slice(11, 16) }, said: `Alarm at ${Number(at.slice(11, 13))}:${at.slice(14, 16)}` };
  }
  if (r.app === "Reminders" && (p.kind === "reminder" || p.kind === "todo") && title) {
    // A todo's due day is a date: Reminders gets it at 09:00, the planner's default hour.
    const due = at || (typeof p.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.due) ? `${p.due}T09:00` : null);
    return { ...plain, args: due ? { text: title, due } : { text: title }, said: p.kind === "todo" ? `Todo: ${title}` : said };
  }
  if (r.app === "Notes" && p.kind === "note" && title) return { ...plain, args: { text: title }, said };
  return no();
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
    if (app === "Reminders") return reminderRules(t) || todoRoute(raw) || reminder();
    if (app === "Weather") return weatherRules(t, o) || weather(weatherArgs(t, o, true));
    if (app === "Clock") {
      // Other words are a timer when they say a length of time, else an alarm; the planner reads which.
      return clockRules(t) || clock(LENGTH_WORDS.test(t) ? "timer" : "alarm");
    }
    return scopedMessage(raw, app);
  }
  // "in apple notes" inside a message is part of the message: messages are read first.
  const apple = appleAsked(raw);
  if (apple && !messageRules(raw, null)) return route(apple.text, { ...o, app: apple.app });
  /** @type {[string, Route | Ambiguous | null][]} */
  const tries = [["clock", clockRules(t)], ["note", noteRules(raw)], ["todo", todoRoute(raw)], ["reminder", reminderRules(t)]];
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
