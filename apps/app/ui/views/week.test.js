// The calendar's week: seven days, Monday first, around any day; stepping by whole weeks; the rows dated in those days.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { weekDays, stepWeek, rowsInDays, weekTitle } from "./logic.js";

test("a week is seven days, Monday first, and any day of it gives the same week", () => {
  const w = weekDays("2026-10-14");
  assert.deepEqual(w, ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.deepEqual(weekDays("2026-10-18"), w, "Sunday closes the week");
  assert.deepEqual(weekDays("2026-10-12"), w, "Monday opens it");
});

test("a week crosses a month and a year end", () => {
  assert.deepEqual(weekDays("2026-12-31"), ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  assert.equal(weekDays("2026-03-01")[0], "2026-02-23");
});

test("stepping moves whole weeks, either way", () => {
  assert.equal(stepWeek("2026-10-14", 1), "2026-10-21");
  assert.equal(stepWeek("2026-10-14", -2), "2026-09-30");
  assert.equal(stepWeek("2026-12-30", 1), "2027-01-06");
});

test("rows are grouped by the day they fall on, in time order, and only for the days asked", () => {
  const r = (id, at) => ({ urn: id, data: { starts: at } });
  const rows = [r("c", "2026-10-14T15:00"), r("a", "2026-10-13T09:00"), r("b", "2026-10-14T10:30"), r("out", "2026-10-25T10:00"), { urn: "none", data: {} }];
  const by = rowsInDays(rows, "starts", weekDays("2026-10-14"));
  assert.deepEqual(Object.keys(by).sort(), ["2026-10-13", "2026-10-14"]);
  assert.deepEqual(by["2026-10-14"].map(x => x.urn), ["b", "c"]);
});

test("the title names the week by its first and last day", () => {
  assert.equal(weekTitle(weekDays("2026-10-14")), "12 to 18 Oct 2026");
  assert.equal(weekTitle(weekDays("2026-10-30")), "26 Oct to 1 Nov 2026");
  assert.equal(weekTitle(weekDays("2026-12-31")), "28 Dec 2026 to 3 Jan 2027");
});
