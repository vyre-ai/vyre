// @ts-check
// The planner's words parser at fixed moments. Karachi (UTC+5, no daylight saving) for the
// phrases, New York for the days its clocks change: 2026-03-08 (02:00 skips to 03:00) and
// 2026-11-01 (02:00 goes back to 01:00).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseDuration, utcFor } from "./parse.js";

const KHI = "Asia/Karachi", NY = "America/New_York";
const NOW = Date.UTC(2026, 8, 24, 5, 0); // Thursday 2026-09-24 10:00 in Karachi
const iso = (/** @type {number[]} */ ...a) => new Date(Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0)).toISOString();
const k = (/** @type {string} */ text, now = NOW) => parse(text, { now, tz: KHI });

const TABLE = /** @type {[string, any][]} */ ([
  ["alarm 7am", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 25, 2), wall: "07:00", date: "2026-09-25" }],
  ["alarm 11am", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 24, 6), wall: "11:00", date: "2026-09-24" }],
  ["alarm 7:30 tomorrow", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 25, 2, 30), wall: "07:30", date: "2026-09-25" }],
  ["alarm 6am weekdays", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 25, 1), wall: "06:00", repeat: { every: "weekday", days: [1, 2, 3, 4, 5] } }],
  ["alarm 7 every day", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 25, 2), wall: "07:00", repeat: { every: "day" } }],
  ["alarm 8am every sunday", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 27, 3), wall: "08:00", repeat: { every: "week", days: [0] } }],
  ["alarm 9am weekends", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 26, 4), wall: "09:00", repeat: { every: "week", days: [0, 6] } }],
  ["wake me at 6", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 25, 1), wall: "06:00", date: "2026-09-25" }],
  ["wake me up at 6:30 pm", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 24, 13, 30), wall: "18:30", date: "2026-09-24" }],
  ["set an alarm for 7am on friday for the gym", { kind: "alarm", title: "the gym", at: iso(2026, 9, 25, 2), wall: "07:00", date: "2026-09-25" }],
  // A weekday that is today, with its time reached, is next week's.
  ["alarm 10am thursday", { kind: "alarm", title: "Alarm", at: iso(2026, 10, 1, 5), wall: "10:00", date: "2026-10-01" }],
  ["alarm 11 tonight", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 24, 18), wall: "23:00", date: "2026-09-24" }],
  ["alarm 1 tonight", { kind: "alarm", title: "Alarm", at: iso(2026, 9, 24, 20), wall: "01:00", date: "2026-09-25" }],
  ["timer 10 min", { kind: "timer", title: "Timer", duration_ms: 600000, at: iso(2026, 9, 24, 5, 10) }],
  ["10 minute timer", { kind: "timer", title: "Timer", duration_ms: 600000, at: iso(2026, 9, 24, 5, 10) }],
  ["timer 1h30m", { kind: "timer", title: "Timer", duration_ms: 5400000, at: iso(2026, 9, 24, 6, 30) }],
  ["set a timer for 25 minutes for the bread", { kind: "timer", title: "the bread", duration_ms: 1500000, at: iso(2026, 9, 24, 5, 25) }],
  ["half an hour", { kind: "timer", title: "Timer", duration_ms: 1800000, at: iso(2026, 9, 24, 5, 30) }],
  // A bare hour is whichever of 6:00 and 18:00 comes next.
  ["remind me to call the printer at 6", { kind: "reminder", title: "call the printer", at: iso(2026, 9, 24, 13), wall: "18:00", date: "2026-09-24" }],
  ["remind me in 20 minutes to check the oven", { kind: "reminder", title: "check the oven", at: iso(2026, 9, 24, 5, 20) }],
  ["remind me tomorrow at 9 to email juno", { kind: "reminder", title: "email juno", at: iso(2026, 9, 25, 4), wall: "09:00", date: "2026-09-25" }],
  ["remind me tomorrow at 3 to water the plants", { kind: "reminder", title: "water the plants", at: iso(2026, 9, 25, 10), wall: "15:00", date: "2026-09-25" }],
  ["remind me on friday to pay Northwind Bakery", { kind: "reminder", title: "pay Northwind Bakery", at: iso(2026, 9, 25, 4), wall: "09:00", date: "2026-09-25" }],
  ["remind me on thursday to pay rent", { kind: "reminder", title: "pay rent", at: iso(2026, 10, 1, 4), wall: "09:00", date: "2026-10-01" }],
  ["remind me to take my 3pm pill at 2:45pm", { kind: "reminder", title: "take my 3pm pill", at: iso(2026, 9, 24, 9, 45), wall: "14:45", date: "2026-09-24" }],
  ["remind me every weekday at 8am to check in with alex", { kind: "reminder", title: "check in with alex", at: iso(2026, 9, 25, 3), wall: "08:00", repeat: { every: "weekday", days: [1, 2, 3, 4, 5] } }],
  ["remind me to buy flour", { kind: "reminder", title: "buy flour" }],
  ["todo buy flour", { kind: "todo", title: "buy flour" }],
  ["todo call kit by friday !high", { kind: "todo", title: "call kit", due: "2026-09-25", priority: 3 }],
  ["todo: send Harlow Legal the draft !!", { kind: "todo", title: "send Harlow Legal the draft", priority: 2 }],
  ["todo file the lease due next monday", { kind: "todo", title: "file the lease", due: "2026-09-28" }],
  ["todo renew the domain by 2026-10-15 !low", { kind: "todo", title: "renew the domain", due: "2026-10-15", priority: 1 }],
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
    { kind: "reminder", title: "call the printer", at: iso(2026, 9, 24, 1), wall: "06:00", date: "2026-09-24" });
});

