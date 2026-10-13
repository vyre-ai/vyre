import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blank, setName, setOpensOn, addStage, renameStage, moveStage, removeStage, setStageOwner, setMovesOn, addTask, setTask, moveTask, removeTask, addRole, setRoleAgent, setRoleLead, removeRole, doerChoices, ownerChoices, missing, whenChoices, addAutomation, setAutomationWhen, removeAutomation } from "./edit.ts";

const base = () => {
  let b = setName(blank(), "Estate plan");
  b = addRole(b, "attorney"); b = addRole(b, "researcher");
  b = setTask(b, 0, 0, { title: "Gather documents", doer: "role:researcher" });
  return b;
};

test("a new template needs a name and a task title, and says so in words", () => {
  assert.deepEqual(missing(blank()), ["Give the template a name.", "Task 1 of Start needs a title."]);
  assert.deepEqual(missing(base()), []);
});

test("stages are added, renamed, moved and removed, and a template keeps at least two", () => {
  let b = addStage(base());
  assert.deepEqual(b.stages.map((s) => s.name), ["Start", "Done", "Stage 3"]);
  b = renameStage(b, 2, "Signing");
  b = moveStage(b, 2, -1);
  assert.deepEqual(b.stages.map((s) => s.name), ["Start", "Signing", "Done"]);
  assert.deepEqual(moveStage(b, 0, -1).stages.map((s) => s.name), ["Start", "Signing", "Done"], "the first cannot move up");
  b = removeStage(b, 1);
  assert.deepEqual(b.stages.map((s) => s.name), ["Start", "Done"]);
  assert.match(missing(removeStage(b, 1)).join(" "), /at least two stages/);
});

test("tasks: add, set, move, remove; a cleared field leaves the key out; removing the last task leaves a stage without tasks", () => {
  let b = addTask(base(), 0);
  assert.deepEqual(b.stages[0].tasks[1], { title: "", doer: "role:attorney", output: { kind: "note" } }, "a new task is given to the first role");
  b = setTask(b, 0, 1, { title: "Draft the trust", checker: "role:attorney", output_kind: "decision", brief: "Use the firm's form" });
  assert.deepEqual(b.stages[0].tasks[1], { title: "Draft the trust", doer: "role:attorney", checker: "role:attorney", output: { kind: "decision" }, brief: "Use the firm's form" });
  b = setTask(b, 0, 1, { checker: "", brief: "" });
  assert.equal("checker" in b.stages[0].tasks[1], false);
  assert.equal("brief" in b.stages[0].tasks[1], false);
  b = moveTask(b, 0, 1, -1);
  assert.deepEqual(b.stages[0].tasks.map((t) => t.title), ["Draft the trust", "Gather documents"]);
  b = removeTask(removeTask(b, 0, 0), 0, 0);
  assert.equal("tasks" in b.stages[0], false);
});

test("stage owner, the condition to move on, and the page a project opens on are set and cleared", () => {
  let b = setStageOwner(base(), 0, "role:attorney");
  assert.equal(b.stages[0].owner, "role:attorney");
  assert.equal("owner" in setStageOwner(b, 0, "").stages[0], false);
  b = setMovesOn(b, 0, " record.status == 'ready' ");
  assert.equal(b.stages[0].moves_on_when, "record.status == 'ready'");
  assert.equal("moves_on_when" in setMovesOn(b, 0, "  ").stages[0], false);
  assert.equal(setOpensOn(b, "files").opens_on, "files");
  assert.equal("opens_on" in setOpensOn(setOpensOn(b, "files"), ""), false, "the usual page leaves the key out");
});

test("roles: one lead at most, an agent can fill one, and removing a role takes it off the tasks and stages that named it", () => {
  let b = base();
  b = setRoleAgent(b, "researcher", "research");
  b = setRoleLead(b, "researcher", true);
  b = setRoleLead(b, "attorney", true);
  assert.deepEqual(b.roles, [{ role: "attorney", lead: true }, { role: "researcher", agent: "research" }]);
  b = setStageOwner(b, 0, "role:researcher");
  b = removeRole(b, "researcher");
  assert.deepEqual(b.roles, [{ role: "attorney", lead: true }]);
  assert.equal("owner" in b.stages[0], false, "the stage no longer names the removed role");
  assert.equal(b.stages[0].tasks[0].doer === undefined || b.stages[0].tasks[0].doer === "", true);
  assert.match(missing(b).join(" "), /needs someone to do it/);
  assert.deepEqual(doerChoices(b).map(([v]) => v), ["role:attorney", "role:owner"]);
  assert.deepEqual(ownerChoices(b).map(([v]) => v), ["", "role:attorney"]);
});

