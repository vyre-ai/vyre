// @ts-check
// The router, table-driven, at a fixed moment: Thursday 2026-09-24 15:00 in Asia/Karachi (UTC+5,
// no daylight saving). Every row is words in, one route (or ambiguous) out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { route, parseDuration } from "./route.js";

const TZ = "Asia/Karachi";
const NOW = Date.UTC(2026, 8, 24, 10, 0); // 15:00 in Karachi
const at = (/** @type {number} */ h, /** @type {number} */ m = 0) => Date.UTC(2026, 8, 24, h - 5, m);
// Most tests read the Mac's own apps (planner: "apple"); the Planner default is checked against the
// same table below, and on its own further down.
const r = (/** @type {string} */ text, /** @type {any} */ o = {}) => route(text, { now: NOW, timeZone: TZ, planner: "apple", ...o });
const rp = (/** @type {string} */ text, /** @type {any} */ o = {}) => route(text, { now: NOW, timeZone: TZ, ...o });
const pick = (/** @type {any} */ x) => (x.ambiguous ? { ambiguous: true } : { app: x.app, action: x.action, args: x.args, sends: x.sends });

test("route: durations", () => {
  for (const [s, n] of /** @type {[string, number|null][]} */ ([["10 min", 600], ["1h30m", 5400], ["90s", 90], ["2 hours and 5 minutes", 7500],
    ["an hour", 3600], ["half an hour", 1800], ["1.5 hours", 5400], ["3 mins, 20 secs", 200], ["10", null], ["ten minutes", 600], ["10 minutes of fun", null],
    ["1h30", 5400], ["a 10-minute", 600], ["twenty-five minutes", 1500], ["sixty seconds", 60], ["x".repeat(500), null]])) {
    assert.equal(parseDuration(s), n, s);
  }
});

const TIMER = (/** @type {number} */ seconds) => ({ app: "Clock", action: "timer", args: { seconds }, sends: false });
const ALARM = (/** @type {string} */ time) => ({ app: "Clock", action: "alarm", args: { time }, sends: false });
const NOTE = (/** @type {string} */ text) => ({ app: "Notes", action: "create", args: { text }, sends: false });
const REM = (/** @type {string} */ text, /** @type {string} */ due) => ({ app: "Reminders", action: "create", args: due ? { text, due } : { text }, sends: false });
const WX = (/** @type {any} */ args) => ({ app: "Weather", action: "get", args, sends: false });
const MSG = (/** @type {string} */ app, /** @type {string} */ to, /** @type {string} */ text) => ({ app, action: "send", args: { to, text }, sends: true });

