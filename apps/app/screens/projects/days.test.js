// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, dayLabel } from "./days.js";

const ZONE = "America/New_York";
const NOW = Date.UTC(2026, 9, 10, 16, 0);              // Saturday 10 October 2026, noon in New York

test("a project's days read as Today, Yesterday, then the day in words, in the viewer's zone", () => {
  assert.equal(dayLabel(NOW - 3_600_000, { now: NOW, zone: ZONE }), "Today");
  assert.equal(dayLabel(Date.UTC(2026, 9, 9, 15, 0), { now: NOW, zone: ZONE }), "Yesterday");
  assert.equal(dayLabel(Date.UTC(2026, 9, 1, 15, 0), { now: NOW, zone: ZONE }), "Thursday, 1 October");
  assert.equal(dayLabel(Date.UTC(2025, 11, 24, 15, 0), { now: NOW, zone: ZONE }), "Wednesday, 24 December 2025", "another year says the year");
  assert.equal(dayLabel(0, { now: NOW, zone: ZONE }), "Earlier", "an entry with no time");
  // 01:30 UTC on the 10th is still the evening of the 9th in New York
  assert.equal(dayLabel(Date.UTC(2026, 9, 10, 1, 30), { now: NOW, zone: ZONE }), "Yesterday");
});

test("two times on one day share a key and two days do not", () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 9, 14, 0), ZONE), dayKey(Date.UTC(2026, 9, 10, 2, 0), ZONE), "both are the 9th in New York");
  assert.notEqual(dayKey(Date.UTC(2026, 9, 9, 14, 0), ZONE), dayKey(Date.UTC(2026, 9, 10, 14, 0), ZONE));
});
