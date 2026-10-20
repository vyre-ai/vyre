import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { refusal } from "../audit/model.js";
import { accessRows, eventLines, holderRows, seenRows, tabRefusal } from "./type-tabs.js";

const roles = [
  { id: "admin", name: "Admin", holders: 1, data: [{ id: "contact", access: "edit", hidden: [] }] },
  { id: "member", name: "Member", holders: 3, data: [{ id: "contact", access: "read", hidden: ["ssn"] }] },
  { id: "guest", name: "Guest", holders: 0, data: [{ id: "contact", access: "none", hidden: ["ssn"] }] },
  { id: "intake", name: "Intake", holders: 1, data: [] },
];

test("each role says its level for the type, the fields hidden from it and how many hold it", () => {
  const rows = accessRows(roles, "contact");
  assert.deepEqual(rows.map((r) => [r.name, r.level, r.sub]), [
    ["Admin", "Can edit", "1 person"],
    ["Member", "Can read", "1 field hidden · 3 people"],
    ["Guest", "No access", "0 people"],
    ["Intake", "No access", "1 person"],
  ]);
  assert.equal(rows[2].hidden, 0, "a hidden field of a type the role cannot see means nothing");
});

test("holders are the records the role rows name", () => {
  assert.deepEqual(holderRows([{ holder: "vyre://juniper/contact/c1", stage: "Active" }, { stage: "x" }], (u) => (u.endsWith("/c1") ? "Sample Person" : undefined)), [{ urn: "vyre://juniper/contact/c1", id: "c1", name: "Sample Person", stage: "Active" }]);
  assert.equal(holderRows([{ holder: "vyre://juniper/contact/c9" }])[0].name, "A record you cannot open", "never the raw id");
  assert.deepEqual(holderRows([]), []);
});

test("the log for one type: only that type's changes, newest first, a person named when known", () => {
  const ev = [
    { seq: 1, time: 10, type: "contact.created", subject: "vyre://juniper/contact/c1", actor: "person:alex@juniper" },
    { seq: 2, time: 20, type: "task.created", subject: "vyre://juniper/task/t1", actor: "person:alex@juniper" },
    { seq: 3, time: 30, type: "contact.updated", subject: "vyre://juniper/contact/c1", actor: "person:juno@juniper" },
    { seq: 4, time: 40, type: "contact.viewed", subject: "vyre://juniper/contact/c1", actor: "person:juno@juniper" },
  ];
  const lines = eventLines(ev, "contact", (id) => ({ alex: "Alex" })[id]);
  assert.deepEqual(lines.map((l) => l.title), ["Someone changed a contact", "Alex made a contact"], "an unknown person is Someone, never a piece of an id");
  assert.equal(eventLines(ev, "contact", undefined, "person")[1].title, "Someone made a person", "the type's own word when given");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].seq, 3);
});

test("refusals are in words", () => {
  assert.equal(tabRefusal("not_allowed"), "Only an owner or an admin sees this.");
  assert.equal(tabRefusal("no_such_tool"), "This server cannot show that yet. It will once it is updated.");
  assert.equal(tabRefusal("x", "Boom"), "Boom.");
  assert.doesNotMatch(tabRefusal("not_found", "no such space (spaces.list shows the ones you are in)"), /spaces\.list/);
});

test("a member whose records.audit is refused by the box reads the plain refusal and is shown no change", () => {
  const said = refusal("not_allowed", "only an owner or an admin opens the audit");
  assert.equal(said, "Only an owner or an admin opens the audit.", "the box's code becomes the plain sentence, not its raw text");
  assert.equal(tabRefusal("not_allowed"), "Only an owner or an admin sees this.");
  assert.deepEqual(eventLines(undefined, "contact"), [], "no events, no lines");
});

test("See it as: the type's labels in its order, a link by name, a sealed value as Sealed, never JSON or raw field names", () => {
  const def = { fields: [{ name: "name", label: "Name" }, { name: "company", label: "Company" }, { name: "ssn", label: "Tax number" }, { name: "vip", label: "VIP" }, { name: "tags", label: "Tags" }, { name: "budget", label: "Budget" }] };
  const data = { tags: ["a", "b"], name: "Sample Person", company: { urn: "vyre://s/organization/o1" }, ssn: "{{field:vyre://s/contact/c1#ssn}}", vip: true, budget: { amount: 500, currency: "USD" }, extra: "{}", version: 3 };
  assert.deepEqual(seenRows(def, data, (u) => (u.endsWith("/o1") ? "Sample Company" : undefined)).map((r) => [r.label, r.value]), [["Name", "Sample Person"], ["Company", "Sample Company"], ["Tax number", "Sealed"], ["VIP", "Yes"], ["Tags", "a, b"], ["Budget", "500 USD"]]);
  assert.deepEqual(seenRows(def, null), []);
  assert.equal(seenRows(def, { company: { urn: "vyre://s/organization/o9" } })[0].value, "A linked record");
});
