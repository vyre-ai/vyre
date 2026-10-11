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

test("a file whose process ends badly after its cases says what it last printed", async () => {
  const { walkTestFile } = await import("../scripts/journeys/lib/testfile.mjs");
  /** @type {{ name: string, error: string }[]} */ const steps = [];
  const J = { step: async (/** @type {string} */ name, /** @type {() => unknown} */ fn) => { try { await fn(); steps.push({ name, error: "" }); } catch (e) { steps.push({ name, error: /** @type {Error} */ (e).message }); } } };
  // the inner run is a run of its own: node:test refuses to nest inside this one unless it is told it is not
  const ctx = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try { await walkTestFile(/** @type {any} */ (J), "test/fixtures/exits-after-its-cases.mjs", "trust").report(); } finally { if (ctx !== undefined) process.env.NODE_TEST_CONTEXT = ctx; }
  assert.equal(steps[0].error, "", "the passing case passes");
  const file = steps.find(s => s.name.endsWith("exits-after-its-cases.mjs"));
  assert.ok(file && /the process ended badly after its cases/.test(file.error) && /the daemon crashed after the cases: ECONNRESET/.test(file.error), JSON.stringify(steps));
});
