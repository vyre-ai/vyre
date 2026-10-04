// @ts-check
// Which types show under Projects on a real space: the ones the view table names, and any type that has a stage field.
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewDefOf } from "../../../../deck/ui/view-defs.js";
import { loadWork } from "../../ui/tasks/world.js";

const f = (name, kind, extra = {}) => ({ name, kind, label: name, ...extra });
const ENGAGEMENT = { name: "engagement", label: "Engagement", kind: "project", fields: [f("title", "text"), f("stage", "stage", { options: ["Intake", "Active", "Closed"] }), f("fee", "money"), f("due", "date")] };
const PROSPECT = { name: "prospect", label: "Prospect", fields: [f("name", "text"), f("stage", "stage", { options: ["New", "Called", "Signed"] })] };
const NOTE = { name: "note", label: "Note", fields: [f("title", "text"), f("body", "text")] };

test("a type of the space's own holds work only when its definition says kind project; a stage alone is a board, not a project", () => {
  const e = viewDefOf(ENGAGEMENT), n = viewDefOf(NOTE), p = viewDefOf(PROSPECT);
  assert.equal(p.holdsWork, undefined);
  assert.deepEqual(p.board, { groupBy: "stage", card: ["name"] });
  assert.equal(e.holdsWork, true);
  assert.deepEqual(e.board, { groupBy: "stage", card: ["title", "fee", "due"] });
  assert.equal(e.plural, "Engagements");
  assert.equal(n.holdsWork, undefined);
  assert.equal(n.board, undefined);
  assert.equal(viewDefOf({ name: "matter", fields: [] }).holdsWork, true, "the named table still wins");
});

test("Projects lists the records of every type that holds work, from the real types", async () => {
  const store = { list: async (/** @type {string} */ t) => (t === "engagement" ? [{ id: "e1", urn: "vyre://s/engagement/e1", data: { title: "Doe trust" } }] : [{ id: "n1" }]) };
  const world = /** @type {any} */ ({ types: new Map([["engagement", ENGAGEMENT], ["note", NOTE], ["prospect", PROSPECT]]) });
  const items = await loadWork(world, /** @type {any} */ (store));
  assert.deepEqual(items.map((x) => [x.def.name, x.row.id]), [["engagement", "e1"]]);
});
