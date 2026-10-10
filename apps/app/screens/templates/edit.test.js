import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blank, setName, setOpensOn, addStage, renameStage, moveStage, removeStage, setStageOwner, setMovesOn, addTask, setTask, moveTask, removeTask, addRole, setRoleAgent, setRoleLead, removeRole, doerChoices, ownerChoices, missing } from "./edit.ts";

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
  assert.deepEqual(doerChoices(b).map(([v]) => v), ["role:attorney", "person:owner"]);
  assert.deepEqual(ownerChoices(b).map(([v]) => v), ["", "role:attorney"]);
});
