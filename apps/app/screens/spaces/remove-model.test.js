import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { linkedOf, vaultPlan, offboardNames, removeWords, doneLine, tickRows } from "./remove-model.js";

const people = { people: [{ name: "Dana", fingerprint: "a b c" }, { name: "Sam", fingerprint: "d e f" }, { name: "dana", fingerprint: "g h i" }] };

test("a member linked by vault.person.of is offboarded with the removal, without a tick", () => {
  assert.deepEqual(linkedOf({ name: "Dana", verified: true }), { name: "Dana", verified: true });
  assert.deepEqual(linkedOf({ person: "Dana" }), { name: "Dana", verified: true }, "a server that does not say counts as checked");
  assert.deepEqual(linkedOf("Dana"), { name: "Dana", verified: true });
  assert.equal(linkedOf(null), null);
  assert.equal(linkedOf({ person: "" }), null);
  const plan = vaultPlan({ memberName: "Dana R.", linked: linkedOf({ name: "Dana", verified: true }), people });
  assert.deepEqual(plan, { mode: "linked", linked: "Dana", verified: true, candidates: [] });
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
  assert.deepEqual(plan, { mode: "none", linked: null, verified: true, candidates: [] });
  assert.deepEqual(offboardNames(plan, ["Dana"]), []);
  assert.match(removeWords(plan, "Eve", "Juniper Studio").body, /^No one in the Vault is linked to Eve or shares their name\. If you shared items under another name, end them in the Vault\.$/);
  const unchecked = vaultPlan({ memberName: "Eve", linked: null, people: null });
  assert.equal(unchecked.mode, "unchecked", "no vault.people answer is not the same as no people");
  assert.match(removeWords(unchecked, "Eve", "Juniper Studio").body, /^The Vault could not be checked\./);
  assert.deepEqual(offboardNames(unchecked, ["Eve"]), []);
});

test("a name collision does not offboard the wrong person: a linked different name wins and the other same-named row is not touched", () => {
  const plan = vaultPlan({ memberName: "Dana", linked: { name: "Sam", verified: true }, people });
  assert.deepEqual(offboardNames(plan, ["Dana"]), ["Sam"]);
});

test("the done line names what to rotate, and says plainly which Vault access was not ended", () => {
  assert.equal(doneLine("Dana", "Juniper Studio", { rotate: 0 }), "Dana was removed from Juniper Studio.");
  assert.match(doneLine("Dana", "Juniper Studio", { rotate: 2 }), /2 secrets they could read need a new value/);
  assert.equal(doneLine("Dana", "Juniper Studio", { rotate: 0, failed: ["Dana"] }), "Dana was removed from Juniper Studio. Vault access for Dana was not ended. End it from the Vault.");
  assert.match(doneLine("Dana", "Juniper Studio", { rotate: 1, failed: ["Dana", "dana"] }), /Vault access for Dana, dana was not ended\. End it from the Vault\..*1 secret they could read/);
});

test("a linked person whose safety words were not checked is still ended, shown ticked, and left alone only if the owner unticks it", () => {
  const plan = vaultPlan({ memberName: "Dana", linked: linkedOf({ name: "Dana", verified: false }), people });
  assert.deepEqual(plan, { mode: "linked", linked: "Dana", verified: false, candidates: [] });
  assert.deepEqual(tickRows(plan), [{ name: "Dana", label: "Dana (safety words not checked)", ticked: true }]);
  assert.deepEqual(offboardNames(plan, ["Dana"]), ["Dana"], "left ticked: ended");
  assert.deepEqual(offboardNames(plan, []), [], "unticked by the owner: left alone, and they were shown it");
  assert.equal(removeWords(plan, "Dana", "Juniper Studio").choose, "Also end their Vault sharing:");
  assert.deepEqual(tickRows(vaultPlan({ memberName: "Dana", linked: linkedOf({ name: "Dana", verified: true }), people })), [], "a checked link needs no tick");
  assert.deepEqual(tickRows(vaultPlan({ memberName: "Dana", linked: null, people })).map((r) => [r.name, r.ticked]), [["Dana", false], ["dana", false]]);
});
