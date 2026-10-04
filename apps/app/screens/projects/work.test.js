import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewDefOf } from "../../../../deck/ui/view-defs.js";

const f = (name, kind, extra = {}) => ({ name, kind, label: name, ...extra });
const ENGAGEMENT = { name: "engagement", label: "Engagement", kind: "project", fields: [f("title", "text"), f("stage", "stage", { options: ["Intake", "Active"] }), f("fee", "money")] };
const PROSPECT = { name: "prospect", label: "Prospect", fields: [f("name", "text"), f("stage", "stage", { options: ["New", "Signed"] })] };

test("a type of the space's own holds work only when its definition says kind project; a stage alone is a board, not a project", () => {
  const e = viewDefOf(ENGAGEMENT), p = viewDefOf(PROSPECT);
  assert.equal(e.holdsWork, true);
  assert.deepEqual(e.board, { groupBy: "stage", card: ["title", "fee"] });
  assert.equal(p.holdsWork, undefined);
  assert.deepEqual(p.board, { groupBy: "stage", card: ["name"] });
});
