import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDay, parseTime, stepTime, timeWords, monthCells, shiftMonth, quickDays, keyDay, dayText } from "./datetime.js";

test("days parse only when real", () => {
  assert.equal(parseDay("2026-10-28"), "2026-10-28");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("tomorrow"), null);
});

test("typed times become HH:MM", () => {
  assert.equal(parseTime("14:15"), "14:15");
  assert.equal(parseTime("2:15pm"), "14:15");
  assert.equal(parseTime("2 PM"), "14:00");
  assert.equal(parseTime("12am"), "00:00");
  assert.equal(parseTime("1415"), "14:15");
  assert.equal(parseTime("9"), "09:00");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("13pm"), null);
  assert.equal(parseTime("10:75"), null);
  assert.equal(timeWords("14:15"), "2:15 pm");
  assert.equal(timeWords("00:05"), "12:05 am");
});

test("time steps go by 15 minutes and wrap", () => {
  assert.equal(stepTime("09:00", 1), "09:15");
  assert.equal(stepTime("09:07", 1), "09:15");
  assert.equal(stepTime("09:07", -1), "09:00");
  assert.equal(stepTime("09:00", -1), "08:45");
  assert.equal(stepTime("23:50", 1), "00:00");
  assert.equal(stepTime("00:00", -1), "23:45");
  assert.equal(stepTime("junk", 1), "09:15");
});

test("a month grid starts on Monday and has every day", () => {
  const c = monthCells(2026, 9);
  assert.equal(c.filter(Boolean).length, 31);
  assert.equal(c.findIndex(Boolean), 3);
  assert.deepEqual(shiftMonth({ y: 2026, m: 11 }, 1), { y: 2027, m: 0 });
  assert.deepEqual(shiftMonth({ y: 2026, m: 0 }, -1), { y: 2025, m: 11 });
});

test("quick days and arrow keys", () => {
  const now = new Date(2026, 9, 13, 10).getTime();
  assert.deepEqual(quickDays(now).map((q) => q.value), ["2026-10-13", "2026-10-14", "2026-10-19"]);
  assert.equal(dayText(new Date(now)), "2026-10-13");
  assert.equal(keyDay("2026-10-31", "ArrowRight"), "2026-11-01");
  assert.equal(keyDay("2026-10-13", "ArrowUp"), "2026-10-06");
  assert.equal(keyDay("2026-10-13", "a"), null);
});