const TABLE = /** @type {[string, any][]} */ ([
  ["timer 10 min", TIMER(600)],
  ["10 minute timer", TIMER(600)],
  ["set a timer for 1h30m", TIMER(5400)],
  ["timer 90s", TIMER(90)],
  ["timer for 2 hours and 5 minutes", TIMER(7500)],
  ["Start a timer for 25 minutes", TIMER(1500)],
  ["alarm 7am", ALARM("07:00")],
  ["alarm at 6:45", ALARM("06:45")],
  ["wake me at 7", ALARM("07:00")],
  ["wake me up at 6:30 am", ALARM("06:30")],
  ["set an alarm for 19:30", ALARM("19:30")],
  ["alarm 7", ALARM("07:00")],
  ["alarm 7pm", ALARM("19:00")],
  ["alarm 12am", ALARM("00:00")],
  ["alarm at noon", ALARM("12:00")],
  ["note: buy milk", NOTE("buy milk")],
  ["note buy milk", NOTE("buy milk")],
  ["add to notes: call kit", NOTE("call kit")],
  ["take a note - Harlow Legal wants the lease by Friday", NOTE("Harlow Legal wants the lease by Friday")],
  ["remind me to call juno at 6", REM("call juno", "2026-09-24T18:00")],
  ["remind me at 6 to call juno", REM("call juno", "2026-09-24T18:00")],
  ["remind me to call juno at 4", REM("call juno", "2026-09-24T16:00")],
  ["remind me to call juno at 2", REM("call juno", "2026-09-25T02:00")],
  ["remind me to call juno at 3:30pm", REM("call juno", "2026-09-24T15:30")],
  ["remind me tomorrow at 9 to send the Northwind Bakery invoice", REM("send the Northwind Bakery invoice", "2026-09-25T09:00")],
  ["remind me tomorrow at 3 to water the plants", REM("water the plants", "2026-09-25T15:00")],
  ["remind me in 20 min to stretch", REM("stretch", "2026-09-24T15:20")],
  ["remind me to stretch in 1h30m", REM("stretch", "2026-09-24T16:30")],
  ["remind me on friday to pay rent", REM("pay rent", "2026-09-25T09:00")],
  ["remind me on thursday to pay rent", REM("pay rent", "2026-10-01T09:00")],
  ["remind me on thursday at 5pm to pay rent", REM("pay rent", "2026-09-24T17:00")],
  ["remind me monday at 10:15 to email kit", REM("email kit", "2026-09-28T10:15")],
  ["remind me tonight at 8 to call alex", REM("call alex", "2026-09-24T20:00")],
  ["remind me to buy flour", REM("buy flour", "")],
  ["weather", WX({ day: "today" })],
  ["weather tomorrow", WX({ day: "tomorrow" })],
  ["weather in London", WX({ day: "today", place: "London" })],
  ["what's the weather in New York on saturday?", WX({ day: "2026-09-26", place: "New York" })],
  ["will it rain tomorrow", WX({ day: "tomorrow" })],
  ["is it cold in Lahore today", WX({ day: "today", place: "Lahore" })],
  ["forecast for Karachi", WX({ day: "today", place: "Karachi" })],
  ["tell the team on slack I'm late", MSG("Slack", "team", "I'm late")],
  ["whatsapp juno: running late", MSG("WhatsApp", "juno", "running late")],
  ["message juno on whatsapp running late", MSG("WhatsApp", "juno", "running late")],
  ["send kit a message on slack saying the deck is ready", MSG("Slack", "kit", "the deck is ready")],
  ["tell alex on WhatsApp that the bakery opens at 8", MSG("WhatsApp", "alex", "the bakery opens at 8")],
  ["slack #general: standup moved to 10", MSG("Slack", "#general", "standup moved to 10")],
  ["what time is it in Tokyo", { ambiguous: true }],
  ["open the pod bay doors", { ambiguous: true }],
  ["", { ambiguous: true }],
  ["timer", { ambiguous: true }],
  ["alarm 25:00", { ambiguous: true }],
  ["note:", { ambiguous: true }],
  ["notebook prices", { ambiguous: true }],
  ["remind me at 6", { ambiguous: true }],
  ["whatsapp running late", { ambiguous: true }],
  // Review round: timers and alarms said other ways.
  ["5 min", TIMER(300)],
  ["10 min timer please", TIMER(600)],
  ["set timer 10 minutes please", TIMER(600)],
  ["timer 1h30", TIMER(5400)],
  ["a 10-minute timer", TIMER(600)],
  ["timer: 10 min", TIMER(600)],
  ["timer ten minutes", TIMER(600)],
  ["alarm 7.30", ALARM("07:30")],
  // Notes: what joins the words on is not part of the note; a dash needs spaces.
  ["note to self: buy milk", NOTE("buy milk")],
  ["note that the oven is fixed", NOTE("the oven is fixed")],
  ["make a note of the Harlow Legal address", NOTE("the Harlow Legal address")],
  ["note-taking tips", { ambiguous: true }],
  ["make a note of this", { ambiguous: true }],
  // Reminders: time words from the middle of the task stay in the task.
  ["remind me to email about sunday brunch", REM("email about sunday brunch", "")],
  ["remind me to take my 3pm pill", REM("take my 3pm pill", "")],
  ["remind me to call kit please", REM("call kit", "")],
  ["remind me next friday to pay rent", REM("pay rent", "2026-10-02T09:00")],
  ["remind me next monday to call kit", REM("call kit", "2026-09-28T09:00")],
  ["remind me to call juno tomorrow", REM("call juno", "2026-09-25T09:00")],
  ["remind me tomorrow 9am to call juno", REM("call juno", "2026-09-25T09:00")],
  ["remind me to call juno at 6 tomorrow", REM("call juno", "2026-09-25T18:00")],
  ["remind me tonight at 12 to lock up", REM("lock up", "2026-09-25T00:00")],
  ["remind me tonight at 2 to check the oven", REM("check the oven", "2026-09-25T02:00")],
  ["remind me tonight at 11pm to lock up", REM("lock up", "2026-09-24T23:00")],
  ["remind me today to call kit", REM("call kit", "")],
  // Weather: only about "it", "outside" or a place.
  ["weather this weekend", WX({ day: "saturday" })],
  ["will it rain in London on friday", WX({ day: "2026-09-25", place: "London" })],
  ["is the coffee hot", { ambiguous: true }],
  // Messages: the body as typed, and a recipient that looks like one.
  ["tell mom I'm on slack now", { ambiguous: true }],
  ["text juno that I'm on whatsapp tonight", { ambiguous: true }],
  ["whatsapp juno at 10:30 we meet", { ambiguous: true }],
  ["tell juno on whatsapp that I'm on my way", MSG("WhatsApp", "juno", "I'm on my way")],
  ["Tell the team on Slack: line one", MSG("Slack", "team", "line one")],
  ["whatsapp juno: running late!", MSG("WhatsApp", "juno", "running late!")],
  ["whatsapp juno: line one\nline two?", MSG("WhatsApp", "juno", "line one\nline two?")],
  ["tell the whole Northwind Bakery team on slack hi", { ambiguous: true }],
  ["x".repeat(2001), { ambiguous: true }],
]);

