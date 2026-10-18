import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRuns } from "./real-model.js";

const runs = [
  { id: "a", state: "done", label: "Ava Lindqvist", when: "Today 9:40" },
  { id: "b", state: "failed", label: "Hana Ito", error: { message: "The email bounced" }, when: "Yesterday" },
  { id: "c", state: "waiting", label: "Marcus Okafor", when: "Today 8:12" },
  { id: "d", state: "paused", label: "Jo Park" },
];

test("the filters keep failed, or waiting and paused, and All keeps everything", () => {
  assert.deepEqual(filterRuns(runs, "all", "").map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(filterRuns(runs, "failed", "").map((r) => r.id), ["b"]);
  assert.deepEqual(filterRuns(runs, "waiting", "").map((r) => r.id), ["c", "d"]);
});

test("search reads the label, the error and the date, ignoring case, together with the filter", () => {
  assert.deepEqual(filterRuns(runs, "all", "BOUNCED").map((r) => r.id), ["b"]);
  assert.deepEqual(filterRuns(runs, "all", "today").map((r) => r.id), ["a", "c"]);
  assert.deepEqual(filterRuns(runs, "waiting", "today").map((r) => r.id), ["c"]);
  assert.deepEqual(filterRuns(runs, "failed", "ava"), []);
});
