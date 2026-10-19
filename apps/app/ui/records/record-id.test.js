// A record's ID is Vyre's: no create form, import or required check offers it, and an ordinary field the owner called "ID" stays theirs.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ID_FIELD, ID_NOTE, isRecordIdField, recordIdOf } from "./record-id.js";
import { createPayload, formErrors, formOrder, guessMapping } from "./logic.js";
import { importableFields } from "./csv.js";

// A type whose ID field has lost its read_only mark (an older definition): the ID is still never an input, because it is the ID by name.
const fields = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "ref", label: "ID", kind: "text", unique: true, required: true },
  { name: "case_id", label: "Case ID", kind: "text" },
  { name: "email", label: "Email", kind: "text" },
];

test("the ID field is the one named ref, and its value reads as text", () => {
  assert.equal(ID_FIELD, "ref");
  assert.ok(isRecordIdField({ name: "ref" }));
  assert.ok(!isRecordIdField({ name: "case_id" }) && !isRecordIdField({ name: "id_number" }) && !isRecordIdField(null));
  assert.equal(recordIdOf({ data: { ref: " PER-0007 " } }), "PER-0007");
  assert.equal(recordIdOf({ data: {} }), "", "before it has one");
  assert.ok(!/[—–]/.test(ID_NOTE), "plain words");
});

test("the create form never asks for the ID, never requires it, and never sends it", () => {
  assert.deepEqual(formOrder(fields).map((f) => f.name), ["name", "case_id", "email"], "an ordinary 'Case ID' stays on the form");
  assert.deepEqual(Object.keys(formErrors(fields, { name: "Jo" })), [], "a required ID is not the person's to fill");
  assert.deepEqual(createPayload(fields, { name: "Jo", ref: "PER-0099", case_id: "77" }).plain, { name: "Jo", case_id: "77" }, "a stray value is not sent");
});

test("an import maps a sheet's ID column to an ordinary field or leaves it out, never to the record's ID", () => {
  const can = importableFields(fields);
  assert.ok(!can.some(isRecordIdField), "the ID is not importable");
  assert.equal(guessMapping(["ID", "Name"], can).ID, "", "with no ordinary ID-like field, the column is left out");
  const m = guessMapping(["Case ID", "Name"], can);
  assert.equal(m["Case ID"], "case_id", "a source ID lands in the type's own field");
  assert.equal(m.Name, "name");
});