for (const [text, want] of TABLE) {
  test(`route: ${JSON.stringify(text)}`, () => assert.deepEqual(pick(r(text)), want));
}

/** What the Planner default makes of a row the Mac's apps would take: the words as typed, and the kind. */
function planned(/** @type {string} */ text, /** @type {any} */ want) {
  if (want.ambiguous || !["Clock", "Notes", "Reminders"].includes(want.app)) return want;
  const kind = want.app === "Clock" ? want.action : want.app === "Notes" ? "note" : /^\s*remind/i.test(text) ? "reminder" : "todo";
  return { app: "Planner", action: "add", args: { text: text.trim(), kind }, sends: false };
}

test("route: by default every timer, alarm, reminder and note in the table goes to the Planner, with the words as typed", () => {
  for (const [text, want] of TABLE) assert.deepEqual(pick(rp(text)), planned(text, want), text);
});

const TODOS = /** @type {[string, string][]} */ ([
  ["todo buy milk", "buy milk"],
  ["to do: call kit", "call kit"],
  ["To-do - renew the Harlow Legal lease", "renew the Harlow Legal lease"],
  ["add buy milk to my todo list", "buy milk"],
  ["add call kit to my todos", "call kit"],
]);

test("route: todos go to the Planner by default and to Reminders on the Mac", () => {
  for (const [text, item] of TODOS) {
    assert.deepEqual(pick(rp(text)), { app: "Planner", action: "add", args: { text, kind: "todo" }, sends: false }, text);
    assert.deepEqual(pick(r(text)), REM(item, ""), text);
    assert.equal(r(text).said, `Todo: ${item}`);
  }
  assert.equal(rp("todo").ambiguous, true);
});

