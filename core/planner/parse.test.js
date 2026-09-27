// @ts-check
// The planner's words parser at fixed moments. Karachi (UTC+5, no daylight saving) for the
// phrases, New York for the days its clocks change: 2026-03-08 (02:00 skips to 03:00) and
// 2026-11-01 (02:00 goes back to 01:00). The apps router's time cases run below as fixtures, at
// its own moment (15:00 in Karachi), so the two readers stay alike.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseDuration, utcFor } from "./parse.js";

const KHI = "Asia/Karachi", NY = "America/New_York";
const NOW = Date.UTC(2026, 8, 24, 5, 0); // Thursday 2026-09-24 10:00 in Karachi
const ms = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const k = (/** @type {string} */ text, now = NOW) => parse(text, { now, tz: KHI });

const TABLE = /** @type {[string, any][]} */ ([
  ["alarm 7am", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 25, 2), wall: "07:00", date: "2026-09-25" }],
  ["alarm 11am", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 24, 6), wall: "11:00", date: "2026-09-24" }],
  ["alarm 7:30 tomorrow", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 25, 2, 30), wall: "07:30", date: "2026-09-25" }],
  ["alarm 6am weekdays", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 25, 1), wall: "06:00", repeat: { every: "weekday", days: [1, 2, 3, 4, 5] } }],
  ["alarm 7 every day", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 25, 2), wall: "07:00", repeat: { every: "day" } }],
  ["alarm 8am every sunday", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 27, 3), wall: "08:00", repeat: { every: "week", days: [0] } }],
  ["alarm 9am weekends", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 26, 4), wall: "09:00", repeat: { every: "week", days: [0, 6] } }],
  ["wake me at 6", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 25, 1), wall: "06:00", date: "2026-09-25" }],
  ["wake me up at 6:30 pm", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 24, 13, 30), wall: "18:30", date: "2026-09-24" }],
  ["set an alarm for 7am on friday for the gym", { kind: "alarm", title: "the gym", tz: KHI, at: ms(2026, 9, 25, 2), wall: "07:00", date: "2026-09-25" }],
  // A weekday that is today, with its time reached, is next week's.
  ["alarm 10am thursday", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 10, 1, 5), wall: "10:00", date: "2026-10-01" }],
  ["alarm 11 tonight", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 24, 18), wall: "23:00", date: "2026-09-24" }],
  ["alarm 1 tonight", { kind: "alarm", title: "Alarm", tz: KHI, at: ms(2026, 9, 24, 20), wall: "01:00", date: "2026-09-25" }],
  ["timer 10 min", { kind: "timer", title: "Timer", tz: KHI, duration: 600000, duration_ms: 600000, at: ms(2026, 9, 24, 5, 10) }],
  ["10 minute timer", { kind: "timer", title: "Timer", tz: KHI, duration: 600000, duration_ms: 600000, at: ms(2026, 9, 24, 5, 10) }],
  ["timer 1h30m", { kind: "timer", title: "Timer", tz: KHI, duration: 5400000, duration_ms: 5400000, at: ms(2026, 9, 24, 6, 30) }],
  ["set a timer for 25 minutes for the bread", { kind: "timer", title: "the bread", tz: KHI, duration: 1500000, duration_ms: 1500000, at: ms(2026, 9, 24, 5, 25) }],
  ["half an hour", { kind: "timer", title: "Timer", tz: KHI, duration: 1800000, duration_ms: 1800000, at: ms(2026, 9, 24, 5, 30) }],
  // A bare hour is whichever of 6:00 and 18:00 comes next.
  ["remind me to call the printer at 6", { kind: "reminder", title: "call the printer", tz: KHI, at: ms(2026, 9, 24, 13), wall: "18:00", date: "2026-09-24" }],
  ["remind me in 20 minutes to check the oven", { kind: "reminder", title: "check the oven", tz: KHI, at: ms(2026, 9, 24, 5, 20) }],
  ["remind me tomorrow at 9 to email juno", { kind: "reminder", title: "email juno", tz: KHI, at: ms(2026, 9, 25, 4), wall: "09:00", date: "2026-09-25" }],
  ["remind me tomorrow at 3 to water the plants", { kind: "reminder", title: "water the plants", tz: KHI, at: ms(2026, 9, 25, 10), wall: "15:00", date: "2026-09-25" }],
  ["remind me on friday to pay Northwind Bakery", { kind: "reminder", title: "pay Northwind Bakery", tz: KHI, at: ms(2026, 9, 25, 4), wall: "09:00", date: "2026-09-25" }],
  ["remind me on thursday to pay rent", { kind: "reminder", title: "pay rent", tz: KHI, at: ms(2026, 10, 1, 4), wall: "09:00", date: "2026-10-01" }],
  ["remind me to take my 3pm pill at 2:45pm", { kind: "reminder", title: "take my 3pm pill", tz: KHI, at: ms(2026, 9, 24, 9, 45), wall: "14:45", date: "2026-09-24" }],
  ["remind me every weekday at 8am to check in with alex", { kind: "reminder", title: "check in with alex", tz: KHI, at: ms(2026, 9, 25, 3), wall: "08:00", repeat: { every: "weekday", days: [1, 2, 3, 4, 5] } }],
  ["remind me to buy flour", { kind: "reminder", title: "buy flour" }],
  ["todo buy flour", { kind: "todo", title: "buy flour" }],
  ["todo call kit by friday !high", { kind: "todo", title: "call kit", tz: KHI, due: "2026-09-25", priority: 3 }],
  ["todo: send Harlow Legal the draft !!", { kind: "todo", title: "send Harlow Legal the draft", priority: 2 }],
  ["todo file the lease due next monday", { kind: "todo", title: "file the lease", tz: KHI, due: "2026-09-28" }],
  ["todo renew the domain by 2026-10-15 !low", { kind: "todo", title: "renew the domain", tz: KHI, due: "2026-10-15", priority: 1 }],
  ["add milk to shopping list", { kind: "todo", title: "milk", list: "shopping" }],
  ["add flour and eggs to my Northwind Bakery list", { kind: "todo", title: "flour and eggs", list: "northwind bakery" }],
  ["add call juno to my list", { kind: "todo", title: "call juno" }],
  ["note the printer code is in the drawer", { kind: "note", title: "the printer code is in the drawer" }],
  ["take a note - Harlow Legal wants the lease by Friday", { kind: "note", title: "Harlow Legal wants the lease by Friday" }],
  ["add to notes: kit prefers mornings", { kind: "note", title: "kit prefers mornings" }],
]);

