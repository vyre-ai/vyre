// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainText, APPROVE_LABEL, healthBanner, healthRow, listWaits, shownWarnings, shrunkNote, titleOf, versionWaits } from "./real-model.js";

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

test("a row in the Flows list says how the Flow is doing in the kernel's words, and marks only a red one", () => {
  assert.deepEqual(healthRow({ trigger: "When a contact is added", level: "green", line: "Last run 3 minutes ago. 4 of 4 ok this week" }), { sub: "Last run 3 minutes ago. 4 of 4 ok this week · When a contact is added", chip: null });
  assert.equal(healthRow({ trigger: "Every weekday at 9", level: "red", line: "Red: google is down. Last run 2 days ago, failed" }).chip, "Needs a look");
  assert.equal(healthRow({ trigger: "Every day", level: "amber", line: "Paused" }).chip, null, "a pause is said in the line, not shouted");
  assert.deepEqual(healthRow({}), { sub: undefined, chip: null });
});

test("a Flow's own page leads with a banner when it is red or amber, and says how it is doing quietly when it is well", () => {
  assert.deepEqual(healthBanner({ level: "red", line: "Red: google is down. Last run 2 days ago, failed" }), { tone: "err", text: "Red: google is down. Last run 2 days ago, failed" });
  assert.equal(healthBanner({ level: "amber", line: "Paused" }).tone, "warn");
  assert.equal(healthBanner({ level: "green", line: "Last run 3 minutes ago. 4 of 4 ok this week" }).tone, "quiet");
  assert.equal(healthBanner({ level: "grey", line: "Not approved yet" }).tone, "quiet");
  assert.equal(healthBanner(null), null);
  assert.equal(healthBanner({ level: "red" }), null, "no line, nothing to say");
});

test("explain a run: the box's paragraph is the card's words, and nothing else draws a card", () => {
  assert.equal(explainText({ explain: "  It ran because the stage moved to Engagement. It made Welcome note. It finished. ", lines: ["x"] }), "It ran because the stage moved to Engagement. It made Welcome note. It finished.");
  assert.equal(explainText({ lines: ["only lines"] }), "");
  assert.equal(explainText(null), "");
  assert.equal(explainText({ explain: 5 }), "");
});
