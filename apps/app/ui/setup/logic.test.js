// The pure half of the setup screens: a field draft, what is allowed together, choices, relations, who sees a field, and the stored form.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { newDraft, nameOf, canBeUnique, checkField, addChoice, moveChoice, removeChoice, relationLines, inverseDefault, toggleRole, seesField, toDefinition, fieldSummary, buildRule, ruleWords } from "./logic.js";

const TYPES = [{ name: "contact", label: "Client", plural: "Clients" }, { name: "asset", label: "Asset", plural: "Assets" }];

test("a name for the stored field comes from the label", () => {
  assert.equal(nameOf("Date of birth"), "date_of_birth");
  assert.equal(nameOf("  Estimated value (USD) "), "estimated_value_usd");
  assert.equal(nameOf("!!"), "field");
});

test("only some kinds can be unique", () => {
  for (const k of ["text", "number", "url", "choice", "date", "datetime"]) assert.ok(canBeUnique(k), k);
  for (const k of ["money", "link", "file", "sealed", "boolean", "address"]) assert.ok(!canBeUnique(k), k);
});

test("a seal that only some people may open names who", () => {
  const d = { ...newDraft("text"), label: "SSN", sealed: true, seal: { level: "human", class: "us-ssn", reveal_roles: [], hint_allowed: false } };
  assert.match(checkField(d, [], TYPES).errors.seal, /who may/);
  assert.equal(checkField({ ...d, seal: { ...d.seal, reveal_roles: ["admin"] } }, [], TYPES).ok, true);
  assert.equal(checkField({ ...d, seal: { level: "ai", class: "free", reveal_roles: [], hint_allowed: false } }, [], TYPES).ok, true);
});

test("a draft needs a label, and no other field may carry the same name", () => {
  const siblings = [{ name: "title", label: "Title" }];
  assert.equal(checkField({ ...newDraft("text"), label: "" }, siblings, TYPES).ok, false);
  assert.match(checkField({ ...newDraft("text"), label: "Title" }, siblings, TYPES).errors.label, /already/);
  assert.equal(checkField({ ...newDraft("text"), label: "Notes" }, siblings, TYPES).ok, true);
});

test("a choice needs at least one option and no two alike", () => {
  const d = { ...newDraft("choice"), label: "Kind" };
  assert.match(checkField(d, [], TYPES).errors.options, /at least one/);
  assert.match(checkField({ ...d, options: ["A", "a"] }, [], TYPES).errors.options, /twice/);
  assert.match(checkField({ ...d, options: ["A", " "] }, [], TYPES).errors.options, /empty/);
  assert.equal(checkField({ ...d, options: ["A", "B"] }, [], TYPES).ok, true);
});

test("a link needs a target that exists", () => {
  const d = { ...newDraft("link"), label: "Owner" };
  assert.match(checkField(d, [], TYPES).errors.to, /Pick/);
  assert.match(checkField({ ...d, to: "nope" }, [], TYPES).errors.to, /Pick/);
  assert.equal(checkField({ ...d, to: "contact" }, [], TYPES).ok, true);
});

test("unique is refused on a kind that cannot hold it; hidden and required do not go together", () => {
  assert.match(checkField({ ...newDraft("money"), label: "Fee", unique: true }, [], TYPES).errors.unique, /cannot/);
  assert.match(checkField({ ...newDraft("text"), label: "Ref", required: true, hidden: true }, [], TYPES).errors.hidden, /required/);
  assert.match(checkField({ ...newDraft("text"), label: "Ref", required: true, required_if: 'plan == "Trust"' }, [], TYPES).errors.required_if, /either/);
});

test("choices: add, move and remove keep them unique and non-blank", () => {
  assert.deepEqual(addChoice(["A"], " B "), ["A", "B"]);
  assert.deepEqual(addChoice(["A"], "a"), ["A"]);
  assert.deepEqual(addChoice(["A"], "  "), ["A"]);
  assert.deepEqual(moveChoice(["A", "B", "C"], 2, -1), ["A", "C", "B"]);
  assert.deepEqual(moveChoice(["A", "B"], 0, -1), ["A", "B"]);
  assert.deepEqual(removeChoice(["A", "B"], 0), ["B"]);
});

