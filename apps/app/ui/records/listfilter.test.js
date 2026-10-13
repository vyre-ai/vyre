// The pure half of the list header: which fields can be filtered (grouped as the type groups them), a filter chip in words and as a test, search, date presets, and a chip as a saved-view filter.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { filterableFields, chipWords, chipHolds, searchHolds, listRows, datePreset, chipsToFilters, CREATED } from "./listfilter.js";

const DEF = { name: "lead", groups: [{ name: "Deal" }], fields: [
  { name: "name", label: "Name", kind: "text" },
  { name: "stage", label: "Stage", kind: "stage", options: ["New", "Intake", "Won"], group: "Deal" },
  { name: "value", label: "Value", kind: "money", group: "Deal" },
  { name: "owner", label: "Owner", kind: "actor" },
  { name: "ssn", label: "SSN", kind: "sealed" },
  { name: "old", label: "Old", kind: "text", hidden: true },
  { name: "notes", label: "Notes", kind: "rich_text" },
  { name: "next", label: "Next step on", kind: "date" },
] };
const R = (name, stage, value, owner, next, created) => ({ id: name, created_at: created, data: { name, stage, value: { amount: value, currency: "USD" }, owner: owner ? { actor: { kind: "person", id: owner } } : null, next } });
const ROWS = [R("Doe trust", "Intake", 4800, "me1", "2026-10-14", Date.UTC(2026, 9, 12, 12)), R("Roe will", "Won", 900, "bob", "2026-11-02", Date.UTC(2026, 8, 1, 12)), R("Shah POA", "New", 1200, null, null, Date.UTC(2026, 9, 13, 12))];
const CTX = { me: "me1", now: Date.UTC(2026, 9, 13, 12) };

test("the filter menu lists the fields that can be filtered, grouped as the type groups them, plus Created", () => {
  const g = filterableFields(DEF);
  assert.deepEqual(g.map((x) => [x.group, x.fields.map((f) => f.name)]), [["", ["name", "owner", "next", CREATED.name]], ["Deal", ["stage", "value"]]]);
});

test("a chip reads as words", () => {
  assert.equal(chipWords(DEF, { field: "stage", op: "is", operand: "Intake" }, CTX), "Stage is Intake");
  assert.equal(chipWords(DEF, { field: "value", op: "gte", operand: "1000" }, CTX), "Value at least 1000");
  assert.equal(chipWords(DEF, { field: "owner", op: "is", operand: "me1" }, CTX), "Owner is you");
  assert.equal(chipWords(DEF, { field: "next", op: "between", operand: ["2026-10-12", "2026-10-18"] }, CTX), "Next step on between 2026-10-12 and 2026-10-18");
});

test("a chip holds for the rows it says", () => {
  const f = (chip) => ROWS.filter((r) => chipHolds(DEF, chip, r, CTX)).map((r) => r.id);
  assert.deepEqual(f({ field: "stage", op: "is", operand: "Intake" }), ["Doe trust"]);
  assert.deepEqual(f({ field: "stage", op: "isnot", operand: "Intake" }), ["Roe will", "Shah POA"]);
  assert.deepEqual(f({ field: "value", op: "gte", operand: "1000" }), ["Doe trust", "Shah POA"]);
  assert.deepEqual(f({ field: "owner", op: "is", operand: "me1" }), ["Doe trust"]);
  assert.deepEqual(f({ field: CREATED.name, op: "between", operand: datePreset("week", CTX.now) }), ["Doe trust", "Shah POA"]);
});

test("search finds every word in any visible field, never a sealed one", () => {
  assert.equal(searchHolds(DEF, ROWS[0], "doe intake", CTX), true);
  assert.equal(searchHolds(DEF, ROWS[0], "roe", CTX), false);
  assert.equal(searchHolds(DEF, ROWS[0], "", CTX), true);
  assert.equal(searchHolds(DEF, { id: "x", data: { name: "A", ssn: { sealed: "ssn", ref: "r" } } }, "ssn", CTX), false);
});

test("chips and search narrow together, in the order the rows came", () => {
  assert.deepEqual(listRows(DEF, ROWS, [{ field: "value", op: "gte", operand: "1000" }], "shah", CTX).map((r) => r.id), ["Shah POA"]);
  assert.equal(listRows(DEF, ROWS, [], "", CTX), ROWS);
});

test("date presets: this week runs Monday to Sunday", () => {
  assert.deepEqual(datePreset("week", Date.UTC(2026, 9, 13, 12)), ["2026-10-12", "2026-10-18"]);
  assert.deepEqual(datePreset("today", Date.UTC(2026, 9, 13, 12)), ["2026-10-13", "2026-10-13"]);
  assert.deepEqual(datePreset("month", Date.UTC(2026, 9, 13, 12)), ["2026-10-01", "2026-10-31"]);
  assert.deepEqual(datePreset("last7", Date.UTC(2026, 9, 13, 12)), ["2026-10-07", "2026-10-13"]);
});

test("chips that a saved view can hold become view filters; the rest are counted", () => {
  const r = chipsToFilters([{ field: "stage", op: "is", operand: "Intake" }, { field: "value", op: "gte", operand: "1000" }, { field: "name", op: "contains", operand: "doe" }, { field: "next", op: "before", operand: "2026-11-01" }]);
  assert.deepEqual(r.filters, [{ field: "stage", op: "is", value: "Intake" }, { field: "value", op: "atleast", value: "1000" }, { field: "next", op: "before", value: "2026-11-01" }]);
  assert.equal(r.skipped, 1);
});