test("route: the Planner keeps our reading as its preview", () => {
  assert.equal(rp("timer 10 min").said, "Timer for 10 minutes");
  assert.equal(rp("remind me to call juno at 6").said, "Reminder: call juno, today at 18:00");
  assert.equal(rp("remind me at 6").ambiguous, true, "our reading refused it, so the Planner is not asked");
});

test("route: asking for the Mac's own app, a Mac scope, or planner apple keeps the Mac's apps", () => {
  assert.deepEqual(pick(rp("note buy milk in Apple Notes")), NOTE("buy milk"));
  assert.deepEqual(pick(rp("note: call kit in notes app")), NOTE("call kit"));
  assert.deepEqual(pick(rp("timer 10 min on my Mac's Clock")), TIMER(600));
  assert.deepEqual(pick(rp("remind me to call juno at 6 in apple reminders")), REM("call juno", "2026-09-24T18:00"));
  assert.deepEqual(pick(rp("apple reminders: remind me to pay rent")), REM("pay rent", ""));
  assert.deepEqual(pick(rp("buy milk", { app: "Notes" })), NOTE("buy milk"));
  assert.deepEqual(pick(rp("10 min", { app: "Clock" })), TIMER(600));
  assert.deepEqual(pick(rp("call juno at 6", { app: "Reminders" })), REM("call juno", "2026-09-24T18:00"));
  assert.deepEqual(pick(rp("todo buy milk", { app: "Reminders" })), REM("buy milk", ""));
  assert.deepEqual(pick(rp("add to notes: call kit")), { app: "Planner", action: "add", args: { text: "add to notes: call kit", kind: "note" }, sends: false },
    "\"add to notes\" names no Apple app");
});

test("route: an @Planner scope sends the words to the Planner, with a kind when the rules see one", () => {
  assert.deepEqual(pick(rp("timer 10 min", { app: "Planner" })), { app: "Planner", action: "add", args: { text: "timer 10 min", kind: "timer" }, sends: false });
  assert.deepEqual(pick(rp("dentist next week", { app: "planner" })), { app: "Planner", action: "add", args: { text: "dentist next week" }, sends: false });
});

test("route: a message with no app asks which app, with the words kept", () => {
  const x = /** @type {any} */ (rp("tell juno I'm running late!"));
  assert.deepEqual({ needs: x.needs, ask: x.ask, text: x.text, to: x.to, action: x.action, app: x.app },
    { needs: { app: [] }, ask: "Which app?", text: "I'm running late!", to: "juno", action: "send", app: undefined });
  assert.equal(x.ambiguous, true);
  assert.equal(/** @type {any} */ (rp("tell me a joke")).needs, undefined, "\"me\" is not someone to message");
});

test("route: a message with an unclear recipient asks who, with the app and the words kept", () => {
  const cases = /** @type {[string, any, any][]} */ ([
    ["tell mom I'm on slack now", {}, { app: "Slack", text: "I'm on slack now", to: "mom" }],
    ["text juno that I'm on whatsapp tonight", {}, { app: "WhatsApp", text: "I'm on whatsapp tonight", to: "juno" }],
    ["whatsapp running late", {}, { app: "WhatsApp", text: "running late", to: "running" }],
    ["running late", { app: "WhatsApp" }, { app: "WhatsApp", text: "running late", to: undefined }],
    ["standup moved to 10:30", { app: "Slack" }, { app: "Slack", text: "standup moved to 10:30", to: undefined }],
  ]);
  for (const [text, o, want] of cases) {
    const x = /** @type {any} */ (rp(text, o));
    assert.deepEqual(x.needs, { recipient: [] }, text);
    assert.equal(x.ask, "Who should get this?", text);
    assert.deepEqual({ app: x.app, text: x.text, to: x.to }, want, text);
  }
});