test("automations: attach a Flow at the start or at a stage, once per point; renaming a stage moves them, removing it takes them", () => {
  let b = base();
  b = addAutomation(b, "fl_welcome");
  b = addAutomation(b, "fl_welcome");
  assert.deepEqual(b.automations, [{ when: "start", flow: "fl_welcome" }], "the same Flow at the same point once");
  b = addAutomation(b, "fl_file", "Done");
  assert.deepEqual(whenChoices(b).map(([v]) => v), ["start", "Start", "Done"]);
  b = renameStage(b, 1, "Finished");
  assert.deepEqual(b.automations.map((a) => a.when), ["start", "Finished"]);
  b = setAutomationWhen(b, 0, "Start");
  assert.equal(b.automations[0].when, "Start");
  b = addStage(b);
  b = removeStage(b, 1);
  assert.deepEqual(b.automations.map((a) => a.flow), ["fl_welcome"], "the automation on the removed stage went with it");
  b = removeAutomation(b, 0);
  assert.equal("automations" in b, false);
});

test("a template says what its projects are called, and the plural follows the singular until it is set by hand", async () => {
  const { setNoun, nounOf } = await import("./edit.ts");
  let b = setNoun(base(), "Matter");
  assert.deepEqual(b.noun, { one: "Matter", many: "Matters" });
  b = setNoun(b, "Campaign");
  assert.deepEqual(b.noun, { one: "Campaign", many: "Campaigns" });
  b = setNoun(b, "Case", "Cases");
  assert.deepEqual(b.noun, { one: "Case", many: "Cases" });
  assert.deepEqual(setNoun(b, "").noun, undefined);
  assert.deepEqual(nounOf(setNoun(base(), "Policy")), { one: "Policy", many: "Policies" });
  assert.deepEqual(nounOf(base()), { one: "Project", many: "Projects" });
  assert.deepEqual(nounOf(null), { one: "Project", many: "Projects" });
});

test("a plural set by hand stays when the singular is edited", async () => {
  const { setNoun } = await import("./edit.ts");
  let b = setNoun(setNoun(base(), "Case"), "Case", "Cases here");
  b = setNoun(b, "Cases");
  assert.equal(b.noun.many, "Cases here");
});

test("a noun without a plural cannot be saved, and says what to add", async () => {
  const { setNoun } = await import("./edit.ts");
  assert.deepEqual(missing(setNoun(base(), "Matter", "")), ['Say what several matter projects are called, such as "Matters".']);
});

test("a task is given to a role, the project lead, a person or an assistant, each named in words", async () => {
  const { assigneeChoices, assigneeWords, kindOfDoer } = await import("./edit.ts");
  const b = base();
  const ch = assigneeChoices(b, [{ id: "per_bob", name: "Bob Reyes" }], [{ id: "research", name: "Research" }]);
  assert.deepEqual(ch.map(([v]) => v), ["role:attorney", "role:researcher", "lead", "person:per_bob", "teammate:research"]);
  assert.deepEqual(ch.map(([, l]) => l), ["The attorney", "The researcher", "The project lead", "Bob Reyes", "Research (agent)"]);
  assert.equal(assigneeWords("lead", [], []), "The project lead");
  assert.equal(assigneeWords("person:per_x", [], []), "A person");
  assert.deepEqual(["role:a", "lead", "person:p", "teammate:t", "owner"].map(kindOfDoer), ["role", "lead", "person", "agent", "role"]);
});

test("a task's due is set in days and kept in milliseconds; empty or zero takes it away", async () => {
  const { setDueDays, dueDays } = await import("./edit.ts");
  let b = setTask(base(), 0, 0, {});
  b = setDueDays(b, 0, 0, "3");
  assert.equal(b.stages[0].tasks[0].due_offset_ms, 3 * 86_400_000);
  assert.equal(dueDays(b.stages[0].tasks[0]), "3");
  assert.equal(setDueDays(b, 0, 0, "").stages[0].tasks[0].due_offset_ms, undefined);
  assert.equal(setDueDays(b, 0, 0, "0").stages[0].tasks[0].due_offset_ms, undefined);
  assert.equal(setDueDays(b, 0, 0, "abc").stages[0].tasks[0].due_offset_ms, 3 * 86_400_000, "a word is not a number of days: it changes nothing");
  assert.equal(dueDays({ title: "x", doer: "lead", output: { kind: "note" } }), "");
});

