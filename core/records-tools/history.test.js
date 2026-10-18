// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { actorOf, sentence, undoPlan, loggedItem, shown, LOG_KINDS } from "./history.js";

const label = (/** @type {string} */ n) => n.replace(/_/g, " ");

test("an actor is a person, or the assistant when it acted for the person", () => {
  const names = new Map([["per_a", "Dana"]]);
  assert.deepEqual(actorOf({ actor: "person:per_a@juniper" }, names), { kind: "person", id: "per_a", name: "Dana" });
  assert.deepEqual(actorOf({ actor: "person:per_a@juniper", acted_via: "assistant" }, names), { kind: "agent", id: "assistant", name: "Assistant" });
  assert.equal(actorOf({ actor: "agent:scout@juniper" }).kind, "agent");
  assert.equal(actorOf({ actor: "person:per_z@juniper" }).name, "per_z");
});

test("a change reads as one plain sentence", () => {
  assert.equal(sentence("created", "Deal", [], null, null, label), "Created the deal");
  assert.equal(sentence("removed", "Deal", [], null, null, label), "Moved to the bin");
  assert.equal(sentence("updated", "Deal", ["stage"], { stage: "Lead" }, { stage: "Qualified" }, label), "Changed stage from Lead to Qualified");
  assert.equal(sentence("updated", "Deal", ["close_date"], {}, { close_date: "2026-11-30" }, label), "Set close date to 2026-11-30");
  assert.equal(sentence("updated", "Deal", ["amount"], { amount: 5 }, { amount: null }, label), "Cleared amount");
  assert.equal(sentence("updated", "Deal", ["a", "b", "c", "d", "extra"], {}, {}, label), "Changed a, b, c and 1 more");
  assert.equal(sentence("updated", "Deal", ["extra", "weighted_value"], {}, {}, label), "Changed the record");
  assert.equal(shown({ urn: "vyre://x/contact/1" }), "a link");
  assert.equal(shown("x".repeat(80)).length, 60);
});

test("an undo writes the old values back, only while nothing touched them since", () => {
  const ev = { verb: "updated", changed: ["stage"], before: { stage: "Lead" }, after: { stage: "Qualified" } };
  assert.deepEqual(undoPlan(ev, { data: { stage: "Qualified" } }), { op: "update", patch: { stage: "Lead" } });
  assert.throws(() => undoPlan(ev, { data: { stage: "Won" } }), /changed again/);
  assert.throws(() => undoPlan(ev, null), /bin/);
  assert.deepEqual(undoPlan({ ...ev, before: {} }, { data: { stage: "Qualified" } }), { op: "update", patch: { stage: null } });
});

test("a made record is removed, a removed one comes back, and a sealed value is never written back", () => {
  assert.deepEqual(undoPlan({ verb: "created", changed: [], before: null, after: {} }, { data: {} }), { op: "remove" });
  assert.throws(() => undoPlan({ verb: "created", changed: [], before: null, after: {} }, null), /already gone/);
  assert.deepEqual(undoPlan({ verb: "removed", changed: [], before: null, after: {} }, null), { op: "restore" });
  assert.deepEqual(undoPlan({ verb: "restored", changed: [], before: null, after: {} }, { data: {} }), { op: "remove" });
  const sealed = { verb: "updated", changed: ["ssn"], before: { ssn: "{{field:vyre://x/contact/1#ssn}}" }, after: { ssn: "{{field:vyre://x/contact/1#ssn}}" } };
  assert.throws(() => undoPlan(sealed, { data: { ssn: "{{field:vyre://x/contact/1#ssn}}" } }), /sealed/);
});

test("logged calls, meetings and notes become history items; a synced message has no undo", () => {
  const who = { kind: "person", id: "per_a", name: "Dana" };
  const note = loggedItem("note", { urn: "vyre://s/note/1", data: { body: "Waiting on the contract", created: 5 } }, who);
  assert.deepEqual(note, { id: "vyre://s/note/1", kind: "note", actor: who, text: "Waiting on the contract", at: 5, undo: true });
  const call = loggedItem("communication", { urn: "vyre://s/communication/2", data: { kind: "call", at: "2026-10-18T10:00:00.000Z", excerpt: "Warmer blue" } }, who);
  assert.equal(call.kind, "call"); assert.equal(call.at, Date.parse("2026-10-18T10:00:00.000Z")); assert.equal(call.undo, true);
  assert.equal(loggedItem("communication", { urn: "u", data: { kind: "email", at: "2026-10-18", source_key: "gmail:1", subject: "Hi" } }, who).undo, false);
  assert.deepEqual(LOG_KINDS, ["call", "meeting", "note"]);
});
