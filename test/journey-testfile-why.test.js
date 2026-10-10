// @ts-check
// A journey step made from a real-daemon test case says WHY the case failed (scripts/journeys/lib/testfile.mjs): the block form node writes for a multi-line assertion used to read as nothing and the step
// said only "the case failed".
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { whyOf } from "../scripts/journeys/lib/testfile.mjs";

const tap = (/** @type {string} */ s) => s.split("\n");

test("a block error is read as its lines, a one-line error as its text, and the code is kept", () => {
  const block = tap(`not ok 3 - DocuSeal signs a document
  ---
  duration_ms: 12.5
  type: 'test'
  location: '/x/core/appmods/docuseal-live.test.js:90:1'
  failureType: 'testCodeFailure'
  error: |-
    timed out waiting for the approval card for documents.send-signed
    + actual - expected
    - 1
    + 0
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  ...`);
  const why = whyOf(block, 1);
  assert.match(why, /timed out waiting for the approval card for documents\.send-signed/);
  assert.match(why, /ERR_ASSERTION/);
  const line = tap(`not ok 1 - a case
  ---
  error: 'the type definitions could not be read'
  code: 'unavailable'
  ...`);
  assert.match(whyOf(line, 1), /^the type definitions could not be read \(code: 'unavailable'\)$/);
  assert.equal(whyOf(tap("not ok 2 - x\n  ---\n  duration_ms: 1\n  ...\nok 3 - y"), 1), "", "no reason in the diagnostics reads as empty, and the step then shows the end of the test file's output");
});
