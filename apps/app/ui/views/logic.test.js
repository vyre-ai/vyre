// The pure half of the generated views, over the mock store's sample world: columns and grouping come from the definitions, the month grid is right,
// Seal-for-all names how many records have a value, and links resolve both ways.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMockStore } from "../../../../deck/ui/mock-store.js";
import { barPct, dashboardCards, numberOf, saysWhere, whereFn, MONTHS, ago, assistantNote, boardColumns, columnOf, fieldOf, filesOf, filterRows, isSealedField, linkIndex, listColumns, monthWeeks, newFieldSpec, relatedRecords, rowsByDay, sealSpec, stageField, startMonth, stepMonth, titleOf, urnParam, viewDefOf, viewRows, viewsOf } from "./logic.js";

const store = createMockStore({ world: "morning" });
const types = await store.types();
const byType = Object.fromEntries(await Promise.all(types.map(async (t) => [t.name, await store.list(t.name)])));
const def = (/** @type {string} */ n) => types.find((t) => t.name === n);

test("the five types are data a view can draw: every list column and board field exists", () => {
  assert.deepEqual(types.map((t) => t.name).sort(), ["contact", "matter", "project", "template", "trip"]);
  for (const t of types) {
    const vd = viewDefOf(t);
    for (const k of vd.list?.columns || []) assert.ok(fieldOf(t, k), `${t.name} list column ${k}`);
    if (vd.board) assert.ok(fieldOf(t, vd.board.groupBy), `${t.name} board field`);
    if (vd.calendar) assert.ok(fieldOf(t, vd.calendar.date), `${t.name} calendar field`);
    assert.ok(fieldOf(t, vd.titleField), `${t.name} title`);
  }
});

test("which views a type has: Matter list, board and calendar; Contact list and board; Template no calendar", () => {
  assert.deepEqual(viewsOf(def("matter")), ["list", "board", "calendar", "dashboard"]);
  assert.deepEqual(viewsOf(def("contact")), ["list", "board"]);
  assert.deepEqual(viewsOf(def("template")), ["list", "board"]);
  assert.deepEqual(viewsOf(def("project")), ["list", "board", "calendar", "dashboard"]);
  assert.deepEqual(listColumns(def("matter")).map((f) => f.name), ["client", "stage", "fee", "owner"]);
});

test("the board has a column per stage in order, and a column for rows with none", () => {
  const b = boardColumns(def("matter"), byType.matter);
  assert.deepEqual(b.columns.map((c) => c.id), ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]);
  assert.deepEqual(b.cardFields.map((f) => f.name), ["client", "fee", "owner"]);
  const some = [...byType.contact.slice(0, 1), { ...byType.contact[1], data: { ...byType.contact[1].data, role: undefined } }];
  const c = boardColumns(def("contact"), some);
  assert.equal(c.columns.at(-1).title, "No role");
  assert.equal(columnOf(c.field, some[1]), "");
  assert.equal(columnOf(c.field, some[0]), some[0].data.role);
});

test("the list filters by chips", () => {
  const rows = byType.matter, stage = (r) => r.data.stage;
  const only = filterRows(rows, { stage: new Set(["Intake"]) });
  assert.ok(only.length > 0 && only.every((r) => stage(r) === "Intake"));
  assert.equal(filterRows(rows, { stage: new Set() }).length, rows.length);
});

test("the month grid: Monday first, October 2026 starts on a Thursday and has 31 days", () => {
  const w = monthWeeks(2026, 9);
  assert.deepEqual(w[0], [null, null, null, 1, 2, 3, 4]);
  assert.equal(w.flat().filter(Boolean).length, 31);
  assert.ok(w.every((x) => x.length === 7));
  assert.deepEqual(stepMonth({ y: 2026, m: 11 }, 1), { y: 2027, m: 0 });
  assert.deepEqual(stepMonth({ y: 2026, m: 0 }, -1), { y: 2025, m: 11 });
  assert.equal(MONTHS[9], "October");
});

test("calendar: the start month is the first with a dated row from now on, and rows group by day", () => {
  const rows = byType.matter, now = new Date(2026, 9, 3).getTime();
  const ym = startMonth(rows, "closing", now);
  assert.ok(ym.y >= 2026);
  const by = rowsByDay(rows, "closing", ym);
  for (const [k, rs] of Object.entries(by)) { assert.match(k, /^\d{4}-\d{2}-\d{2}$/); assert.ok(rs.length > 0); }
  assert.deepEqual(startMonth([], "closing", now), { y: 2026, m: 9 });
});

