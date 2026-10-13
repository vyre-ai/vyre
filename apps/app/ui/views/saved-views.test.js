// A person's own saved views: the builder's choices become a stored view (the same shape a type stores), a sidebar entry keeps it, and rendering lays it over the type.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { pinnedViews, pinList, unpinList, renameView, deleteView, reorderPinned, sharedEntry, LAYOUTS, layoutsFor, fieldChoices, filterExpr, buildView, slugify, personalEntry, personalViewsOf, withPersonalViews, canShare, MINE } from "./saved-views.js";
import { viewDefOf, viewRows } from "./logic.js";
import { holds } from "../../../../lib/expr/conditions.js";

const lead = {
  name: "lead", label: "Lead",
  fields: [
    { name: "name", label: "Name", kind: "text" },
    { name: "stage", label: "Stage", kind: "stage", options: ["New", "Qualified", "Won"] },
    { name: "source", label: "Source", kind: "choice", options: ["Web", "Referral"] },
    { name: "value", label: "Value", kind: "money" },
    { name: "call", label: "Call", kind: "datetime" },
    { name: "ssn", label: "SSN", kind: "sealed" },
    { name: "notes", label: "Notes", kind: "rich_text" },
  ],
};
const plain = { name: "note", label: "Note", fields: [{ name: "title", label: "Title", kind: "text" }] };

test("the layouts are List, Table, Board and Calendar; a type offers a board only with a stage or choice field, a calendar only with a date", () => {
  assert.deepEqual(LAYOUTS.map(l => l.id), ["list", "table", "board", "calendar"]);
  assert.deepEqual(layoutsFor(lead).filter(l => l.ok).map(l => l.id), ["list", "table", "board", "calendar"]);
  const p = layoutsFor(plain);
  assert.deepEqual(p.filter(l => l.ok).map(l => l.id), ["list", "table"]);
  assert.match(p.find(l => l.id === "board").why, /stage or choice/);
  assert.match(p.find(l => l.id === "calendar").why, /date/);
});

test("the builder offers fields by what they can do, and never a sealed one or rich text to filter on", () => {
  const c = fieldChoices(lead);
  assert.deepEqual(c.groupBy.map(f => f.name), ["stage", "source"]);
  assert.deepEqual(c.dateField.map(f => f.name), ["call"]);
  assert.ok(!c.filter.some(f => f.name === "ssn" || f.name === "notes"));
  assert.ok(!c.sort.some(f => f.name === "ssn"));
  assert.ok(!c.columns.some(f => f.name === "ssn"));
});

test("filters become one expression that holds for the right rows", () => {
  assert.equal(filterExpr([]), undefined);
  assert.equal(filterExpr([{ field: "stage", op: "is", value: "New" }]), 'stage == "New"');
  assert.equal(filterExpr([{ field: "stage", op: "isnt", value: "Won" }, { field: "value", op: "atleast", value: "100" }]), 'stage != "Won" and value >= 100');
  assert.equal(filterExpr([{ field: "call", op: "empty" }]), "empty(call)");
  assert.equal(filterExpr([{ field: "call", op: "filled" }]), "not empty(call)");
  assert.equal(filterExpr([{ field: "name", op: "is", value: 'a "q"' }]), 'name == "a \\"q\\""');
  const rows = [{ data: { stage: "New", value: 50 } }, { data: { stage: "Qualified", value: 500 } }];
  assert.equal(viewRows(rows, filterExpr([{ field: "value", op: "atleast", value: "100" }])).length, 1);
  assert.ok(holds(filterExpr([{ field: "stage", op: "is", value: "New" }]), rows[0].data));
  assert.equal(filterExpr([{ field: "stage", op: "is", value: "" }]), undefined, "a filter with no value is not a filter");
});

