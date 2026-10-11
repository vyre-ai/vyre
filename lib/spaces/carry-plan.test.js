// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { carryPlan, planStands } from "./carry-plan.js";

const HOME = {
  from: "spc_home", to: "spc_cloud",
  projects: [{ id: "prj_a", files: 120, bytes: 3 * 1024 ** 3, records: 40, chats: 6 }, { id: "prj_b", files: 4, bytes: 5000, records: 2, chats: 0 }],
  flows: [{ id: "f1", name: "Intake letter", on: true, versions: 3 }, { id: "f2", name: "Weekly digest", on: false }],
  agents: [{ name: "assistant" }, { name: "kit" }],
  vault: [{ name: "gmail-login" }, { name: "stripe-key" }],
};

test("the plan counts every kind and says it in plain words, with the Flow re-approval rule", () => {
  const p = carryPlan(HOME);
  assert.deepEqual(p.counts, { projects: 2, files: 124, bytes: 3 * 1024 ** 3 + 5000, records: 42, chats: 6, flows: 2, flowsOn: 1, agents: 2, vault: 2 });
  assert.equal(p.lines.length, 4);
  assert.match(p.lines[0], /^2 projects, with 124 files \(3\.0 GB\), 42 records and 6 chats$/);
  assert.match(p.lines[1], /2 Flows: 1 was turned on here, and you say yes to it again in the Cloud \(nothing runs there until you do\)/);
  assert.match(p.lines[2], /2 assistants, without grants/);
  assert.match(p.lines[3], /2 Vault items, sealed again to the Cloud's key/);
  assert.deepEqual(p.reapprove, ["Intake letter"], "the Flows that were on are named: they are re-approved, never carried over");
  assert.equal(p.ok, true);
});

test("the hash is what the person approves: any change to what moves, or where, is a different plan", () => {
  const a = carryPlan(HOME);
  assert.equal(planStands(a, carryPlan(HOME)), true);
  assert.equal(planStands(a, carryPlan({ ...HOME, vault: [...HOME.vault, { name: "new-key" }] })), false, "a Vault item added since");
  assert.equal(planStands(a, carryPlan({ ...HOME, flows: [{ id: "f1", name: "Intake letter", on: false, versions: 3 }, HOME.flows[1]] })), false, "a Flow turned off since");
  assert.equal(planStands(a, carryPlan({ ...HOME, to: "spc_other" })), false, "a different target");
  assert.equal(planStands(a, carryPlan({ ...HOME, projects: [...HOME.projects].reverse() })), true, "order does not matter");
});

test("blockers: a Vault item that cannot be sealed again, and no target, stop the plan; nothing is skipped silently", () => {
  const p = carryPlan({ ...HOME, vault: [{ name: "odd-item", resealable: false }, { name: "ok" }] });
  assert.equal(p.ok, false);
  assert.match(p.blockers[0], /1 Vault item cannot be sealed again for the Cloud \(odd-item\)/);
  assert.match(carryPlan({ ...HOME, to: "" }).blockers.join(" "), /pick where it goes/);
});

test("an empty Home says so in words, never undefined", () => {
  const p = carryPlan({ from: "a", to: "b" });
  assert.deepEqual(p.lines, ["0 projects, with 0 files (0 bytes), 0 records and 0 chats", "no Flows", "no assistants", "no Vault items"]);
  assert.equal(p.ok, true);
});