test("parse: phrases at a fixed moment in Karachi", () => {
  for (const [text, want] of TABLE) assert.deepEqual(k(text), want, text);
});

test("parse: a bare hour before it comes is this morning's", () => {
  const early = Date.UTC(2026, 8, 23, 23, 0); // Thursday 04:00 in Karachi
  assert.deepEqual(k("remind me to call the printer at 6", early),
    { kind: "reminder", title: "call the printer", tz: KHI, at: ms(2026, 9, 24, 1), wall: "06:00", date: "2026-09-24" });
});

// These used to share null with "not a planner phrase". Under the new contract a planner phrase
// that cannot be placed is ambiguous with a reason, so the surface can say why; only words that
// are no planner phrase at all stay null.
test("parse: not a planner phrase is null", () => {
  for (const text of ["", "   ", "hello there", "whatsapp juno: running late", "what's the weather", "note-taking tips",
    "notebook prices", "x".repeat(3000), "10 minutes of fun", "open the pod bay doors", "what time is it in Tokyo"]) {
    assert.equal(k(text), null, JSON.stringify(text.slice(0, 40)));
  }
});

test("parse: a planner phrase that cannot be placed is ambiguous, with a reason", () => {
  for (const text of ["timer", "timer for the bread", "alarm", "alarm banana", "alarm 25:00", "remind me", "remind me at 6",
    "remind me today at 6am to stretch", "note", "note:", "make a note of this", "todo", "todo !high", "alarm 7am today",
    "todo renew the domain by 2026-02-30", "remind me in 20 min on friday to stretch", "alarm 7am every day on friday"]) {
    const x = /** @type {any} */ (k(text));
    assert.equal(x && x.ambiguous, true, text);
    assert.equal(typeof x.reason, "string", text);
    assert.ok(x.reason.length > 0 && !x.reason.includes("\u2014"), text);
    assert.deepEqual(Object.keys(x).sort(), ["ambiguous", "reason"], text);
  }
});

