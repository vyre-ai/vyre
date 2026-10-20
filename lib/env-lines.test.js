// The .env reader the import and the Vault screen share (lib/env-lines.js): the import's reading is unchanged, the paste reading keeps every character of a value, and a written
// line reads back byte-exact.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { envEntries, envLine } from "./env-lines.js";

const read = (/** @type {string} */ text, exact = false) => Object.fromEntries(envEntries(text, { exact }).entries.map((e) => [e.key, e.value]));

test("the import's reading is as it was: an unquoted value loses its spaces and a trailing comment", () => {
  assert.deepEqual(read("A = one  \nB=two # note\nexport C='x y'\nD=\"l1\\nl2\"\n"), { A: "one", B: "two", C: "x y", D: "l1\nl2" });
});

test("the paste reading keeps a value exactly as written: a space at either end stays, so the screen can say so", () => {
  const got = read("GHL_API_KEY=pit-1234 \nGHL_LOCATION_ID= loc9\nNOTE=a # comment\nQ= \"quoted \"\n", true);
  assert.equal(got.GHL_API_KEY, "pit-1234 ", "a trailing space is kept, never trimmed");
  assert.equal(got.GHL_LOCATION_ID, " loc9", "a leading space is kept");
  assert.equal(got.NOTE, "a", "a comment is still a comment");
  assert.equal(got.Q, "quoted ", "inside quotes, what is quoted");
});

test("a written line reads back to the same bytes, whatever the value holds", () => {
  for (const v of ["plain-value_1", "ends with a space ", " starts", "has \"quotes\" and \\slashes\\", "two\nlines\r\n", "tab\there", "#hash", "a=b", "x # y"]) {
    const line = envLine("K", v);
    assert.equal(read(line, true).K, v, JSON.stringify(v));
    assert.equal(read(line).K, v, `the import reads ${JSON.stringify(v)} the same`);
  }
  assert.equal(envLine("GHL_LOCATION_ID", "loc9"), "GHL_LOCATION_ID=loc9");
});
