// @ts-check
// The router, table-driven, at a fixed moment: Thursday 2026-09-24 15:00 in Asia/Karachi (UTC+5,
// no daylight saving). Every row is words in, one route (or ambiguous) out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { route, parseDuration } from "./route.js";

const TZ = "Asia/Karachi";
const NOW = Date.UTC(2026, 8, 24, 10, 0); // 15:00 in Karachi
const at = (/** @type {number} */ h, /** @type {number} */ m = 0) => Date.UTC(2026, 8, 24, h - 5, m);
const r = (/** @type {string} */ text, /** @type {any} */ o = {}) => route(text, { now: NOW, timeZone: TZ, ...o });
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