test("a board needs a group field and a calendar a date field, with the reason said", () => {
  const board = buildView(lead, { name: "Pipeline", layout: "board", groupBy: "stage" });
  assert.equal(board.ok, true);
  assert.deepEqual(board.view, { name: "pipeline", type: "board", label: "Pipeline", groupBy: "stage" });
  assert.match(buildView(lead, { name: "x", layout: "board" }).errors[0], /group/i);
  assert.match(buildView(lead, { name: "x", layout: "board", groupBy: "name" }).errors[0], /stage or choice/);
  const cal = buildView(lead, { name: "Calls", layout: "calendar", dateField: "call", filters: [{ field: "stage", op: "isnt", value: "Won" }] });
  assert.deepEqual(cal.view, { name: "calls", type: "calendar", label: "Calls", dateField: "call", filter: 'stage != "Won"' });
  assert.match(buildView(lead, { name: "x", layout: "calendar" }).errors[0], /date/i);
});

test("a table keeps its columns and sort; a list is the type's own columns; a name is required and unique among the person's views", () => {
  const t = buildView(lead, { name: "By value", layout: "table", columns: ["name", "value", "ssn", "nope"], sort: { field: "value", dir: "desc" } });
  assert.deepEqual(t.view.columns, ["name", "value"], "a sealed or unknown field is dropped");
  assert.deepEqual(t.view.sort, { field: "value", dir: "desc" });
  assert.equal(t.view.type, "list");
  assert.deepEqual(buildView(lead, { name: "Open", layout: "list" }).view, { name: "open", type: "list", label: "Open" });
  assert.match(buildView(lead, { name: "  ", layout: "list" }).errors[0], /name/i);
  assert.match(buildView(lead, { name: "Open", layout: "list" }, { taken: ["open"] }).errors[0], /already/);
  assert.match(buildView(lead, { name: "x", layout: "table", columns: [] }).errors[0], /column/i);
  assert.match(buildView(lead, { name: "x", layout: "list", sort: { field: "ssn" } }).errors[0], /sort/i);
});

test("slugify gives a stored name: lower case, dashes, never empty", () => {
  assert.equal(slugify(" Sales  pipeline! "), "sales-pipeline");
  assert.equal(slugify("Évènements 2026"), "evenements-2026");
  assert.equal(slugify("!!!"), "");
});

test("a personal view is one sidebar entry: hidden until pinned, its definition carried with it", () => {
  const { view } = buildView(lead, { name: "Pipeline", layout: "board", groupBy: "stage" });
  const e = personalEntry("lead", view, { icon: "board" });
  assert.deepEqual(e, { kind: "view", id: "records-lead-mine-pipeline", label: "Pipeline", href: "/u/records/lead?view=mine-pipeline", icon: "board", hidden: true, view: { type: "lead", name: "mine-pipeline", layout: "board", groupBy: "stage" } });
  assert.equal(personalEntry("lead", view, { pinned: true }).hidden, undefined);
  assert.equal(MINE, "mine-");
});

test("rendering: a person's views for a type are laid over the type's own, and name the board the person made", () => {
  const a = personalEntry("lead", buildView(lead, { name: "Pipeline", layout: "board", groupBy: "source" }).view, {});
  const b = personalEntry("lead", buildView(lead, { name: "Calls", layout: "calendar", dateField: "call" }).view, {});
  const other = personalEntry("note", buildView(plain, { name: "All", layout: "list" }).view, {});
  const mine = personalViewsOf("lead", [a, b, other, { kind: "place", id: "now" }, { kind: "view", id: "x", label: "X", href: "/u/now" }]);
  assert.deepEqual(mine.map(v => v.name), ["mine-pipeline", "mine-calls"]);
  const def = withPersonalViews({ ...lead, views: [{ name: "shared_board", type: "board", groupBy: "stage" }] }, mine);
  assert.deepEqual(def.views.map(v => v.name), ["shared_board", "mine-pipeline", "mine-calls"]);
  assert.equal(viewDefOf(def, undefined, "mine-pipeline").board.groupBy, "source");
  assert.equal(viewDefOf(def, undefined, "mine-calls").calendar.date, "call");
  assert.equal(lead.views, undefined, "the type is not edited");
});