test("Seal for all names how many records have a value", () => {
  const f = fieldOf(def("contact"), "ssn");
  const s = sealSpec(def("contact"), f, byType.contact);
  assert.match(s.title, /Seal SSN for all contacts\?/);
  assert.match(s.body, new RegExp(`^${byType.contact.filter((r) => r.data.ssn?.present).length} of ${byType.contact.length} contacts`));
  assert.equal(isSealedField(f), true);
  assert.equal(isSealedField(fieldOf(def("contact"), "name")), false);
});

test("the assistant's note says what is sealed, or that nothing is", () => {
  assert.match(assistantNote([{ label: "SSN" }, { label: "Account number" }]), /2 fields are sealed, so it sees "SSN on file, sealed", "Account number on file, sealed"/);
  assert.match(assistantNote([{ label: "SSN" }]), /1 field is sealed/);
  assert.match(assistantNote([]), /Nothing on this record is sealed/);
});

test("links resolve both ways: a matter links its client, a contact is linked from its matters", () => {
  const m = byType.matter[0], c = def("matter");
  const rel = relatedRecords(types, byType, c, m);
  assert.ok(rel.some((r) => r.type === "contact"), "the client");
  const jane = byType.contact.find((r) => r.data.name === "Jane Doe");
  const back = relatedRecords(types, byType, def("contact"), jane);
  assert.ok(back.some((r) => r.type === "matter"), "its matters");
  assert.equal(linkIndex(types, byType)[jane.urn].title, "Jane Doe");
  assert.equal(titleOf(def("contact"), jane), "Jane Doe");
});

test("files on a record are its file fields; the stage field is found", () => {
  const m = byType.matter.find((r) => r.data.docs);
  assert.ok(!m || filesOf(def("matter"), m).length === 1);
  assert.equal(stageField(def("matter")).name, "stage");
});

test("a route param is a urn or a bare id", () => {
  assert.equal(urnParam("vyre%3A%2F%2Fspc_a%2Fmatter%2F123"), "vyre://spc_a/matter/123");
  assert.equal(urnParam("vyre://spc_a/matter/123"), "vyre://spc_a/matter/123");
  assert.equal(urnParam("0199aa11-bb22"), null);
});

test("the new field spec: a link points at its own type", () => {
  assert.deepEqual(newFieldSpec({ label: " Friend ", kind: "link" }, def("contact")), { label: "Friend", kind: "link", to: "contact" });
  assert.deepEqual(newFieldSpec({ label: "Size", kind: "number" }, def("contact")), { label: "Size", kind: "number" });
});

test("event times read in plain words", () => {
  const now = new Date(2026, 9, 3, 12).getTime();
  assert.match(ago(new Date(2026, 9, 3, 9, 5).getTime(), now), /^Today, 09:05$/);
  assert.match(ago(new Date(2026, 9, 2, 9, 5).getTime(), now), /^Yesterday/);
  assert.equal(ago(new Date(2026, 9, 1).getTime(), now), "2 days ago");
  assert.equal(ago(new Date(2026, 8, 1).getTime(), now), "Sep 1");
});

test("a sealed field's edit goes through the store's putSealed, never update, and the record keeps only the reference", async () => {
  const jane = byType.contact.find((r) => r.data.name === "Jane Doe");
  await assert.rejects(store.update(jane.urn, { ssn: { sealed: "us-ssn", ref: "x", present: true, valid_format: true, set_at: 1 } }, jane.version), /sealed/i);
  const put = await store.putSealed(jane.urn, "ssn", "000-00-0000");
  assert.equal(typeof put.data.ssn.ref, "string");
  assert.ok(!JSON.stringify(put.data).includes("000-00-0000"));
  const seen = await store.seesAs(jane.urn, "assistant");
  assert.equal(seen.ssn.ref, undefined);
  assert.equal(seen.ssn.sealed, "us-ssn");
});

