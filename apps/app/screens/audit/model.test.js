// @ts-check
// The audit's words: who did what in one line, the field lines with before and after, a sealed placeholder shown only as "sealed", the filters as the call's input, and the refusal in words.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { line, fieldLines, shown, inputOf, refusal, whoName } from "./model.js";

const change = (/** @type {any} */ over = {}) => ({ seq: 1, time: 1, who: "person:per_abcdef123456", verb: "updated", type: "contact", record: "vyre://s/contact/c1", changed: ["age", "ssn"], before: { age: 40, ssn: { sealed: "ssn", ref: "sv_1", present: true } }, after: { age: 41, ssn: { sealed: "ssn", ref: "sv_2", present: true } }, ...over });

test("a change reads as who did what, and each field as before to after; a sealed value is only 'sealed'", () => {
  assert.equal(line(change(), (id) => (id === "per_abcdef123456" ? "Alex" : undefined)), "Alex changed a contact");
  assert.equal(line(change({ verb: "created" })), "Person 123456 made a contact");
  assert.equal(line(change({ via: "assistant" }), () => "Alex"), "Alex (through the assistant) changed a contact");
  assert.deepEqual(fieldLines(change()), ["age: 40 to 41", "ssn: sealed to sealed"]);
  assert.deepEqual(fieldLines(change({ verb: "created", changed: ["age"] })), ["age: 41"]);
  assert.ok(!JSON.stringify(fieldLines(change())).includes("sv_"), "no reference leaks into the words");
  assert.equal(shown(null), "empty"); assert.equal(shown(["a", "b"]), "a, b"); assert.equal(shown({ amount: 250, currency: "USD" }), "250 USD"); assert.equal(shown({ urn: "vyre://s/project/rivera" }), "rivera");
});

test("filters become the call's input without blanks, and a refusal says who may open the audit", () => {
  assert.deepEqual(inputOf({ person: " per_a ", project: "", type: "contact", record: "  " }), { person: "per_a", type: "contact" });
  assert.match(refusal("not_allowed"), /owner or an admin/);
  assert.equal(refusal("x", "It broke."), "It broke.");
  assert.equal(whoName("agent:juno"), "juno");
});
