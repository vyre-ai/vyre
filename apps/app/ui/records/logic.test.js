// The pure half of the create form, the one timeline and the import wizard.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { formOrder, formErrors, timelineOf, TIMELINE_KINDS, guessMapping, importIssues, importSummary, createPayload } from "./logic.js";

const FIELDS = [
  { name: "notes", label: "Notes", kind: "rich_text" },
  { name: "title", label: "Name", kind: "text", required: true },
  { name: "kind", label: "Kind", kind: "choice", required: true, options: ["Home", "Account"] },
  { name: "value", label: "Estimated value", kind: "money" },
  { name: "old", label: "Old", kind: "text", hidden: true },
  { name: "ssn", label: "SSN", kind: "sealed", required: true },
];

test("the create form asks for required fields first, drops hidden ones and keeps the rest in order", () => {
  assert.deepEqual(formOrder(FIELDS).map((f) => f.name), ["title", "kind", "ssn", "notes", "value"]);
});

test("a form says what is missing, by field, and leaves a sealed value to its own step", () => {
  const e = formErrors(FIELDS, { title: " ", kind: "Home" });
  assert.deepEqual(Object.keys(e), ["title"]);
  assert.equal(e.title, "Name is required.");
  assert.deepEqual(formErrors(FIELDS, { title: "A", kind: "Home" }), {});
  assert.match(formErrors(FIELDS, { title: "A", kind: "Nope" }).kind, /one of/);
});

test("the one timeline is newest first, and a kind narrows it", () => {
  const items = [{ id: "a", kind: "note", at: 1 }, { id: "b", kind: "email", at: 3 }, { id: "c", kind: "change", at: 2 }, { id: "d", kind: "call", at: 4 }];
  assert.deepEqual(timelineOf(items, "all").map((i) => i.id), ["d", "b", "c", "a"]);
  assert.deepEqual(timelineOf(items, "email").map((i) => i.id), ["b"]);
  assert.deepEqual(TIMELINE_KINDS.map((k) => k[0]), ["all", "note", "email", "call", "change"]);
});

test("a CSV header is matched to a field by name, ignoring case and punctuation", () => {
  const m = guessMapping(["Full name", "E-mail", "estimated value", "Mystery"], [{ name: "title", label: "Name" }, { name: "email", label: "Email" }, { name: "value", label: "Estimated value" }]);
  assert.deepEqual(m, { "Full name": "title", "E-mail": "email", "estimated value": "value", Mystery: "" });
});

test("two headers never map to one field", () => {
  const m = guessMapping(["Name", "name"], [{ name: "title", label: "Name" }]);
  assert.deepEqual(m, { Name: "title", name: "" });
});

test("the import preview finds the rows that would be refused", () => {
  const fields = [{ name: "title", label: "Name", kind: "text", required: true }, { name: "email", label: "Email", kind: "emails", unique: true }, { name: "value", label: "Value", kind: "number" }];
  const rows = [{ N: "A", E: "a@x.org", V: "1" }, { N: "", E: "b@x.org", V: "2" }, { N: "C", E: "a@x.org", V: "x" }];
  const issues = importIssues(rows, { N: "title", E: "email", V: "value" }, fields);
  assert.deepEqual(issues.map((i) => [i.row, i.field, i.problem]), [[2, "title", "empty"], [3, "email", "duplicate"], [3, "value", "not a number"]]);
});

test("the summary counts clean rows, rows with a problem, and unmapped columns", () => {
  const s = importSummary(5, [{ row: 2 }, { row: 2 }, { row: 4 }], { A: "x", B: "", C: "" });
  assert.deepEqual(s, { total: 5, ready: 3, flagged: 2, unmapped: 2 });
});

test("the create form leaves out what a person never types: the stage, a computed field, one a service owns", () => {
  const fs = [...FIELDS, { name: "stage", label: "Stage", kind: "stage" }, { name: "total", label: "Total", kind: "number", computed: { expr: "1" } }, { name: "state", label: "State", kind: "text", owned_by: "kernel" }];
  assert.deepEqual(formOrder(fs).map((f) => f.name), ["title", "kind", "ssn", "notes", "value"]);
});

test("a create splits what is plain from what is sealed, and drops what is empty", () => {
  const fs = [...FIELDS.filter((f) => f.name !== "old"), { name: "acct", label: "Account", kind: "text", seal: { level: "ai", class: "free" } }];
  const p = createPayload(fs, { title: " A ", kind: "Home", value: "", notes: null, ssn: "123-45-6789", acct: "9921" });
  assert.deepEqual(p.plain, { title: "A", kind: "Home" });
  assert.deepEqual(p.sealed, { ssn: "123-45-6789", acct: "9921" });
});
