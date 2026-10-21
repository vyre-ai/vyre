// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagViews, toggleTag } from "./tag-views.js";

test("tags on the rows are saved views, and picking one filters by that tag", () => {
  const rows = [{ data: { tags: JSON.stringify(["rush", "hold"]) } }, { data: { tags: JSON.stringify(["rush"]) } }, { data: {} }, { data: { tags: "nope" } }];
  const views = tagViews(rows);
  assert.deepEqual(views.map((v) => v.tag), ["rush", "hold"]);
  assert.equal(views[0].label, "#rush");
  assert.deepEqual(views[0].chip, { field: "tags", op: "contains", operand: JSON.stringify("rush") });
  const once = toggleTag([], "rush");
  assert.equal(once.length, 1);
  assert.equal(once[0].operand, JSON.stringify("rush"));
  assert.deepEqual(toggleTag(once, "rush"), []);
  assert.equal(toggleTag([{ field: "name", op: "is", operand: "Kee" }, ...once], "hold").length, 3);
});