test("a view saved against a field the type no longer has is dropped quietly when drawn", () => {
  const stale = personalEntry("lead", { name: "old", type: "board", label: "Old", groupBy: "gone" }, {});
  const def = withPersonalViews(lead, personalViewsOf("lead", [stale]));
  assert.equal(viewDefOf(def, undefined, "mine-old").board?.groupBy, "stage", "the type's own board stands");
});

test("only an owner or an admin shares a view with the space; a member saves their own", () => {
  assert.equal(canShare("owner"), true);
  assert.equal(canShare("admin"), true);
  for (const r of ["member", "guest", "", undefined, null]) assert.equal(canShare(r), false);
});

const mk = (name, over = {}) => personalEntry("lead", buildView(lead, { name, layout: "list" }).view, over);

test("the pins under Records are the person's visible records views, in list order", () => {
  const list = [{ kind: "place", id: "now" }, mk("A", { pinned: true }), mk("B"), mk("C", { pinned: true }), { kind: "view", id: "project-x", label: "X", href: "/u/project/x" }];
  assert.deepEqual(pinnedViews(list).map(e => e.label), ["A", "C"], "a saved view that is not pinned, and a pin that is not records, are not listed");
});

test("pin shows a saved view; unpin hides it but keeps it saved; a pin with no definition is taken out", () => {
  let list = [mk("A"), mk("B", { pinned: true })];
  list = pinList(list, "records-lead-mine-a");
  assert.deepEqual(pinnedViews(list).map(e => e.label), ["A", "B"]);
  list = unpinList(list, "records-lead-mine-b");
  assert.deepEqual(pinnedViews(list).map(e => e.label), ["A"]);
  assert.ok(list.some(e => e.id === "records-lead-mine-b" && e.hidden && e.view), "still saved, definition kept");
  const plain = { kind: "view", id: "records-lead", label: "Leads", href: "/u/records/lead" };
  assert.deepEqual(unpinList([plain], "records-lead"), [], "nothing saved behind it: gone");
});

test("rename changes the label and nothing else; delete removes the saved view for good", () => {
  const list = [mk("A", { pinned: true }), mk("B")];
  const r = renameView(list, "records-lead-mine-a", "  Hot leads ");
  assert.equal(r[0].label, "Hot leads");
  assert.deepEqual({ ...r[0], label: "A" }, list[0]);
  assert.equal(renameView(list, "records-lead-mine-a", "   ")[0].label, "A", "an empty name is refused");
  assert.deepEqual(deleteView(list, "records-lead-mine-a").map(e => e.id), ["records-lead-mine-b"]);
});

test("reordering moves one pin before another and leaves the rest of the sidebar alone", () => {
  const list = [{ kind: "place", id: "now" }, mk("A", { pinned: true }), mk("B", { pinned: true }), mk("C", { pinned: true })];
  const out = reorderPinned(list, "records-lead-mine-c", "records-lead-mine-a");
  assert.deepEqual(out.map(e => e.id ?? e.kind), ["now", "records-lead-mine-c", "records-lead-mine-a", "records-lead-mine-b"]);
  assert.deepEqual(reorderPinned(list, "nope", "records-lead-mine-a"), list, "an unknown pin changes nothing");
});

test("a view shared with the space is written to the type, with no personal prefix; the type holds at most 30", () => {
  const { view } = buildView(lead, { name: "Pipeline", layout: "board", groupBy: "stage" });
  const diff = sharedEntry(lead, view);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.type.views, [{ name: "pipeline", type: "board", label: "Pipeline", groupBy: "stage" }]);
  assert.equal(diff.type.name, "lead");
  const full = { ...lead, views: Array.from({ length: 30 }, (_, i) => ({ name: `v${i}`, type: "list" })) };
  assert.equal(sharedEntry(full, view).ok, false);
  assert.equal(sharedEntry({ ...lead, views: [{ name: "pipeline", type: "list" }] }, view).ok, false, "a name the type already has");
});
