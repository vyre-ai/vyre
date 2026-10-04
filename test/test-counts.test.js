// The test-count guard (scripts/test-counts.mjs) fails when a test file ran fewer tests than it declares or than the last recorded run.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { declared, problems } from "../scripts/test-counts.mjs";

const FILE = "test/test-counts.test.js";

test("declared counts the test( and it( registrations at the start of a line", () => {
  assert.ok(declared(FILE) >= 3);
});

test("a file that ran fewer tests than it declares fails", () => {
  const d = declared(FILE);
  assert.deepEqual(problems({ [FILE]: d }, {}, { full: false }), []);
  assert.match(problems({ [FILE]: d - 1 }, {}, { full: false })[0], /declares/);
});

test("a file that ran fewer tests than the last recorded count fails, and more passes", () => {
  const d = declared(FILE);
  assert.match(problems({ [FILE]: d }, { [FILE]: d + 5 }, { full: false })[0], /last recorded/);
  assert.deepEqual(problems({ [FILE]: d + 2 }, { [FILE]: d }, { full: false }), []);
});

test("a recorded file that never ran fails a full run only", () => {
  assert.deepEqual(problems({}, { [FILE]: 3 }, { full: false }), []);
  assert.match(problems({}, { [FILE]: 3 }, { full: true })[0], /none ran/);
});
