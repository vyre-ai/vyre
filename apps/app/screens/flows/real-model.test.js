// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVE_LABEL, listWaits, shownWarnings, shrunkNote, titleOf, versionWaits } from "./real-model.js";

test("a Flow is called by its words, never its id", () => {
  assert.equal(titleOf({ label: "Welcome the client", name: "welcome" }, "fl_01a123ae-79f0"), "Welcome the client");
  assert.equal(titleOf({ name: "welcome" }, "fl_01a123ae-79f0"), "welcome");
  assert.equal(titleOf(undefined, "fl_01a123ae-79f0"), "fl_01a123ae-79f0", "only when it has no words at all");
});

test("a Flow waits for the person only while no version of it is approved", () => {
  assert.equal(listWaits({ active: null }), true);
  assert.equal(listWaits({ active: 2 }), false, "an approved Flow has its switch");
  assert.equal(versionWaits({ approver: null }), true);
  assert.equal(versionWaits({ approver: { kind: "person", id: "per_x" } }), false, "a version somebody approved does not ask again");
});

test("a Flow's page shows the warnings a person can act on, not the note about the powers it derives for itself", () => {
  const ws = [{ path: "caps", message: "no caps are declared, so the Flow's own steps set them" }, { path: "steps[2]", message: "drafted by a model: a destination read from records needs a person's Ask on every run" }, "plain words"];
  assert.deepEqual(shownWarnings(ws), ["drafted by a model: a destination read from records needs a person's Ask on every run", "plain words"]);
  assert.deepEqual(shownWarnings(undefined), []);
});

test("the approval button names no biometric: approving a Flow asks the device for no proof", () => {
  assert.equal(APPROVE_LABEL, "Approve");
  assert.doesNotMatch(APPROVE_LABEL, /Face ID|Touch ID|fingerprint|passkey/i);
});

test("a run that shrank to one line says so in its own words; a run with its details says nothing", () => {
  assert.equal(shrunkNote({ pruned: true, summary: "Welcome the client: done" }), "Welcome the client: done");
  assert.equal(shrunkNote({ pruned: true }), "This run kept only its outcome.");
  assert.equal(shrunkNote({ state: "done", steps: { a: {} } }), null);
  assert.equal(shrunkNote(undefined), null);
});
