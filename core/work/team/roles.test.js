// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { teammateFromRole, markReviewed, checkAdd, addCardData, teamCard, MAX_ASSISTANT_ADDED, isOutward } from "./roles.js";

const research = { name: "Research", instructions: "Read about the client and write what you find on the project, with sources.", templates: [{ name: "Welcome", body: "Dear {{client.name}}" }], wanted: [{ actions: ["records.read", "records.update"] }] };
const spec = () => teammateFromRole(research, { project: "vyre://spc_test/project/p1", space: "spc_test" });

test("Kit text is external and unreviewed until a person reviews it, and the card says so", () => {
  const s = spec();
  assert.equal(s.name, "research");
  assert.equal(s.instructions.labels.trust, "external");
  assert.equal(s.templates[0].labels.trust, "external");
  assert.equal(addCardData(s).unreviewed, true);
  const r = markReviewed(s, "alex");
  assert.equal(r.instructions.labels.trust, "member");
  assert.equal(r.instructions.reviewed_by, "alex");
  assert.equal(addCardData(r).unreviewed, false);
});

test("an assistant adder is capped at five per project", () => {
  const juno = { kind: "agent", id: "juno" };
  assert.equal(checkAdd({ spec: spec(), adder: juno, count: MAX_ASSISTANT_ADDED - 1 }).ok, true);
  const no = checkAdd({ spec: spec(), adder: juno, count: MAX_ASSISTANT_ADDED });
  assert.deepEqual([no.ok, no.reason], [false, "cap"]);
  assert.equal(checkAdd({ spec: spec(), adder: { kind: "person", id: "alex" }, count: 99 }).ok, true, "the cap is for assistants");
});

test("an assistant cannot add a teammate with outward powers without a person, and an unknown action counts as outward", () => {
  const outward = teammateFromRole({ name: "Intake", wanted: [{ actions: ["records.read", "email.send"] }] }, { project: "vyre://spc_test/project/p1", space: "spc_test" });
  assert.deepEqual(outward.outward, ["email.send"]);
  const juno = { kind: "agent", id: "juno" };
  assert.equal(checkAdd({ spec: outward, adder: juno, count: 0 }).reason, "needs_human");
  assert.equal(checkAdd({ spec: outward, adder: juno, count: 0, humanApproved: true }).ok, true);
  assert.equal(isOutward("mystery.do"), true);
  const odd = teammateFromRole({ name: "X", wanted: [{ actions: ["mystery.do"] }] }, { project: "p", space: "s" });
  assert.equal(checkAdd({ spec: odd, adder: juno, count: 0 }).reason, "needs_human");
});

test("a Kit role cannot smuggle control characters into its name or text", () => {
  const s = teammateFromRole({ name: "Re\nsearch\u0000", instructions: "a\u0007b" }, { project: "p", space: "s" });
  assert.doesNotMatch(s.role + s.instructions.text, /[\u0000-\u001f]/);
});

test("the team card says in plain words what each teammate may do and why", () => {
  const card = teamCard([{ name: "research", role: "Research", adder: { id: "alice" }, grants: [{ actions: ["records.read", "records.update"] }] },
    { name: "intake", role: "Intake", adder: { id: "alex" }, paused: true, grants: [{ actions: ["email.send"], conditions: { how: { presence: "fresh" } } }] }]);
  assert.equal(card[0].line, "Research can read this project and write notes and fill fields, because Alice added it.");
  assert.match(card[1].line, /send email \(each send is approved by a person\), because Alex added it\./);
  assert.match(String(card[1].note), /confirm first/);
  assert.match(String(card[1].paused_reason), /Alex no longer holds/);
});