test("an assistant's task can wait for a person's yes, written in a line; a person's task cannot", async () => {
  const { setApproval, approvalOf } = await import("./edit.ts");
  let b = setTask(base(), 0, 0, { doer: "teammate:research" });
  b = setApproval(b, 0, 0, "sending anything to the client");
  assert.deepEqual(b.stages[0].tasks[0].needs_yes, ["sending anything to the client"]);
  assert.equal(approvalOf(b.stages[0].tasks[0]), "sending anything to the client");
  assert.equal(setApproval(b, 0, 0, "  ").stages[0].tasks[0].needs_yes, undefined);
  const person = setTask(b, 0, 0, { doer: "role:attorney" });
  assert.equal(person.stages[0].tasks[0].needs_yes, undefined, "moving the task to a person drops the approval line");
});

test("a stage's tasks sit in named groups: a task is put in one, a rename or a delete keeps the tasks, and a stage that loses its groups keeps its tasks", async () => {
  const { setStageGroups, groupsOf } = await import("./edit.ts");
  let b = setTask(base(), 0, 0, {});
  b = setStageGroups(b, 0, { groups: [{ name: "Documents" }, { name: "Client calls" }], items: b.stages[0].tasks });
  assert.deepEqual(groupsOf(b.stages[0]), [{ name: "Documents" }, { name: "Client calls" }]);
  b = setTask(b, 0, 0, { group: "Documents" });
  assert.equal(b.stages[0].tasks[0].group, "Documents");
  b = setStageGroups(b, 0, { groups: [{ name: "Papers" }, { name: "Client calls" }], items: b.stages[0].tasks.map((t) => (t.group === "Documents" ? { ...t, group: "Papers" } : t)) });
  assert.equal(b.stages[0].tasks[0].group, "Papers");
  b = setStageGroups(b, 0, { groups: [{ name: "Client calls" }], items: b.stages[0].tasks.map(({ group, ...t }) => t) });
  assert.equal(b.stages[0].tasks[0].group, undefined);
  assert.equal(b.stages[0].tasks.length, 1, "deleting a group keeps its tasks");
  assert.equal(setStageGroups(b, 0, { groups: [], items: b.stages[0].tasks }).stages[0].groups, undefined, "no groups: the field is gone");
});

test("removing a stage's last group of tasks never leaves a task naming a group its stage no longer has, and a renamed task group fails the save in words", async () => {
  const { setStageGroups } = await import("./edit.ts");
  let b = setStageGroups(setTask(base(), 0, 0, {}), 0, { groups: [{ name: "Documents" }], items: [{ ...base().stages[0].tasks[0], group: "Documents" }] });
  b = setStageGroups(b, 0, { groups: [], items: b.stages[0].tasks });
  assert.equal(b.stages[0].tasks[0].group, undefined);
  assert.deepEqual(missing(b), []);
});

test("how projects move: stages in order, in any order, or none; the default is in order and writes nothing", async () => {
  const { setStageMode, stageModeOf, STAGE_MODES } = await import("./edit.ts");
  assert.deepEqual(STAGE_MODES.map(([v]) => v), ["ordered", "any", "none"]);
  assert.equal(stageModeOf(base()), "ordered");
  assert.equal(setStageMode(base(), "ordered").stage_mode, undefined);
  assert.equal(setStageMode(base(), "any").stage_mode, "any");
  assert.equal(stageModeOf(setStageMode(base(), "none")), "none");
});

test("a stage is done when every task, the needed ones, or a sign-off says; sign-off asks who, and the line below says what happens next", async () => {
  const { setDoneWhen, setSignOff, doneWhenOf, nextLine, DONE_WHEN, setStageMode } = await import("./edit.ts");
  assert.deepEqual(DONE_WHEN.map(([v]) => v), ["all", "needed", "sign_off"]);
  let b = addStage(base()); // Start, Done, Stage 3
  assert.equal(doneWhenOf(b.stages[0]), "needed");
  assert.equal(setDoneWhen(b, 0, "needed").stages[0].done_when, undefined, "the default writes nothing");
  b = setDoneWhen(b, 0, "all");
  assert.equal(b.stages[0].done_when, "all");
  b = setDoneWhen(b, 0, "sign_off");
  assert.deepEqual(missing(b), ["Choose who signs off Start."]);
  b = setSignOff(b, 0, "role:attorney");
  assert.deepEqual(missing(b), []);
  assert.equal(nextLine(b, 0), "Then it waits for the attorney to sign it off, and moves to Done.");
  assert.equal(nextLine(setDoneWhen(b, 0, "all"), 0), "Then the project moves to Done.", "leaving sign-off forgets the signer");
  assert.equal(setDoneWhen(b, 0, "all").stages[0].sign_off, undefined);
  assert.equal(nextLine(b, 2), "The last stage: the project ends here.");
  assert.equal(nextLine(setStageMode(base(), "any"), 0), "Then a person moves the project on.");
});