test("parse: not a planner phrase, or one that cannot be placed, is null", () => {
  for (const text of ["", "   ", "hello there", "whatsapp juno: running late", "what's the weather", "timer", "timer for the bread",
    "alarm", "alarm banana", "remind me", "remind me at 6", "remind me today at 6am to stretch", "note", "note-taking tips",
    "make a note of this", "todo", "todo !high", "alarm 7am today", "x".repeat(3000), "10 minutes of fun"]) {
    assert.equal(k(text), null, JSON.stringify(text.slice(0, 40)));
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
  assert.deepEqual(ny("alarm 2:30am"), { kind: "alarm", title: "Alarm", at: iso(2026, 3, 8, 7, 30), wall: "02:30", date: "2026-03-08" });
  assert.deepEqual(ny("alarm 7am"), { kind: "alarm", title: "Alarm", at: iso(2026, 3, 8, 11), wall: "07:00", date: "2026-03-08" });
  assert.deepEqual(ny("alarm 7am daily"), { kind: "alarm", title: "Alarm", at: iso(2026, 3, 8, 11), wall: "07:00", repeat: { every: "day" } });
  // A duration is added to the instant: 8 hours after 22:00 EST is 07:00 EDT.
  assert.deepEqual(ny("timer 8 hours"), { kind: "timer", title: "Timer", duration_ms: 28800000, at: iso(2026, 3, 8, 11) });
  assert.deepEqual(ny("remind me tomorrow at 9 to email juno"),
    { kind: "reminder", title: "email juno", at: iso(2026, 3, 8, 13), wall: "09:00", date: "2026-03-08" });
});

test("parse: a weekday alarm set before the change keeps its wall time after it", () => {
  const now = Date.UTC(2026, 2, 6, 17, 0); // Friday 2026-03-06 12:00 EST
  assert.deepEqual(parse("alarm 6am weekdays", { now, tz: NY }),
    { kind: "alarm", title: "Alarm", at: iso(2026, 3, 9, 10), wall: "06:00", repeat: { every: "weekday", days: [1, 2, 3, 4, 5] } });
});

test("parse: New York, the night the clocks fall back", () => {
  const now = Date.UTC(2026, 10, 1, 2, 0); // Saturday 2026-10-31 22:00 EDT
  const ny = (/** @type {string} */ text) => parse(text, { now, tz: NY });
  assert.deepEqual(ny("alarm 1:30am"), { kind: "alarm", title: "Alarm", at: iso(2026, 11, 1, 5, 30), wall: "01:30", date: "2026-11-01" });
  assert.deepEqual(ny("alarm 7am"), { kind: "alarm", title: "Alarm", at: iso(2026, 11, 1, 12), wall: "07:00", date: "2026-11-01" });
  assert.deepEqual(ny("remind me tomorrow at 9 to call alex"),
    { kind: "reminder", title: "call alex", at: iso(2026, 11, 1, 14), wall: "09:00", date: "2026-11-01" });
  assert.deepEqual(ny("todo pay Northwind Bakery by tomorrow"), { kind: "todo", title: "pay Northwind Bakery", due: "2026-11-01" });
});
