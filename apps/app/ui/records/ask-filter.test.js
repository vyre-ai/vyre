// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAsk } from "./ask-filter.js";

const def = { fields: [
  { name: "name", kind: "text", label: "Name" },
  { name: "role", kind: "choice", label: "Role", options: ["Client", "Lead", "Vendor"] },
  { name: "owner", kind: "actor", label: "Owner" },
  { name: "last_meeting", kind: "date", label: "Last meeting" },
  { name: "close_date", kind: "date", label: "Close date" },
] };
const now = new Date(2026, 9, 18).getTime();

test("a word that is an option becomes a filter, plural or not", () => {
  const r = parseAsk("show me clients", def, { now });
  assert.deepEqual(r.chips, [{ field: "role", op: "is", operand: "Client" }]);
  assert.equal(r.query, "");
  assert.deepEqual(r.said, ["Role is Client"]);
});

test("a day range goes on the date field the sentence names, else the usual one", () => {
  assert.deepEqual(parseAsk("leads last meeting this month", def, { now }).chips.map((c) => [c.field, c.op]), [["last_meeting", "between"], ["role", "is"]]);
  assert.deepEqual(parseAsk("this month", def, { now }).chips, [{ field: "close_date", op: "between", operand: ["2026-10-01", "2026-10-31"] }]);
});

test("my means the person field, when the caller is known", () => {
  assert.deepEqual(parseAsk("my leads", def, { now, me: "person:me" }).chips, [{ field: "owner", op: "is", operand: "person:me" }, { field: "role", op: "is", operand: "Lead" }]);
  assert.equal(parseAsk("my leads", def, { now }).chips.length, 1);
});

test("what cannot be placed stays a search, and an empty-field phrase is said to be unused", () => {
  const r = parseAsk("clients with no meeting this month", def, { now });
  assert.deepEqual(r.chips.map((c) => c.field), ["close_date", "role"]);
  assert.equal(r.unused.length, 1);
  assert.match(r.unused[0], /no meeting/);
  assert.equal(parseAsk("northwind", def, { now }).query, "northwind");
  assert.deepEqual(parseAsk("", def, { now }), { chips: [], query: "", said: [], unused: [] });
});
