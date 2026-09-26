// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, next, describe } from "./cron.js";

const at = s => new Date(s).getTime();
const iso = ms => { const d = new Date(/** @type {number} */ (ms)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

test("cron: steps, ranges and lists", () => {
  assert.equal(iso(next(parse("*/15 * * * *"), at("2026-03-02T10:07:30"))), "2026-03-02 10:15");
  assert.equal(iso(next(parse("*/15 * * * *"), at("2026-03-02T10:15:00"))), "2026-03-02 10:30", "strictly after, never the same minute twice");
  assert.equal(iso(next(parse("0 9-17/4 * * *"), at("2026-03-02T09:00"))), "2026-03-02 13:00");
  assert.equal(iso(next(parse("5,35 * * * *"), at("2026-03-02T10:36"))), "2026-03-02 11:05");
  assert.equal(iso(next(parse("0 0 1 1 *"), at("2026-03-02T10:00"))), "2027-01-01 00:00");
});

test("cron: day of week, Sunday as 0 or 7, and either day field matching", () => {
  // 2026-03-02 is a Monday.
  assert.equal(iso(next(parse("0 8 * * 7"), at("2026-03-02T10:00"))), "2026-03-08 08:00");
  assert.equal(iso(next(parse("0 8 * * 0"), at("2026-03-02T10:00"))), "2026-03-08 08:00");
  assert.equal(iso(next(parse("0 8 * * 1-5"), at("2026-03-06T09:00"))), "2026-03-09 08:00", "Friday after 8 goes to Monday");
  assert.equal(iso(next(parse("0 8 15 * 3"), at("2026-03-02T10:00"))), "2026-03-04 08:00", "the Wednesday comes before the 15th");
  assert.equal(iso(next(parse("@daily"), at("2026-03-02T10:00"))), "2026-03-03 00:00");
});

test("cron: a date that never comes is null, and bad fields say which", () => {
  assert.equal(next(parse("0 0 30 2 *"), at("2026-03-02T10:00")), null);
  assert.throws(() => parse("* * * *"), /five fields/);
  assert.throws(() => parse("61 * * * *"), /minute "61" is outside 0-59/);
  assert.throws(() => parse("* * * * mon"), /day of week "mon"/);
  assert.throws(() => parse("*/0 * * * *"), /step below 1/);
  assert.throws(() => parse("*/120 * * * *"), /steps past the end of 0-59; for every 120 minutes use hours, like "0 \*\/2 \* \* \*"/);
});

test("cron: schedules in words", () => {
  assert.equal(describe("*/15 * * * *"), "every 15 minutes");
  assert.equal(describe("0 * * * *"), "every hour");
  assert.equal(describe("@hourly"), "every hour");
  assert.equal(describe("30 * * * *"), "every hour at :30");
  assert.equal(describe("0 */6 * * *"), "every 6 hours");
  assert.equal(describe("0 7 * * *"), "every day at 07:00");
  assert.equal(describe("0 7 * * 1"), '"0 7 * * 1"');
  assert.equal(describe("webhook"), "whenever its webhook is called");
});
