// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainText, APPROVE_LABEL, healthBanner, healthRow, listWaits, shownWarnings, shrunkNote, stageLine, titleOf, versionWaits } from "./real-model.js";
import { fromDefinition as flowFromDefinition, toDefinition as flowDefinition } from "../../ui/flows/logic.js";

test("a Flow is called by its words, never its id", () => {
  assert.equal(titleOf({ label: "Welcome the client", name: "welcome" }, "fl_01a123ae-79f0"), "Welcome the client");
  assert.equal(titleOf({ name: "welcome" }, "fl_01a123ae-79f0"), "welcome");
  assert.equal(titleOf(undefined, "fl_01a123ae-79f0"), "Untitled Flow", "with no words at all it says so; an id is not for a person");
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

test("a member approves her own Flow and sends someone else's version for approval; an owner or admin approves any", async () => {
  const { approvalPath } = await import("./real-model.js");
  assert.equal(approvalPath({ role: "member", by: "per_bob", me: "per_bob" }), "approve");
  assert.equal(approvalPath({ role: "member", by: { id: "per_bob" }, me: "per_ann" }), "propose");
  assert.equal(approvalPath({ role: "member", by: "per_bob", me: "per_ann" }), "propose");
  assert.equal(approvalPath({ role: "owner", by: "per_bob", me: "per_ann" }), "approve");
  assert.equal(approvalPath({ role: "admin", by: "per_bob", me: "per_ann" }), "approve");
  assert.equal(approvalPath({ role: "member", by: undefined, me: "per_ann" }), "approve", "an unknown author keeps Approve; the door still decides");
  assert.equal(approvalPath({ role: undefined, by: "per_bob", me: "per_ann" }), "approve", "no role known: the door decides");
});

test("a Flow is never shown by its id: no name means words, in the list rows, the attention strip and a Flow's own page", async () => {
  const { titleOf, rowName, UNTITLED } = await import("./real-model.js");
  const { proposals } = await import("./assistant-model.ts");
  const ID = "fl_01a12d63-0000-4000-8000-000000000000";
  assert.equal(titleOf(null, ID), UNTITLED);
  assert.equal(titleOf({}, ID), UNTITLED);
  assert.equal(rowName({ label: "", name: "" }), UNTITLED);
  assert.equal(rowName({ name: "Intake" }), "Intake");
  const cards = proposals([/** @type {any} */ ({ id: ID, active: null })], []);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, UNTITLED, "the attention card says words");
  for (const text of [cards[0].title, cards[0].sub, titleOf(null, ID), rowName(null)]) assert.doesNotMatch(text, /fl_[0-9a-f-]{8,}/);
});

// A Playbook stage opens in the Flow builder (kernel/flows/stage-flow.js): it says what it is, and opening and saving it keeps its stage, its slots and what the builder has no field for.
const STAGE = {
  format: 1, name: "stage-0123456789ab", label: "Ticket: Open", authorship: "kit",
  playbook: { key: "type:ticket::Open", type: "ticket", stage: "Open", from: "abc" },
  trigger: { on: "stage", type: "ticket", stage: "Open" },
  steps: [
    { id: "task_1", kind: "assign", label: "Draft the reply", title: "Draft the reply", to: "teammate:research", output: { kind: "note" }, reviewer: { who: "person:per_bob" }, await: true, task: { due_offset_ms: 86400000 } },
    { id: "move", kind: "stage", label: "Move on to Closed", type: "ticket", record: { expr: "trigger.id" }, to: "Closed" },
  ],
};

test("a Playbook stage's Flow says it runs when a record enters the stage, and other Flows say nothing", () => {
  assert.equal(stageLine(STAGE), "A Playbook stage. It runs when a ticket enters Open. Its steps are the stage's to-dos, and the last one moves it on when they are done.");
  assert.match(String(stageLine({ ...STAGE, playbook: { ...STAGE.playbook, template: "tpl_sample", version: 1 } })), /when a project enters Open/);
  assert.equal(stageLine({ format: 1, name: "x", trigger: { on: "manual" }, steps: [] }), null);
  for (const v of [stageLine(STAGE)]) assert.doesNotMatch(String(v), /[\u2014\u00a7]/, "plain words: no long dash, no section sign");
});

test("opening a Playbook stage in the Flow builder and saving it keeps its trigger, its slots, its to-do's details and what makes it a stage", () => {
  const back = flowDefinition(flowFromDefinition(STAGE));
  assert.deepEqual(back.trigger, STAGE.trigger);
  assert.deepEqual(back.playbook, STAGE.playbook);
  assert.equal(back.name, STAGE.name);
  const step = back.steps.find((s) => s.id === "task_1");
  assert.deepEqual(step.reviewer, { who: "person:per_bob" }, "Reviewer");
  assert.equal(step.to, "teammate:research", "Assigned");
  assert.deepEqual(step.task, { due_offset_ms: 86400000 }, "the to-do's details the builder has no field for");
  assert.equal(step.await, true);
  assert.deepEqual(back.steps.find((s) => s.id === "move"), STAGE.steps[1], "the move on");
});