test("parse: durations read as the apps router reads them", () => {
  for (const [s, n] of /** @type {[string, number|null][]} */ ([["10 min", 600], ["1h30m", 5400], ["1h30", 5400], ["90s", 90],
    ["2 hours and 5 minutes", 7500], ["an hour", 3600], ["ten minutes", 600], ["twenty-five minutes", 1500], ["10", null]])) {
    assert.equal(parseDuration(s), n, s);
  }
});

test("utcFor: a wall time in a zone, across both New York changes", () => {
  assert.equal(utcFor(2026, 9, 24, 10, 0, KHI), Date.UTC(2026, 8, 24, 5, 0));
  assert.equal(utcFor(2026, 3, 8, 1, 59, NY), Date.UTC(2026, 2, 8, 6, 59));
  // 02:30 does not exist that morning: it moves forward by the gap, to 03:30 EDT.
  assert.equal(utcFor(2026, 3, 8, 2, 30, NY), Date.UTC(2026, 2, 8, 7, 30));
  assert.equal(utcFor(2026, 3, 8, 3, 0, NY), Date.UTC(2026, 2, 8, 7, 0));
  // 01:30 happens twice in the fall: the first, still EDT.
  assert.equal(utcFor(2026, 11, 1, 0, 30, NY), Date.UTC(2026, 10, 1, 4, 30));
  assert.equal(utcFor(2026, 11, 1, 1, 30, NY), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(utcFor(2026, 11, 1, 2, 0, NY), Date.UTC(2026, 10, 1, 7, 0));
});

test("parse: New York, the night the clocks spring forward", () => {
  const now = Date.UTC(2026, 2, 8, 3, 0); // Saturday 2026-03-07 22:00 EST
  const ny = (/** @type {string} */ text) => parse(text, { now, tz: NY });
  assert.deepEqual(ny("alarm 2:30am"), { kind: "alarm", title: "Alarm", tz: NY, at: ms(2026, 3, 8, 7, 30), wall: "02:30", date: "2026-03-08" });
  assert.deepEqual(ny("alarm 7am"), { kind: "alarm", title: "Alarm", tz: NY, at: ms(2026, 3, 8, 11), wall: "07:00", date: "2026-03-08" });
  assert.deepEqual(ny("alarm 7am daily"), { kind: "alarm", title: "Alarm", tz: NY, at: ms(2026, 3, 8, 11), wall: "07:00", repeat: { every: "day" } });
  // A duration is added to the instant: 8 hours after 22:00 EST is 07:00 EDT.
  assert.deepEqual(ny("timer 8 hours"), { kind: "timer", title: "Timer", tz: NY, duration: 28800000, duration_ms: 28800000, at: ms(2026, 3, 8, 11) });
  assert.deepEqual(ny("remind me tomorrow at 9 to email juno"),
    { kind: "reminder", title: "email juno", tz: NY, at: ms(2026, 3, 8, 13), wall: "09:00", date: "2026-03-08" });
});

test("parse: a weekday alarm set before the change keeps its wall time after it", () => {
  const now = Date.UTC(2026, 2, 6, 17, 0); // Friday 2026-03-06 12:00 EST
  assert.deepEqual(parse("alarm 6am weekdays", { now, tz: NY }),
    { kind: "alarm", title: "Alarm", tz: NY, at: ms(2026, 3, 9, 10), wall: "06:00", repeat: { every: "weekday", days: [1, 2, 3, 4, 5] } });
});

test("parse: New York, the night the clocks fall back", () => {
  const now = Date.UTC(2026, 10, 1, 2, 0); // Saturday 2026-10-31 22:00 EDT
  const ny = (/** @type {string} */ text) => parse(text, { now, tz: NY });
  assert.deepEqual(ny("alarm 1:30am"), { kind: "alarm", title: "Alarm", tz: NY, at: ms(2026, 11, 1, 5, 30), wall: "01:30", date: "2026-11-01" });
  assert.deepEqual(ny("alarm 7am"), { kind: "alarm", title: "Alarm", tz: NY, at: ms(2026, 11, 1, 12), wall: "07:00", date: "2026-11-01" });
  assert.deepEqual(ny("remind me tomorrow at 9 to call alex"),
    { kind: "reminder", title: "call alex", tz: NY, at: ms(2026, 11, 1, 14), wall: "09:00", date: "2026-11-01" });
  assert.deepEqual(ny("todo pay Northwind Bakery by tomorrow"), { kind: "todo", title: "pay Northwind Bakery", tz: NY, due: "2026-11-01" });
});

// ---- The apps router's time cases (local/apps/route.test.js on work/capsule-apps) ------------
// Its moment: Thursday 2026-09-24 15:00 in Karachi. Its routes are turned into planner items: a
// Clock alarm "07:00" is the next 07:00 as an instant, a reminder's due "2026-09-24T18:00" is that
// wall time with its instant, and the router's ambiguous rows for planner words stay ambiguous.

const RNOW = Date.UTC(2026, 8, 24, 10, 0); // 15:00 in Karachi
const kt = (/** @type {number} */ d, /** @type {number} */ h, /** @type {number} */ m = 0) => Date.UTC(2026, 8, d, h - 5, m);
const rr = (/** @type {string} */ text, /** @type {any} */ o = {}) => parse(text, { now: RNOW, tz: KHI, ...o });
const T = (/** @type {number} */ s) => ({ kind: "timer", title: "Timer", at: RNOW + s * 1000, tz: KHI, duration: s * 1000, duration_ms: s * 1000 });
const A = (/** @type {string} */ hm, /** @type {number} */ d) =>
  ({ kind: "alarm", title: "Alarm", at: kt(d, Number(hm.slice(0, 2)), Number(hm.slice(3))), tz: KHI, wall: hm, date: `2026-09-${d}` });
const N = (/** @type {string} */ title) => ({ kind: "note", title });
/** A reminder at a wall time in Karachi, written as the router's due. */
const R = (/** @type {string} */ title, /** @type {string} */ due, tz = KHI, off = 5) => {
  const [y, mo, d] = due.slice(0, 10).split("-").map(Number), h = Number(due.slice(11, 13)), mi = Number(due.slice(14, 16));
  return { kind: "reminder", title, at: Date.UTC(y, mo - 1, d, h - off, mi), tz, wall: due.slice(11), date: due.slice(0, 10) };
};
const RP = (/** @type {string} */ title) => ({ kind: "reminder", title });
const RIN = (/** @type {string} */ title, /** @type {number} */ min, now = RNOW, tz = KHI) => ({ kind: "reminder", title, at: now + min * 60000, tz });
const AMB = { ambiguous: true };
const pick = (/** @type {any} */ x) => (x && x.ambiguous ? AMB : x);

const ROUTER = /** @type {[string, any][]} */ ([
  ["timer 10 min", T(600)],
  ["10 minute timer", T(600)],
  ["set a timer for 1h30m", T(5400)],
  ["timer 90s", T(90)],
  ["timer for 2 hours and 5 minutes", T(7500)],
  ["Start a timer for 25 minutes", T(1500)],
  ["alarm 7am", A("07:00", 25)],
  ["alarm at 6:45", A("06:45", 25)],
  ["wake me at 7", A("07:00", 25)],
  ["wake me up at 6:30 am", A("06:30", 25)],
  ["set an alarm for 19:30", A("19:30", 24)],
  ["alarm 7", A("07:00", 25)],
  ["alarm 7pm", A("19:00", 24)],
  ["alarm 12am", A("00:00", 25)],
  ["alarm at noon", A("12:00", 25)],
  ["note: buy milk", N("buy milk")],
  ["note buy milk", N("buy milk")],
  ["add to notes: call kit", N("call kit")],
  ["take a note - Harlow Legal wants the lease by Friday", N("Harlow Legal wants the lease by Friday")],
  ["remind me to call juno at 6", R("call juno", "2026-09-24T18:00")],
  ["remind me at 6 to call juno", R("call juno", "2026-09-24T18:00")],
  ["remind me to call juno at 4", R("call juno", "2026-09-24T16:00")],
  ["remind me to call juno at 2", R("call juno", "2026-09-25T02:00")],
  ["remind me to call juno at 3:30pm", R("call juno", "2026-09-24T15:30")],
  ["remind me tomorrow at 9 to send the Northwind Bakery invoice", R("send the Northwind Bakery invoice", "2026-09-25T09:00")],
  ["remind me tomorrow at 3 to water the plants", R("water the plants", "2026-09-25T15:00")],
  ["remind me in 20 min to stretch", RIN("stretch", 20)],
  ["remind me to stretch in 1h30m", RIN("stretch", 90)],
  ["remind me on friday to pay rent", R("pay rent", "2026-09-25T09:00")],
  ["remind me on thursday to pay rent", R("pay rent", "2026-10-01T09:00")],
  ["remind me on thursday at 5pm to pay rent", R("pay rent", "2026-09-24T17:00")],
  ["remind me monday at 10:15 to email kit", R("email kit", "2026-09-28T10:15")],
  ["remind me tonight at 8 to call alex", R("call alex", "2026-09-24T20:00")],
  ["remind me to buy flour", RP("buy flour")],
  ["timer", AMB],
  ["alarm 25:00", AMB],
  ["note:", AMB],
  ["remind me at 6", AMB],
  ["notebook prices", null],
  ["open the pod bay doors", null],
  ["", null],
  // Review round: timers and alarms said other ways, and a trailing "please".
  ["5 min", T(300)],
  ["10 min timer please", T(600)],
  ["set timer 10 minutes please", T(600)],
  ["timer 1h30", T(5400)],
  ["a 10-minute timer", T(600)],
  ["timer: 10 min", T(600)],
  ["timer ten minutes", T(600)],
  ["alarm 7.30", A("07:30", 25)],
  // Notes: what joins the words on is not part of the note; a dash needs spaces.
  ["note to self: buy milk", N("buy milk")],
  ["note that the oven is fixed", N("the oven is fixed")],
  ["make a note of the Harlow Legal address", N("the Harlow Legal address")],
  ["note-taking tips", null],
  ["make a note of this", AMB],
  // Reminders: time words from the middle of the task stay in the task.
  ["remind me to email about sunday brunch", RP("email about sunday brunch")],
  ["remind me to take my 3pm pill", RP("take my 3pm pill")],
  ["remind me to call kit please", RP("call kit")],
  ["remind me next friday to pay rent", R("pay rent", "2026-10-02T09:00")],
  ["remind me next monday to call kit", R("call kit", "2026-09-28T09:00")],
  ["remind me to call juno tomorrow", R("call juno", "2026-09-25T09:00")],
  ["remind me tomorrow 9am to call juno", R("call juno", "2026-09-25T09:00")],
  ["remind me to call juno at 6 tomorrow", R("call juno", "2026-09-25T18:00")],
  // Tonight runs past midnight: 12 is midnight, 1 to 4 the small hours after it.
  ["remind me tonight at 12 to lock up", R("lock up", "2026-09-25T00:00")],
  ["remind me tonight at 2 to check the oven", R("check the oven", "2026-09-25T02:00")],
  ["remind me tonight at 4 to check the oven", R("check the oven", "2026-09-25T04:00")],
  ["remind me tonight at 5 to check the oven", R("check the oven", "2026-09-24T17:00")],
  ["remind me tonight at 11pm to lock up", R("lock up", "2026-09-24T23:00")],
  ["alarm 12 tonight", A("00:00", 25)],
  ["alarm 4 tonight", A("04:00", 25)],
  // "today" once 09:00 has gone is a plain reminder.
  ["remind me today to call kit", RP("call kit")],
  ["x".repeat(2001), null],
]);

test("parse: the apps router's time cases, as planner items", () => {
  for (const [text, want] of ROUTER) assert.deepEqual(pick(rr(text)), want, JSON.stringify(text.slice(0, 60)));
});

test("parse: the moment decides am or pm, and the day rolls over (router cases)", () => {
  const at = (/** @type {number} */ h, /** @type {number} */ m = 0) => kt(24, h, m);
  assert.deepEqual(rr("remind me to call juno at 6", { now: at(19) }), R("call juno", "2026-09-25T06:00"));
  assert.deepEqual(rr("remind me to call juno at 6", { now: at(5) }), R("call juno", "2026-09-24T06:00"));
  assert.deepEqual(rr("remind me in 20 min to stretch", { now: at(23, 50) }), RIN("stretch", 20, at(23, 50)));
  assert.deepEqual(rr("remind me today to call kit", { now: at(8) }), R("call kit", "2026-09-24T09:00"));
  assert.deepEqual(rr("remind me today to call kit"), RP("call kit"), "09:00 today has passed: a plain reminder");
  // The current minute is now, not the past: at is now itself, whole seconds or not.
  assert.deepEqual(rr("remind me to call juno at 6", { now: at(18) }), R("call juno", "2026-09-24T18:00"));
  assert.equal(/** @type {any} */ (rr("remind me to call juno at 6", { now: at(18) + 30000 })).at, at(18) + 30000);
  assert.equal(/** @type {any} */ (rr("remind me today at 1 to call kit", { now: at(14) })).ambiguous, true);
  // The same instant is still Wednesday evening in Pago Pago (UTC-11).
  assert.deepEqual(rr("remind me tomorrow at 9 to call kit", { tz: "Pacific/Pago_Pago" }),
    R("call kit", "2026-09-24T09:00", "Pacific/Pago_Pago", -11));
});

test("parse: across a daylight saving change, in N minutes lands on the new clock (router case)", () => {
  const before = Date.UTC(2026, 2, 8, 6, 50); // 2026-03-08 01:50 EST; 02:00 jumps to 03:00
  assert.deepEqual(parse("remind me in 20 min to stretch", { now: before, tz: NY }), RIN("stretch", 20, before, NY));
  assert.deepEqual(parse("remind me tomorrow at 9 to stretch", { now: before, tz: NY }), R("stretch", "2026-03-09T09:00", NY, -4));
});

test("parse: durations, with the router's number words and cases", () => {
  for (const [s, n] of /** @type {[string, number|null][]} */ ([["10 min", 600], ["1h30m", 5400], ["90s", 90], ["2 hours and 5 minutes", 7500],
    ["an hour", 3600], ["half an hour", 1800], ["1.5 hours", 5400], ["3 mins, 20 secs", 200], ["10", null], ["ten minutes", 600], ["10 minutes of fun", null],
    ["1h30", 5400], ["a 10-minute", 600], ["twenty-five minutes", 1500], ["sixty seconds", 60], ["x".repeat(500), null]])) {
    assert.equal(parseDuration(s), n, s);
  }
});

// ---- The kind hint (the router's @App scope) ------------------------------------------------

test("parse: a kind hint reads the words as that kind, without its keyword", () => {
  const h = (/** @type {string} */ text, /** @type {string} */ kind) => pick(rr(text, { kind }));
  assert.deepEqual(h("buy milk", "note"), N("buy milk"));
  assert.deepEqual(h("timer 10 min", "note"), N("timer 10 min"), "a note keeps timer words as its text");
  assert.deepEqual(h("note: buy milk", "note"), N("buy milk"));
  assert.deepEqual(h("call juno at 6", "reminder"), R("call juno", "2026-09-24T18:00"));
  assert.deepEqual(h("remind me to call juno at 6", "reminder"), R("call juno", "2026-09-24T18:00"));
  assert.deepEqual(h("pay rent", "reminder"), RP("pay rent"));
  assert.deepEqual(h("10 min", "timer"), T(600));
  assert.deepEqual(h("set a timer for 5 min", "timer"), T(300));
  assert.deepEqual(h("7:15", "alarm"), A("07:15", 25));
  assert.deepEqual(h("7am tomorrow", "alarm"), A("07:00", 25));
  assert.deepEqual(h("buy milk by friday !high", "todo"), { kind: "todo", title: "buy milk", tz: KHI, due: "2026-09-25", priority: 3 });
  assert.deepEqual(h("todo buy milk", "todo"), { kind: "todo", title: "buy milk" });
  assert.deepEqual(h("10 min", "TIMER"), T(600), "the hint is read without case");
  assert.deepEqual(h("buy milk", "event"), null, "an unknown hint is ignored");
  for (const [text, kind] of [["banana", "timer"], ["banana", "alarm"], ["", "note"], ["alarm 7am", "timer"], ["remind me at 6", "reminder"], ["!high", "todo"]]) {
    const x = /** @type {any} */ (rr(text, { kind }));
    assert.equal(x && x.ambiguous, true, `${kind}: ${text}`);
    assert.ok(x.reason, `${kind}: ${text}`);
  }
});

test("parse: under 10 ms a call", () => {
  const texts = [...TABLE, ...ROUTER].map(([t]) => t);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) for (const text of texts) parse(text, { now: NOW, tz: KHI });
  const each = (performance.now() - t0) / (texts.length * 5);
  assert.ok(each < 10, `${each.toFixed(3)} ms a call`);
});
