// @ts-check
// A cron schedule is parsed and stepped in ONE place, lib/cron.js (consolidation inventory item 12), so a watcher and a Flow with the same schedule fire at the same moment. This test holds both to it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextCron, describeCron } from "../lib/cron.js";
import * as watchers from "../core/watchers/cron.js";
import { nextCron as flowsNext, parseCron as flowsParse } from "../kernel/flows/compile.js";
import { findInSource } from "./source-files.js";

const ALLOWED = new Map([["lib/cron.js", "the one parser"]]);
const PATTERNS = [/\[0, 59\],\s*\[0, 23\]/, /name:\s*"day of month"/, /^\s*(?:function|const)\s+cronField\b/];

test("no other source file parses cron fields of its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "call parseCron / nextCron from lib/cron.js");
});

const AT = Date.UTC(2026, 2, 2, 10, 7, 30);   // Monday 2 March 2026 10:07:30 UTC

test("a watcher and a Flow with the same schedule fire at the same moment, in the same zone", () => {
  for (const zone of ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kuala_Lumpur"]) {
    for (const expr of ["*/15 * * * *", "0 9 * * 1-5", "30 2 * * *", "0 0 1 * *", "0 8 15 * 3", "@daily"]) {
      const w = watchers.next(watchers.parse(expr), AT, zone), f = flowsNext(expr, AT, zone);
      assert.equal(w, f, `${expr} in ${zone}`);
      assert.ok(w === null || w > AT);
    }
  }
});

test("the spring-forward gap runs once, moved on; the fall-back hour runs once, the first time", () => {
  const before = Date.UTC(2026, 2, 8, 6, 0);   // 8 March 2026, 01:00 in New York, before the 02:00 jump
  const t = nextCron("30 2 * * *", before, "America/New_York");
  assert.equal(new Date(/** @type {number} */ (t)).toISOString(), "2026-03-08T07:30:00.000Z", "02:30 does not exist; it runs at 03:30 EDT, once");
  const again = nextCron("30 2 * * *", /** @type {number} */ (t), "America/New_York");
  assert.equal(new Date(/** @type {number} */ (again)).toISOString(), "2026-03-09T06:30:00.000Z", "and not twice that night");
  const fall = nextCron("30 1 * * *", Date.UTC(2026, 10, 1, 4, 0), "America/New_York");
  assert.equal(new Date(/** @type {number} */ (fall)).toISOString(), "2026-11-01T05:30:00.000Z", "01:30 happens twice; the first one");
});

test("parse: both shapes of the answer, the day-of-week 7, shorthands and the watchers' stricter steps", () => {
  assert.equal(parseCron("0 8 * * 7").ok, true);
  assert.deepEqual([.../** @type {any} */ (parseCron("0 8 * * 7")).sets[4]], [0]);
  assert.equal(parseCron("@hourly").ok, true);
  assert.equal(parseCron("61 * * * *").ok, false);
  assert.equal(flowsParse("* * *").ok, false);
  assert.equal(parseCron("*/120 * * * *").ok, true, "Flows saved with such a step keep working");
  assert.throws(() => watchers.parse("*/120 * * * *"), /steps past the end of 0-59/, "watchers still refuse it");
  assert.throws(() => watchers.parse("61 * * * *"), /minute "61" is outside 0-59/);
  assert.equal(nextCron("0 0 30 2 *", AT), null, "a date that never comes");
});

test("the words name the zone for a clock time and not for an interval", () => {
  assert.equal(describeCron("*/15 * * * *"), "every 15 minutes");
  assert.equal(watchers.describe("*/15 * * * *", "Europe/Berlin"), "every 15 minutes");
  assert.equal(watchers.describe("0 9 * * *", "Europe/Berlin"), "every day at 09:00 (Europe/Berlin)");
  assert.equal(watchers.describe("0 9 * * 1", "Europe/Berlin"), '"0 9 * * 1" (Europe/Berlin)');
});