test("dashboard: sum keeps rows that pass where, count by has a bar per stage, funnel counts reached-or-later, recent is newest first", () => {
  const d = def("matter"), rows = byType.matter;
  const cards = dashboardCards(d, rows);
  assert.deepEqual(cards.map((c) => c.kind), ["sum", "countBy", "funnel", "recent"]);
  const open = rows.filter((r) => r.data.stage !== "Closed");
  assert.equal(cards[0].total, open.reduce((a, r) => a + numberOf(r.data.fee), 0));
  assert.equal(cards[0].title, "Fee total");
  assert.match(cards[0].hint, /, stage is not Closed$/);
  assert.deepEqual(cards[1].bars.map((b) => b[0]), ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]);
  assert.equal(cards[1].bars.reduce((a, b) => a + b[1], 0), rows.length);
  assert.deepEqual(cards[2].bars.map((b) => b[0]), ["Intake", "Engagement", "Drafting", "Signing"]);
  assert.equal(cards[2].bars[0][1], rows.length);
  for (let i = 1; i < cards[2].bars.length; i++) assert.ok(cards[2].bars[i][1] <= cards[2].bars[i - 1][1], "a funnel never grows");
  assert.ok(cards[3].rows.length <= 5);
  for (let i = 1; i < cards[3].rows.length; i++) assert.ok(cards[3].rows[i - 1].updated_at >= cards[3].rows[i].updated_at);
});

test("dashboard: a widget whose field the type lacks is skipped, a type with no widgets has none", () => {
  const d = def("matter"), vd = { plural: "Matters", titleField: "title", dashboard: { widgets: [{ kind: "sum", field: "nope" }, { kind: "recent" }] } };
  assert.deepEqual(dashboardCards(d, byType.matter, vd).map((c) => c.kind), ["recent"]);
  assert.deepEqual(dashboardCards(def("contact"), byType.contact), []);
});

test("where reads field op value; numbers compare as numbers; words say it plainly", () => {
  const rec = (data) => ({ data });
  assert.equal(whereFn("fee > 100")(rec({ fee: 250 })), true);
  assert.equal(whereFn("fee > 100")(rec({ fee: { amount: 50 } })), false);
  assert.equal(whereFn("stage = Closed")(rec({ stage: "Closed" })), true);
  assert.equal(whereFn("not a clause"), null);
  assert.equal(saysWhere("stage != Closed"), "stage is not Closed");
  assert.equal(numberOf({ amount: 12, currency: "USD" }), 12);
  assert.equal(numberOf("x"), 0);
  assert.equal(barPct(1, 4), 25);
  assert.equal(barPct(3, 0), 300);
});

test("a type's stored views decide how it is shown; the table is only the default", () => {
  const matter = def("matter");
  const table = viewDefOf(matter);
  const stored = { ...matter, views: [
    { name: "all", type: "list", columns: ["stage", "fee", "gone_field"], sort: { field: "fee", dir: "desc" }, filter: "fee >= 0" },
    { name: "by_owner", type: "board", groupBy: "stage", columns: ["owner"] },
    { name: "when", type: "calendar", dateField: "closing", filter: "fee >= 0" },
  ] };
  const vd = viewDefOf(stored);
  assert.deepEqual(vd.list.columns, ["stage", "fee"], "a column the type does not have is dropped");
  assert.equal(vd.list.sort, "fee"); assert.equal(vd.list.sortDir, "desc"); assert.equal(vd.list.filter, "fee >= 0");
  assert.deepEqual(vd.board, { groupBy: "stage", card: ["owner"] });
  assert.deepEqual(vd.calendar, { date: "closing", filter: "fee >= 0" });
  assert.equal(vd.plural, table.plural, "what a view does not say stays as the table has it");
  assert.deepEqual(viewDefOf(matter), table, "no stored views: the table, unchanged");
  assert.deepEqual(viewDefOf({ ...matter, views: [{ name: "b", type: "board", groupBy: "nope" }] }).board, table.board, "a view that names a missing field is ignored");
  // a type the table does not know takes its whole layout from what it stores
  const own = { name: "lead", label: "Lead", fields: [{ name: "name", kind: "text" }, { name: "area", kind: "choice", options: ["a", "b"] }, { name: "city", kind: "text" }], views: [{ name: "b", type: "board", groupBy: "area", columns: ["city"] }] };
  assert.deepEqual(viewDefOf(own).board, { groupBy: "area", card: ["city"] });
});

test("a stored filter keeps only the rows it holds for", () => {
  const rows = [{ data: { area: "PI", n: 1 } }, { data: { area: "EP", n: 2 } }, { data: {} }];
  assert.equal(viewRows(rows, undefined), rows, "no filter: the same rows");
  assert.deepEqual(viewRows(rows, 'area == "PI"').map((r) => r.data.n), [1]);
  assert.deepEqual(viewRows(rows, "(").length, 0, "a filter that cannot be read shows nothing rather than everything");
});
