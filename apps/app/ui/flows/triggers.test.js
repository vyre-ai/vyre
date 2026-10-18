import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { fromDefinition, toDefinition, eventChoices, EVENT_CHOICES, flowSentence, draftProblems } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const flowOf = (trigger) => ({ format: 1, name: "t", label: "T", authorship: "builder", trigger, steps: [{ id: "c1", kind: "create", type: "matter", set: { client: "x" } }] });

test("a record, event or watcher trigger keeps its optional condition and opens as the same editable trigger", () => {
  for (const [trigger, kind] of [
    [{ on: "event", event: "matter.created", where: "trigger.amount > 5" }, "created"],
    [{ on: "event", event: "documents.signed", where: "trigger.name == \"x\"" }, "event"],
    [{ on: "watcher", watcher: "new-mail", where: "trigger.item.from != \"\"" }, "watcher"],
    [{ on: "event", event: ["matter.created", "matter.updated"], field: "status", when_record_changes: "replace", where: "trigger.after.amount > 5" }, "changed"],
  ]) {
    const stored = flowOf(trigger);
    assert.deepEqual(checkFlow(stored), [], JSON.stringify(trigger));
    const d = fromDefinition(stored);
    assert.equal(d.trigger.kind, kind, `${kind} is not an Advanced trigger`);
    assert.equal(d.trigger.where, trigger.where);
    assert.deepEqual(toDefinition(d, O).trigger, trigger, "saved back unchanged");
  }
  const none = fromDefinition(flowOf({ on: "event", event: "matter.created" }));
  assert.equal(toDefinition({ ...none, trigger: { ...none.trigger, where: "  " } }, O).trigger.where, undefined, "a blank condition is not stored");
});

test("a trigger the editor cannot read with a condition stays whole as an Advanced trigger", () => {
  const raw = { on: "stage", type: "matter", stage: "Drafting" };
  const d = fromDefinition(flowOf({ ...raw, where: "x" }));
  assert.equal(d.trigger.kind, "advanced");
});

test("Something else happens lists the plain-worded events, then every event the modules announce, and keeps a stored one the catalog dropped", () => {
  const o = { ...O, events: [{ type: "documents.signed", module: "documents" }, { type: "tasks.escalated", module: "planner" }, { type: "old.thing", module: "x", deprecated: true }, { type: "agents.woken", module: "agents" }] };
  const all = eventChoices(o);
  assert.deepEqual(all.slice(0, EVENT_CHOICES.length), EVENT_CHOICES, "the plain-worded ones first, unchanged");
  assert.deepEqual(all.slice(EVENT_CHOICES.length).map(([v]) => v), ["agents.woken", "tasks.escalated"], "then the rest, by name, none twice, none deprecated");
  assert.equal(all.find(([v]) => v === "tasks.escalated")[1], "tasks.escalated (from planner)");
  assert.ok(eventChoices(o, "gone.event").some(([v]) => v === "gone.event"), "a stored event stays choosable");
  assert.deepEqual(eventChoices({ ...O, events: undefined }), EVENT_CHOICES, "a person the catalog refuses sees the plain-worded events");
});

const typed = { ...O, types: [{ name: "matter", label: "Matter", fields: [{ name: "client", label: "Client", kind: "text" }, { name: "amount", label: "Amount", kind: "number" }, { name: "stage", label: "Stage", kind: "stage", options: ["Intake", "Drafting", "Signed"] }] }] };