test("a relation is said from both sides", () => {
  const owner = { label: "Asset", plural: "Assets" }, target = { label: "Client", plural: "Clients" };
  assert.equal(inverseDefault(owner), "Assets");
  assert.deepEqual(relationLines(owner, target, false, "Assets"), ["Each Asset belongs to one Client.", "A Client can have many Assets, shown as Assets on the Client."]);
  assert.deepEqual(relationLines(owner, target, true, "Assets"), ["Each Asset can link to many Clients.", "A Client can be on many Assets, shown as Assets on the Client."]);
  assert.deepEqual(relationLines(owner, target, false, ""), ["Each Asset belongs to one Client.", "The Client does not show its Assets."]);
});

test("who sees a field: a role in hidden_from never does", () => {
  assert.deepEqual(toggleRole([], "paralegal"), ["paralegal"]);
  assert.deepEqual(toggleRole(["paralegal"], "paralegal"), []);
  assert.equal(seesField({ hidden_from: ["paralegal"] }, "paralegal"), false);
  assert.equal(seesField({ hidden_from: ["paralegal"] }, "attorney"), true);
  assert.equal(seesField({ hidden: true, hidden_from: [] }, "attorney"), false);
});

test("the stored form leaves out what is off or empty", () => {
  const d = { ...newDraft("choice"), label: "Kind", options: ["Home", "Account"], required: true };
  assert.deepEqual(toDefinition(d), { name: "kind", kind: "choice", label: "Kind", required: true, options: ["Home", "Account"] });
  const l = { ...newDraft("link"), label: "Owner", to: "contact", many: true, inverse: "Assets", hidden_from: ["paralegal"], description: "Who holds it" };
  assert.deepEqual(toDefinition(l), { name: "owner", kind: "link", label: "Owner", description: "Who holds it", to: "contact", many: true, inverse: { name: "assets", label: "Assets" }, hidden_from: ["paralegal"] });
  assert.equal("unique" in toDefinition({ ...newDraft("money"), label: "Fee", unique: true }), false);
});

test("a sealed field is stored as sealed and keeps no value rules", () => {
  const d = { ...newDraft("text"), label: "SSN", sealed: true, unique: true, hidden_from: ["paralegal"] };
  assert.deepEqual(toDefinition(d), { name: "ssn", kind: "sealed", label: "SSN", hidden_from: ["paralegal"] });
  assert.equal(fieldSummary({ kind: "text", sealed: true }, TYPES), "Sealed");
});

test("a field is summed up in a line", () => {
  assert.equal(fieldSummary({ kind: "choice", options: ["A", "B", "C"], required: true, unique: false }, TYPES), "Choice, 3 options, required");
  assert.equal(fieldSummary({ kind: "link", to: "contact", many: false }, TYPES), "Link to Client");
  assert.equal(fieldSummary({ kind: "link", to: "contact", many: true }, TYPES), "Links to many Clients");
  assert.equal(fieldSummary({ kind: "text", unique: true, hidden_from: ["paralegal"] }, TYPES), "Text, unique, hidden from 1 role");
});

test("a rule is built from a pick and written in the Expression language", () => {
  assert.equal(buildRule({ field: "plan", op: "is", value: "Trust" }), 'plan == "Trust"');
  assert.equal(buildRule({ field: "plan", op: "is_not", value: "Will" }), 'plan != "Will"');
  assert.equal(buildRule({ field: "trust_name", op: "filled" }), "not empty(trust_name)");
  assert.equal(buildRule({ field: "", op: "is", value: "x" }), "");
  assert.equal(ruleWords({ field: "plan", op: "is", value: "Trust" }, "Plan"), "Plan is Trust");
  assert.equal(ruleWords({ field: "trust_name", op: "filled" }, "Trust name"), "Trust name is filled in");
});
