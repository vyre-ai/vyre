import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tableFromRecords, cellOf } from "./records-table.js";
import { validateScreen } from "../../../../lib/views/blocks.js";

const SECRET = "123-45-6789";
const def = {
  name: "contact", label: "Contact", fields: [
    { name: "name", label: "Name", kind: "text" }, { name: "role", label: "Role", kind: "choice", options: ["Client", "Referrer"] },
    { name: "fee", label: "Retainer", kind: "money" }, { name: "ssn", label: "SSN", kind: "sealed" }, { name: "idnum", label: "ID", kind: "text", seal: true },
    { name: "firm", label: "Firm", kind: "link", to: "org" }, { name: "owner", label: "Owner", kind: "actor" },
  ],
  // the type's own stored list view decides the columns and the sort (a type the built-in table does not know)
  views: [{ name: "all", type: "list", columns: ["role", "fee", "ssn", "idnum", "firm", "owner"], sort: { field: "name" } }],
};
const env = { actors: [{ id: "a1", name: "Lee Park", family: "person" }], links: { "urn:o/1": { title: "Northwind", type: "org" } } };
const rec = (i, extra = {}) => ({ id: `c${i}`, urn: `urn:c/${i}`, data: { name: `Dana ${i}`, role: "Client", fee: 2500 + i, ssn: { sealed: "ssn", ref: `vault://secret/${i}` }, idnum: SECRET, firm: { urn: "urn:o/1" }, owner: "a1", ...extra } });

test("typed cells: each field kind becomes a typed cell with its sort key, links and people resolved", () => {
  const f = (n) => def.fields.find(x => x.name === n);
  assert.deepEqual(cellOf(f("role"), rec(1), env), { k: "choice", v: "Client", s: cellOf(f("role"), rec(1), env).s });
  assert.equal(cellOf(f("fee"), rec(1), env).k, "money");
  assert.deepEqual(cellOf(f("firm"), rec(1), env).link, { title: "Northwind", type: "org" });
  assert.deepEqual(cellOf(f("owner"), rec(1), env).who, { id: "a1", name: "Lee Park", family: "person" });
  assert.deepEqual(cellOf(f("role"), rec(1, { role: null }), env), { k: "choice" }, "an empty value is an empty cell");
});

test("typed cells: a sealed value never enters the content, whatever way the field is sealed, and the language refuses a sealed cell that carries one", () => {
  const { content, props } = tableFromRecords(def, [rec(1), rec(2)], { env });
  const text = JSON.stringify({ content, props });
  assert.ok(!text.includes(SECRET), "a field sealed by its definition: the value is not in the block");
  assert.ok(!text.includes("vault://secret"), "a seal reference is not in the block either");
  assert.deepEqual(content.rows[0].cells.ssn, { k: "sealed", on: true });
  assert.deepEqual(content.rows[0].cells.idnum, { k: "sealed", on: true });
  assert.deepEqual(tableFromRecords(def, [rec(3, { ssn: null })], { env }).content.rows[0].cells.ssn, { k: "sealed", on: false });
  // a sealed column cannot be sorted by: its sort key would leak order
  assert.equal(content.columns.find(c => c.id === "ssn").sort, false);
  const screen = { v: 2, layout: { block: "t" }, blocks: { t: { type: "table", content } } };
  assert.deepEqual(validateScreen(screen), []);
  const leaky = JSON.parse(JSON.stringify(screen));
  leaky.blocks.t.content.rows[0].cells.ssn = { k: "sealed", on: true, v: SECRET };
  assert.match(validateScreen(leaky).join("\n"), /a sealed cell carries only \{ k: "sealed", on \}, never the value/);
});

test("typed cells: the table has the title first, the line and money for a phone, and the sort and filter the view names", () => {
  const { content, props } = tableFromRecords(def, [rec(1), rec(2)], { env });
  assert.deepEqual(content.columns.map(c => [c.id, c.role]), [["_title", "title"], ["role", "line"], ["fee", "end"], ["ssn", "col"], ["idnum", "col"], ["firm", "line"], ["owner", "col"]]);
  assert.equal(props.sort, "_title", "sorted by the title field, which is the first column");
  assert.equal(content.total, 2);
  assert.deepEqual(content.columns.find(c => c.id === "role").options, ["Client", "Referrer"]);
  assert.equal(content.rows[0].cells._title.v, "Dana 1");
  assert.equal(content.rows[0].cells._title.initials, true, "Contact is a person-like type: a tile of initials before the name");
});

// The order is the list view's: the same records through the old pipeline (filterRows, sortRows over the record) and the new one (the cells' own sort keys) come out in the same order,
// for every sortable column, both directions, with and without a filter, with empty values and ties in the data.
import { filterRows, viewRows, val, fieldOf } from "./logic.js";
import { sortRows } from "../fields/logic.js";
import { orderRows } from "./records-table.js";

test("typed cells: sorting and filtering give the order the list view gave, for every column, both ways, with and without a filter", () => {
  const people = ["Zed", "amy", "Bo", "Cy", "Di", "Ed"];
  const odef = {
    name: "matter", label: "Matter", fields: [
      { name: "title", label: "Title", kind: "text" }, { name: "stage", label: "Stage", kind: "stage", options: ["Intake", "Signing", "Closed"] }, { name: "fee", label: "Fee", kind: "money" },
      { name: "client", label: "Client", kind: "link", to: "contact" }, { name: "due", label: "Due", kind: "date" }, { name: "owner", label: "Owner", kind: "actor" }, { name: "kind", label: "Kind", kind: "choice", options: ["A", "B"] },
    ],
    views: [{ name: "all", type: "list", columns: ["stage", "fee", "client", "due", "owner", "kind"], sort: { field: "title" } }],
  };
  const e2 = { actors: [{ id: "a1", name: "Lee" }, { id: "a2", name: "Ann" }], links: Object.fromEntries(people.map((p, i) => [`urn:c/${i}`, { title: p, type: "contact" }])) };
  const recs = people.flatMap((p, i) => [0, 1].map(j => ({ id: `m${i}${j}`, urn: `urn:m/${i}${j}`, version: 1, data: {
    title: `${p} ${j ? "estate" : "trust"}`, stage: ["Intake", "Signing", "Closed", null][(i + j) % 4], fee: j && i === 2 ? null : (i % 3) * 1000 + 500, client: { urn: `urn:c/${(i + 2) % 6}` }, due: i === 4 ? null : `2026-1${i % 3}-0${1 + j}`, owner: ["a1", "a2", null][i % 3], kind: ["A", "B"][(i + j) % 2] } })));
  const { content } = tableFromRecords(odef, recs, { env: e2 });
  const cols = content.columns.filter(c => c.sort);
  assert.ok(cols.length >= 6);
  for (const filters of [{}, { stage: new Set(["Signing"]) }, { stage: new Set(["Intake", "Closed"]), kind: new Set(["A"]) }]) {
    for (const c of cols) for (const desc of [false, true]) {
      const f = c.id === "_title" ? fieldOf(odef, "title") : fieldOf(odef, c.id);
      const kept = filterRows(viewRows(recs, undefined), filters);
      const old = sortRows(kept, r => val(r, f.name), f.kind, { def: f, actors: e2.actors, links: e2.links }, desc).map(r => r.id);
      const now = orderRows(content.rows, { sort: c.id, desc, filters }).map(r => r.id);
      assert.deepEqual(now, old, `${c.id} ${desc ? "desc" : "asc"} ${Object.keys(filters).join("+") || "no filter"}`);
    }
  }
});
