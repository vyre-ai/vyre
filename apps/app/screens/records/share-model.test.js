// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { busyWords, isShareable, shareLevels } from "./share-model.js";

test("a note has three levels, an event two", () => {
  assert.deepEqual(shareLevels("note").map(([k]) => k), ["private", "record", "space"]);
  assert.deepEqual(shareLevels("event").map(([k]) => k), ["private", "space"]);
});

test("only notes and events carry the control", () => {
  assert.equal(isShareable("note"), true);
  assert.equal(isShareable("record-note"), true);
  assert.equal(isShareable("event"), true);
  assert.equal(isShareable("deal"), false);
});

test("a Busy block says the time and nothing else", () => {
  assert.equal(busyWords({ starts_at: "2026-10-20T10:00:00", ends_at: "2026-10-20T11:00:00" }), "Busy, Oct 20, 10:00 to 11:00");
  assert.equal(busyWords({ starts_at: "2026-10-20T00:00:00", all_day: true }), "Busy, Oct 20, all day");
  assert.equal(busyWords({ starts_at: "nonsense" }), "Busy");
});
