import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { nameOf, looksLikeName, checkAnswer, reserveAnswer, lasts } from "./reserve.js";

test("a typed name is lower case with the address stripped, and short or odd ones are not asked about", () => {
  assert.equal(nameOf("  Harlow.vyre.run "), "harlow");
  assert.equal(nameOf(undefined), "");
  assert.ok(looksLikeName("harlow") && looksLikeName("a-b"));
  for (const bad of ["", "ab", "-abc", "abc-", "a b c", "a".repeat(40), "under_score"]) assert.equal(looksLikeName(bad), false, bad);
});

test("the directory's check: ok and mine are free, taken and reserved are not, a limit or garbage is unknown", () => {
  assert.equal(checkAnswer(200, { data: { status: "ok" } }), "free");
  assert.equal(checkAnswer(200, { data: { status: "taken" } }), "taken");
  assert.equal(checkAnswer(200, { data: { status: "reserved" } }), "taken");
  assert.equal(checkAnswer(200, { data: { status: "invalid" } }), "invalid");
  assert.equal(checkAnswer(429, { error: {} }), "unknown");
  assert.equal(checkAnswer(0, null), "unknown");
});

test("a reservation is a code, or a plain reason", () => {
  const ok = reserveAnswer(200, { data: { name: "harlow", code: "VYRE-ABCD-EFGH-2345-6723", expires: 5 } });
  assert.deepEqual(ok, { ok: true, code: "VYRE-ABCD-EFGH-2345-6723", expires: 5 });
  assert.match(String(reserveAnswer(429, null).say), /Too many/);
  assert.match(String(reserveAnswer(409, null).say), /Someone else/);
  assert.equal(reserveAnswer(200, { data: { code: "nope" } }).ok, false);
  assert.equal(lasts(24 * 3_600_000, 0), "24 hours");
});