test("the project lead can sign a stage off, and the line says so", async () => {
  const { setDoneWhen, setSignOff, nextLine } = await import("./edit.ts");
  const b = setSignOff(setDoneWhen(addStage(base()), 0, "sign_off"), 0, "lead");
  assert.deepEqual(missing(b), []);
  assert.equal(nextLine(b, 0), "Then it waits for the project lead to sign it off, and moves to Done.");
});

test("followers are added and removed once each, and the approver's and followers' notes are kept as text", async () => {
  const { addFollower, removeFollower, setNote, noteOf } = await import("./edit.ts");
  let b = setTask(base(), 0, 0, {});
  b = addFollower(b, 0, 0, "role:attorney");
  b = addFollower(b, 0, 0, "person:per_bob");
  b = addFollower(b, 0, 0, "role:attorney");
  assert.deepEqual(b.stages[0].tasks[0].followers, ["role:attorney", "person:per_bob"]);
  b = removeFollower(b, 0, 0, "role:attorney");
  assert.deepEqual(b.stages[0].tasks[0].followers, ["person:per_bob"]);
  assert.equal(removeFollower(b, 0, 0, "person:per_bob").stages[0].tasks[0].followers, undefined, "no followers: the field is gone");
  b = setNote(b, 0, 0, "approver", "Check the dates.");
  b = setNote(b, 0, 0, "followers", "Read along.");
  assert.deepEqual(b.stages[0].tasks[0].notes, { approver: "Check the dates.", followers: "Read along." });
  assert.equal(noteOf(b.stages[0].tasks[0], "approver"), "Check the dates.");
  assert.deepEqual(setNote(b, 0, 0, "approver", "  ").stages[0].tasks[0].notes, { followers: "Read along." });
  assert.equal(setNote(setNote(b, 0, 0, "approver", ""), 0, 0, "followers", "").stages[0].tasks[0].notes, undefined);
});

test("a task is dropped at a place in a stage, in its own or another; a stage is dropped at a place; both keep every task", async () => {
  const { moveTaskTo, moveStageTo, setStageGroups } = await import("./edit.ts");
  let b = addStage(addStage(base())); // Start, Done, Stage 3, Stage 4
  b = setTask(addTask(addTask(b, 0), 0), 0, 1, { title: "Second" });
  b = setTask(b, 0, 2, { title: "Third" });
  assert.deepEqual(b.stages[0].tasks.map((t) => t.title), ["Gather documents", "Second", "Third"]);
  assert.deepEqual(moveTaskTo(b, { si: 0, ti: 2 }, { si: 0, ti: 0 }).stages[0].tasks.map((t) => t.title), ["Third", "Gather documents", "Second"]);
  assert.deepEqual(moveTaskTo(b, { si: 0, ti: 0 }, { si: 0, ti: 3 }).stages[0].tasks.map((t) => t.title), ["Second", "Third", "Gather documents"], "dropped past the end");
  const across = moveTaskTo(b, { si: 0, ti: 1 }, { si: 2, ti: 0 });
  assert.deepEqual([across.stages[0].tasks.map((t) => t.title), (across.stages[2].tasks || []).map((t) => t.title)], [["Gather documents", "Third"], ["Second"]]);
  assert.equal(moveTaskTo(b, { si: 0, ti: 1 }, { si: 0, ti: 1 }), b, "dropped where it was: nothing changes");
  const emptied = moveTaskTo(setStageGroups(b, 0, { groups: [], items: [b.stages[0].tasks[0]] }), { si: 0, ti: 0 }, { si: 1, ti: 0 });
  assert.equal(emptied.stages[0].tasks, undefined, "a stage left with no tasks has none");
  const moved = moveTaskTo(setTask(b, 0, 1, { group: "" }), { si: 0, ti: 1 }, { si: 2, ti: 0 });
  assert.equal(moved.stages[2].tasks[0].group, undefined, "a task that leaves its stage leaves its group");
  assert.deepEqual(moveStageTo(b, 3, 1).stages.map((s) => s.name), ["Start", "Stage 4", "Done", "Stage 3"]);
  assert.deepEqual(moveStageTo(b, 0, 3).stages.map((s) => s.name), ["Done", "Stage 3", "Stage 4", "Start"]);
  assert.equal(moveStageTo(b, 2, 2), b);
});
