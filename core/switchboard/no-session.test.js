// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { shouldStartFresh } from "./no-session.js";

const base = { resume: true, heard: false, stopping: false, fresh: false, closing: false, code: 1, stderr: "", turns: 0 };

test("every provider's words for a missing session start it fresh, with or without turns behind it", () => {
  for (const why of ["No conversation found with session ID: abc", "Error: no rollout found for thread id 123", "session not found: s1", "Session does not exist", "unknown session abc", "could not resume the session"]) {
    assert.equal(shouldStartFresh({ ...base, turns: 3, stderr: why }), true, why);
  }
});

test("a resume that never began and has no finished turn starts fresh whatever the provider said", () => {
  assert.equal(shouldStartFresh({ ...base, stderr: "boom" }), true);
  assert.equal(shouldStartFresh({ ...base }), true);
});

test("a thread with finished turns is not wiped by an unrelated failure", () => {
  assert.equal(shouldStartFresh({ ...base, turns: 4, stderr: "network unreachable" }), false);
});

test("never twice, never a clean exit, never a stop, never a start, never a crash after the session spoke", () => {
  assert.equal(shouldStartFresh({ ...base, fresh: true }), false);
  assert.equal(shouldStartFresh({ ...base, code: 0 }), false);
  assert.equal(shouldStartFresh({ ...base, stopping: true }), false);
  assert.equal(shouldStartFresh({ ...base, closing: true }), false);
  assert.equal(shouldStartFresh({ ...base, resume: false }), false);
  assert.equal(shouldStartFresh({ ...base, heard: true, stderr: "network" }), false, "it spoke, so this is a crash, not a missing session");
  assert.equal(shouldStartFresh({ ...base, heard: true, stderr: "No conversation found" }), true, "but a missing session is one whatever came before");
});
