import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { starterBody, typeKey, checklist, canPublish, NOUN_SUGGESTIONS, STAGE_SETS, applyStageSet, publishWords, saveState } from "./compose.ts";

const titles = (b, si) => (b.stages[si].tasks || []).map((t) => t.title);

test("a blank playbook starts as one stage and an end, named Untitled, with no tasks", () => {
  const b = starterBody();
  assert.equal(b.name, "Untitled playbook");
  assert.deepEqual(b.stages.map((s) => s.name), ["Stage 1", "Done"]);
  assert.equal(b.stages[0].tasks, undefined);
});

test("Enter on a typed line adds the task and opens the next line; an empty line does nothing", () => {
  let r = typeKey(starterBody(), { si: 0, ti: 0 }, "Run the conflict check", "Enter");
  assert.deepEqual(titles(r.body, 0), ["Run the conflict check"]);
  assert.deepEqual(r.focus, { si: 0, ti: 1 });
  assert.equal(r.clear, true, "the line is emptied for the next task");
  const same = typeKey(r.body, { si: 0, ti: 1 }, "  ", "Enter");
  assert.equal(same.body, r.body);
});

test("Tab on an empty line starts a new stage after this one and goes to its first line; Tab with text keeps the text", () => {
  const r = typeKey(starterBody(), { si: 0, ti: 0 }, "", "Tab");
  assert.deepEqual(r.body.stages.map((s) => s.name), ["Stage 1", "Stage 2", "Done"]);
  assert.deepEqual(r.focus, { si: 1, ti: 0 });
  const t = typeKey(starterBody(), { si: 0, ti: 0 }, "half typed", "Tab");
  assert.equal(t.body.stages.length, 2, "no new stage while a task is being typed");
});

test("Shift+Tab goes back to the previous stage's line; on the first stage it stays", () => {
  const b = typeKey(starterBody(), { si: 0, ti: 0 }, "", "Tab").body;
  assert.deepEqual(typeKey(b, { si: 1, ti: 0 }, "", "Shift+Tab").focus, { si: 0, ti: 0 });
  assert.deepEqual(typeKey(b, { si: 0, ti: 0 }, "", "Shift+Tab").focus, { si: 0, ti: 0 });
});

test("Backspace on an empty line takes the last task back into the line to edit; with no tasks it removes an empty stage", () => {
  let b = typeKey(starterBody(), { si: 0, ti: 0 }, "First", "Enter").body;
  const r = typeKey(b, { si: 0, ti: 1 }, "", "Backspace");
  assert.deepEqual(titles(r.body, 0), []);
  assert.equal(r.fill, "First");
  assert.deepEqual(r.focus, { si: 0, ti: 0 });
  const two = typeKey(starterBody(), { si: 0, ti: 0 }, "", "Tab").body; // Stage 1, Stage 2, Done
  const gone = typeKey(two, { si: 1, ti: 0 }, "", "Backspace");
  assert.deepEqual(gone.body.stages.map((s) => s.name), ["Stage 1", "Done"]);
  assert.deepEqual(gone.focus, { si: 0, ti: 0 });
  const first = typeKey(starterBody(), { si: 0, ti: 0 }, "", "Backspace");
  assert.equal(first.body.stages.length, 2, "the first stage is never removed");
});

test("the checklist ticks itself and Publish needs a name, a stage with a task", () => {
  const b = starterBody();
  assert.deepEqual(checklist(b).map((c) => [c.id, c.done, c.optional]), [["name", false, false], ["stages", false, false], ["tasks", false, false], ["who", false, true], ["done", false, true], ["publish", false, false]]);
  const named = { ...b, name: "Estate plan" };
  assert.equal(checklist(named)[0].done, true);
  const full = typeKey(named, { si: 0, ti: 0 }, "Do it", "Enter").body;
  assert.equal(checklist(full)[2].done, true);
  assert.equal(canPublish(b).ok, false);
  assert.match(canPublish(b).why, /name/i);
  assert.equal(canPublish(named).ok, false);
  assert.match(canPublish(named).why, /task/i);
  assert.equal(canPublish(full).ok, true);
});

test("stage sets fill the stage titles in one click, keeping the tasks already there", () => {
  assert.ok(STAGE_SETS.length >= 3);
  const set = STAGE_SETS[0];
  const b = applyStageSet(typeKey(starterBody(), { si: 0, ti: 0 }, "Keep me", "Enter").body, set.id);
  assert.deepEqual(b.stages.map((s) => s.name), set.stages);
  assert.deepEqual(titles(b, 0), ["Keep me"]);
  assert.equal(applyStageSet(starterBody(), "nope").stages.length, 2);
});

test("noun suggestions are the usual law-firm words", () => {
  assert.deepEqual(NOUN_SUGGESTIONS.slice(0, 4), ["Matter", "Client", "Case", "Engagement"]);
});

test("the publish sheet says what changes for new work and for what is already running", () => {
  const w = publishWords({ name: "Estate plan", noun: { one: "Matter", many: "Matters" }, stages: [], live: 2 });
  assert.match(w, /new matters/i);
  assert.match(w, /already running/i);
  assert.match(w, /version 3/);
  assert.match(publishWords({ name: "X", stages: [], live: null }), /first version/i);
});

test("the draft's save state in words", () => {
  assert.equal(saveState({ dirty: false, saving: false, error: "" }), "Draft · saved");
  assert.equal(saveState({ dirty: true, saving: false, error: "" }), "Draft · unsaved");
  assert.equal(saveState({ dirty: true, saving: true, error: "" }), "Draft · saving");
  assert.equal(saveState({ dirty: true, saving: false, error: "no connection" }), "Draft · not saved: no connection");
});

test("a stage set matches a Kit when the stage names are the same in order, and then brings the Kit's tasks", async () => {
  const { kitFor, applyStageSet, STAGE_SETS } = await import("./compose.ts");
  const set = STAGE_SETS[0];
  const lib = [
    { id: "k/other", name: "Other", stages: 2, tasks: 1, outline: [{ name: "A", tasks: ["x"] }, { name: "B", tasks: [] }] },
    { id: "k/match", name: "Matching", stages: 4, tasks: 3, outline: set.stages.map((n, i) => ({ name: n.toLowerCase(), tasks: i === 0 ? ["Collect documents", "Run the check"] : i === 1 ? ["Review it"] : [] })) },
  ];
  assert.equal(kitFor(set.id, lib).id, "k/match");
  assert.equal(kitFor(set.id, [lib[0]]), null);
  const b = applyStageSet({ name: "X", stages: [{ name: "Stage 1" }, { name: "Done" }] }, set.id, kitFor(set.id, lib));
  assert.deepEqual(b.stages.map((s) => s.name), set.stages);
  assert.deepEqual((b.stages[0].tasks || []).map((t) => t.title), ["Collect documents", "Run the check"]);
  assert.deepEqual((b.stages[1].tasks || []).map((t) => t.title), ["Review it"]);
  assert.equal(b.stages[2].tasks, undefined);
  const keep = applyStageSet({ name: "X", stages: [{ name: "Stage 1", tasks: [{ title: "Mine", doer: "role:owner", output: { kind: "note" } }] }, { name: "Done" }] }, set.id, kitFor(set.id, lib));
  assert.deepEqual((keep.stages[0].tasks || []).map((t) => t.title), ["Mine"], "tasks already written are never replaced by a Kit's");
});