test("Create, Update and the stage step pick from the object's own fields and stages, and keep a stored one that is gone", async () => {
  const { fieldChoices, fieldValue, stagesOf, stageChoices } = await import("./logic.js");
  assert.deepEqual(fieldChoices(typed, "matter").map(([n]) => n), ["client", "amount", "stage"]);
  assert.equal(fieldValue(typed, "matter", "Amount"), "amount", "a label typed before is the field it names");
  assert.equal(fieldValue(typed, "matter", "amount"), "amount");
  assert.equal(fieldValue(typed, "matter", "Amoutn"), "Amoutn", "a typo stays as written, so it can be seen and fixed");
  assert.deepEqual(fieldChoices(typed, "matter", "Amoutn").at(-1), ["Amoutn", "Amoutn (not an object field)"]);
  assert.deepEqual(fieldChoices(typed, "nothing"), []);
  assert.deepEqual(stagesOf(typed, "matter"), ["Intake", "Drafting", "Signed"]);
  assert.deepEqual(stagesOf(typed, "nothing"), []);
  assert.deepEqual(stageChoices(typed, "matter", "Closed").at(-1), ["Closed", "Closed (not a stage of this object)"]);
});

test("the renamed words: a record moves to a stage, I press Run, At a set time, Look up records, Run another Flow", async () => {
  const { TRIGGERS, STEP_CHOICES } = await import("./logic.js");
  const label = (list, k, key) => list.find((x) => x[key] === k)?.label;
  assert.equal(label(TRIGGERS, "stage", "id"), "A record moves to a stage");
  assert.equal(label(TRIGGERS, "manual", "id"), "I press Run");
  assert.equal(label(TRIGGERS, "schedule", "id"), "At a set time");
  assert.equal(label(STEP_CHOICES, "find", "kind"), "Look up records");
  assert.equal(label(STEP_CHOICES, "subflow", "kind"), "Run another Flow");
});

test("a Flow with several triggers opens as the first plus the others, says them with or, and saves back as triggers", () => {
  const triggers = [{ on: "event", event: "matter.created", where: "trigger.amount > 5" }, { on: "time", every_ms: 900000 }];
  const stored = { format: 1, name: "t", label: "T", authorship: "builder", triggers, steps: [{ id: "c1", kind: "create", type: "matter", set: { client: "x" } }] };
  assert.deepEqual(checkFlow(stored), []);
  const d = fromDefinition(stored);
  assert.equal(d.trigger.kind, "created");
  assert.equal(d.moreTriggers.length, 1);
  assert.equal(d.moreTriggers[0].kind, "schedule");
  const back = toDefinition(d, O);
  assert.deepEqual(back.triggers, triggers);
  assert.equal(back.trigger, undefined, "a Flow has either trigger or triggers");
  assert.deepEqual(checkFlow(back), []);
  assert.match(flowSentence(d, O), /, or when /);
  const one = toDefinition({ ...d, moreTriggers: [] }, O);
  assert.deepEqual(one.trigger, triggers[0]);
  assert.equal(one.triggers, undefined);
});

test("each trigger is checked on its own, named when there is more than one", () => {
  const d = fromDefinition({ format: 1, name: "t", label: "T", authorship: "builder", trigger: { on: "event", event: "matter.created" }, steps: [{ id: "c1", kind: "create", type: "matter", set: { client: "x" } }] });
  const two = { ...d, trigger: { kind: "created", type: "matter" }, moreTriggers: [{ kind: "watcher", watcher: "" }] };
  assert.deepEqual(draftProblems(two, O), ["Trigger 2: Name the watcher."]);
});

test("a step turned off keeps enabled false and stays an editable step", () => {
  const stored = { format: 1, name: "t", label: "T", authorship: "builder", trigger: { on: "manual" }, steps: [{ id: "c1", kind: "create", type: "matter", set: { client: "x" }, enabled: false }] };
  assert.deepEqual(checkFlow(stored), []);
  const d = fromDefinition(stored);
  assert.equal(d.steps[0].kind, "create", "not an Advanced step");
  assert.equal(d.steps[0].enabled, false);
  assert.equal(toDefinition(d, O).steps[0].enabled, false);
  const on = { ...d, steps: [{ ...d.steps[0], enabled: undefined }] };
  assert.equal("enabled" in toDefinition(on, O).steps[0], false, "turned on again, the key goes");
});