test("route: every route says one line, sends name the preview, ambiguous gives a reason", () => {
  assert.equal(r("timer 10 min").said, "Timer for 10 minutes");
  assert.equal(r("remind me to call juno at 6").said, "Reminder: call juno, today at 18:00");
  assert.equal(r("whatsapp juno: running late").said, "WhatsApp → juno: running late");
  assert.equal(r("weather in London tomorrow").said, "Weather tomorrow in London");
  const a = r("open the pod bay doors");
  assert.equal(typeof a.reason, "string");
  assert.ok(a.reason.length > 0);
});

test("route: the moment decides am or pm, and the day rolls over", () => {
  assert.equal(r("remind me to call juno at 6", { now: at(19) }).args.due, "2026-09-25T06:00");
  assert.equal(r("remind me to call juno at 6", { now: at(5) }).args.due, "2026-09-24T06:00");
  assert.equal(r("remind me in 20 min to stretch", { now: at(23, 50) }).args.due, "2026-09-25T00:10");
  assert.equal(r("remind me today to call kit", { now: at(8) }).args.due, "2026-09-24T09:00");
  assert.deepEqual(r("remind me today to call kit").args, { text: "call kit" }, "09:00 today has passed: a plain reminder");
  assert.equal(r("remind me to call juno at 6", { now: at(18) }).args.due, "2026-09-24T18:00", "the current minute is now, not the past");
  assert.equal(r("remind me today at 1 to call kit", { now: at(14) }).ambiguous, true);
  // The same instant is still Wednesday evening in Pago Pago (UTC-11).
  assert.equal(r("remind me tomorrow at 9 to call kit", { timeZone: "Pacific/Pago_Pago" }).args.due, "2026-09-24T09:00");
});

test("route: an @App scope applies only that app's rules, and bare words take its default action", () => {
  assert.deepEqual(pick(r("buy milk", { app: "Notes" })), NOTE("buy milk"));
  assert.deepEqual(pick(r("timer 10 min", { app: "notes" })), NOTE("timer 10 min"));
  assert.deepEqual(pick(r("call juno at 6", { app: "Reminders" })), REM("call juno", "2026-09-24T18:00"));
  assert.deepEqual(pick(r("pay rent", { app: "Reminders" })), REM("pay rent", ""));
  assert.deepEqual(pick(r("10 min", { app: "Clock" })), TIMER(600));
  assert.deepEqual(pick(r("7:15", { app: "Clock" })), ALARM("07:15"));
  assert.deepEqual(pick(r("tomorrow", { app: "Weather" })), WX({ day: "tomorrow" }));
  assert.deepEqual(pick(r("London", { app: "Weather" })), WX({ day: "today", place: "London" }));
  assert.deepEqual(pick(r("juno: running late", { app: "WhatsApp" })), MSG("WhatsApp", "juno", "running late"));
  assert.deepEqual(pick(r("tell juno running late", { app: "WhatsApp" })), MSG("WhatsApp", "juno", "running late"));
  assert.equal(r("running late", { app: "WhatsApp" }).ambiguous, true);
  assert.equal(r("tell the team on slack I'm late", { app: "WhatsApp" }).ambiguous, true, "another app's words escaped the scope");
  assert.equal(r("anything", { app: "Photoshop" }).ambiguous, true);
  assert.equal(r("banana", { app: "Clock" }).ambiguous, true);
  assert.equal(r("standup moved to 10:30", { app: "Slack" }).ambiguous, true);
  assert.deepEqual(pick(r("#general: standup moved to 10:30!", { app: "Slack" })), MSG("Slack", "#general", "standup moved to 10:30!"));
});

test("route: across a daylight saving change, in N minutes lands on the new clock", () => {
  // 2026-03-08 01:50 EST in New York; clocks jump from 02:00 to 03:00.
  const before = Date.UTC(2026, 2, 8, 6, 50);
  assert.equal(r("remind me in 20 min to stretch", { now: before, timeZone: "America/New_York" }).args.due, "2026-03-08T03:10");
  assert.equal(r("remind me tomorrow at 9 to stretch", { now: before, timeZone: "America/New_York" }).args.due, "2026-03-09T09:00");
});
