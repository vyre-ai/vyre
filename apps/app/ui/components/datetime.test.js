import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinParts, partsOf, partsProblem } from "./datetime.js";

test("a moment splits into a day and a time of day in a zone, and joins back to the same moment", () => {
  const iso = "2026-10-28T09:30:00.000Z";
  assert.deepEqual(partsOf(iso, "Asia/Karachi"), { date: "2026-10-28", time: "14:30" });
  assert.deepEqual(partsOf(iso, "America/Los_Angeles"), { date: "2026-10-28", time: "02:30" });
  assert.equal(joinParts("2026-10-28", "14:30", "Asia/Karachi"), iso);
  assert.deepEqual(partsOf("", "UTC"), { date: "", time: "" });
  assert.deepEqual(partsOf("not a date", "UTC"), { date: "", time: "" });
});

test("a day alone, an empty time and bad parts", () => {
  assert.equal(joinParts("2026-10-28", "", "UTC", { dateOnly: true }), "2026-10-28");
  assert.equal(joinParts("2026-10-28", "", "UTC"), "2026-10-28T09:00:00.000Z", "an empty time is nine in the morning");
  assert.equal(joinParts("2026-02-30", "10:00", "UTC"), null, "not a real day");
  assert.equal(joinParts("2026-10-28", "25:00", "UTC"), null);
  assert.equal(partsProblem("2026-13-01", ""), "Use a date like 2026-10-28.");
  assert.equal(partsProblem("2026-10-28", "9am"), "Use a time like 14:30.");
  assert.equal(partsProblem("", ""), "");
});

test("a time the clocks skip moves forward, and one that happens twice takes the first", () => {
  // 2026-03-08 02:30 does not exist in New York (spring forward): 03:30 local is 07:30Z
  assert.equal(joinParts("2026-03-08", "02:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  // 2026-11-01 01:30 happens twice in New York: the first is 05:30Z
  assert.equal(joinParts("2026-11-01", "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
});
