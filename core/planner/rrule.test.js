// @ts-check
// Recurrence rules at fixed moments: daily, weekly (with days and an interval), monthly (a date, an nth weekday, the last day), yearly, COUNT, UNTIL, and a rule kept
// in a zone across New York's two 2026 clock changes.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRule, validRule, occurrences } from "./rrule.js";

const NY = "America/New_York", KHI = "Asia/Karachi";
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const days = (/** @type {number[]} */ xs, tz = "UTC") => xs.map(x => new Date(x).toLocaleDateString("en-CA", { timeZone: tz }));

test("rrule: a rule is read, and what is wrong is said", () => {
  const r = parseRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231");
  assert.equal(r.freq, "WEEKLY"); assert.equal(r.interval, 2); assert.deepEqual(r.byday.map(x => x.d), [1, 4]); assert.equal(r.until, "20261231");
  assert.deepEqual(parseRule("FREQ=MONTHLY;BYDAY=-1FR").byday, [{ n: -1, d: 5 }]);
  for (const bad of ["", "INTERVAL=2", "FREQ=HOURLY", "FREQ=DAILY;COUNT=2;UNTIL=20260101", "FREQ=WEEKLY;BYDAY=2MO", "FREQ=DAILY;BYMONTHDAY=3", "FREQ=MONTHLY;BYMONTH=2",
    "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;BYSETPOS=1", "FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=1", "FREQ=DAILY;FREQ=DAILY", "FREQ=DAILY;COUNT=x"]) assert.ok(!validRule(bad), bad);
});

test("rrule: daily with an interval, COUNT and UNTIL", () => {
  const start = Z(2026, 10, 5, 9);
  assert.deepEqual(days(occurrences({ rule: "FREQ=DAILY", start, tz: "UTC", from: start, to: start + 4 * 86_400_000 })), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  assert.deepEqual(days(occurrences({ rule: "FREQ=DAILY;INTERVAL=3;COUNT=3", start, tz: "UTC", from: start, to: Z(2027, 1, 1) })), ["2026-10-05", "2026-10-08", "2026-10-11"]);
  // a window that opens after the first occurrences still honours COUNT from the start
  assert.deepEqual(days(occurrences({ rule: "FREQ=DAILY;COUNT=5", start, tz: "UTC", from: Z(2026, 10, 8), to: Z(2027, 1, 1) })), ["2026-10-08", "2026-10-09"]);
  // UNTIL as a date runs through the end of that day in the zone; as a time it is exact
  assert.deepEqual(days(occurrences({ rule: "FREQ=DAILY;UNTIL=20261008", start, tz: "UTC", from: start, to: Z(2027, 1, 1) })).at(-1), "2026-10-08");
  assert.equal(occurrences({ rule: "FREQ=DAILY;UNTIL=20261007T080000Z", start, tz: "UTC", from: start, to: Z(2027, 1, 1) }).length, 2);
  // a window far from the start does not walk from it
  assert.equal(occurrences({ rule: "FREQ=DAILY", start, tz: "UTC", from: Z(2027, 3, 1), to: Z(2027, 3, 4) }).length, 3);
});

test("rrule: weekly on named days, every other week", () => {
  const start = Z(2026, 10, 5, 9); // a Monday
  const mon = occurrences({ rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", start, tz: "UTC", from: start, to: Z(2026, 11, 10) });
  assert.deepEqual(days(mon), ["2026-10-05", "2026-10-08", "2026-10-19", "2026-10-22", "2026-11-02", "2026-11-05"]);
  assert.deepEqual(days(occurrences({ rule: "FREQ=WEEKLY", start, tz: "UTC", from: start, to: Z(2026, 10, 27) })), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
});

test("rrule: monthly by date, by nth weekday and by the last weekday; a month without the day has none", () => {
  const start = Z(2026, 1, 31, 12);
  assert.deepEqual(days(occurrences({ rule: "FREQ=MONTHLY", start, tz: "UTC", from: start, to: Z(2026, 6, 1) })), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  const second = Z(2026, 10, 13, 12); // the second Tuesday
  assert.deepEqual(days(occurrences({ rule: "FREQ=MONTHLY;BYDAY=2TU", start: second, tz: "UTC", from: second, to: Z(2027, 1, 1) })), ["2026-10-13", "2026-11-10", "2026-12-08"]);
  assert.deepEqual(days(occurrences({ rule: "FREQ=MONTHLY;BYDAY=-1FR", start: second, tz: "UTC", from: second, to: Z(2027, 1, 1) })), ["2026-10-30", "2026-11-27", "2026-12-25"]);
  assert.deepEqual(days(occurrences({ rule: "FREQ=MONTHLY;BYMONTHDAY=-1", start: second, tz: "UTC", from: second, to: Z(2027, 1, 1) })), ["2026-10-31", "2026-11-30", "2026-12-31"]);
});

test("rrule: yearly, with a leap day", () => {
  const start = Z(2024, 2, 29, 8);
  assert.deepEqual(days(occurrences({ rule: "FREQ=YEARLY", start, tz: "UTC", from: start, to: Z(2033, 1, 1) })), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  assert.deepEqual(days(occurrences({ rule: "FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1", start: Z(2026, 3, 1, 8), tz: "UTC", from: Z(2026, 1, 1), to: Z(2027, 12, 31) })),
    ["2026-03-01", "2026-09-01", "2027-03-01", "2027-09-01"]);
});

test("rrule: a rule keeps its wall time in its zone across New York's clock changes", () => {
  // 09:00 New York every day: UTC 14:00 in EST (before 8 Mar), 13:00 in EDT.
  const start = Z(2026, 3, 6, 14);
  const o = occurrences({ rule: "FREQ=DAILY", start, tz: NY, from: start, to: Z(2026, 3, 11) });
  assert.deepEqual(o, [Z(2026, 3, 6, 14), Z(2026, 3, 7, 14), Z(2026, 3, 8, 13), Z(2026, 3, 9, 13), Z(2026, 3, 10, 13)]);
  // the autumn change (1 Nov): 09:00 EDT is 13:00 UTC, 09:00 EST is 14:00
  const fall = Z(2026, 10, 30, 13);
  assert.deepEqual(occurrences({ rule: "FREQ=DAILY", start: fall, tz: NY, from: fall, to: Z(2026, 11, 3) }), [Z(2026, 10, 30, 13), Z(2026, 10, 31, 13), Z(2026, 11, 1, 14), Z(2026, 11, 2, 14)]);
});

test("rrule: the zone decides which day an event falls on", () => {
  // 23:00 UTC on Monday is 04:00 Tuesday in Karachi: a weekly rule by weekday follows Karachi's Tuesday.
  const start = Z(2026, 10, 5, 23);
  const o = occurrences({ rule: "FREQ=WEEKLY", start, tz: KHI, from: start, to: Z(2026, 10, 20) });
  assert.deepEqual(o, [Z(2026, 10, 5, 23), Z(2026, 10, 12, 23), Z(2026, 10, 19, 23)]);
  const tue = occurrences({ rule: "FREQ=WEEKLY;BYDAY=TU", start, tz: KHI, from: start, to: Z(2026, 10, 14) });
  assert.deepEqual(tue, [Z(2026, 10, 5, 23), Z(2026, 10, 12, 23)]);
});

test("rrule: a result is capped at its limit", () => {
  const start = Z(2026, 1, 1, 0);
  assert.equal(occurrences({ rule: "FREQ=DAILY", start, tz: "UTC", from: start, to: Z(2030, 1, 1), limit: 7 }).length, 7);
});
