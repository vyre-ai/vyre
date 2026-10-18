import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { linkedOf, vaultPlan, offboardNames, removeWords, doneLine } from "./remove-model.js";

const people = { people: [{ name: "Dana", fingerprint: "a b c" }, { name: "Sam", fingerprint: "d e f" }, { name: "dana", fingerprint: "g h i" }] };

test("a member linked by vault.person.of is offboarded with the removal, without a tick", () => {
  assert.equal(linkedOf({ person: "Dana" }), "Dana");
  assert.equal(linkedOf("Dana"), "Dana");
  assert.equal(linkedOf(null), null);
  assert.equal(linkedOf({ person: "" }), null);
  const plan = vaultPlan({ memberName: "Dana R.", linked: "Dana", people });
  assert.deepEqual(plan, { mode: "linked", linked: "Dana", candidates: [] });
  assert.deepEqual(offboardNames(plan, []), ["Dana"]);
  assert.match(removeWords(plan, "Dana", "Juniper Studio").body, /shared Vault items, passes and emergency access ends too/);
});

test("an unlinked member with a same-named Vault person is a choice, and only what is ticked is offboarded", () => {
  const plan = vaultPlan({ memberName: "Dana", linked: null, people });
  assert.equal(plan.mode, "choose");
  assert.deepEqual(plan.candidates, ["Dana", "dana"], "both rows are offered, nothing is picked for the person");
  assert.deepEqual(offboardNames(plan, []), [], "nothing ticked, nothing offboarded");
  assert.deepEqual(offboardNames(plan, ["dana"]), ["dana"]);
  assert.deepEqual(offboardNames(plan, ["Eve"]), [], "a tick that is not a candidate is ignored");
  assert.equal(removeWords(plan, "Dana", "Juniper Studio").choose, "Also end Vault sharing with:");
});

test("no link and no same-named person: the Vault step is skipped and the sheet says so", () => {
  const plan = vaultPlan({ memberName: "Eve", linked: null, people });
  assert.deepEqual(plan, { mode: "none", linked: null, candidates: [] });
  assert.deepEqual(offboardNames(plan, ["Dana"]), []);
  assert.equal(removeWords(plan, "Eve", "Juniper Studio").body, "Eve had no shared Vault items.");
  assert.equal(vaultPlan({ memberName: "Eve", linked: null, people: null }).mode, "none", "no vault.people answer is the same as no people");
});

test("a name collision does not offboard the wrong person: a linked different name wins and the other same-named row is not touched", () => {
  const plan = vaultPlan({ memberName: "Dana", linked: "Sam", people });
  assert.deepEqual(offboardNames(plan, ["Dana"]), ["Sam"]);
});

test("the done line names what to rotate", () => {
  assert.equal(doneLine("Dana", "Juniper Studio", { rotate: 0 }), "Dana was removed from Juniper Studio.");
  assert.match(doneLine("Dana", "Juniper Studio", { rotate: 2 }), /2 secrets they could read need a new value/);
});
