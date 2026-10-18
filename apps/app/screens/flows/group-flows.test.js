// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { groupFlows } from "./real-model.js";
import { test } from "node:test";
import assert from "node:assert/strict";


test("Flows group by project, Personal first, and a list with no projects is one group", () => {
  const f = (/** @type {string} */ id, /** @type {string | undefined} */ project) => ({ id, project });
  assert.deepEqual(groupFlows([f("a", "Zed"), f("b"), f("c", "Alpha"), f("d")]).map((g) => [g.name, g.rows.map((r) => r.id)]), [["Personal", ["b", "d"]], ["Alpha", ["c"]], ["Zed", ["a"]]]);
  assert.equal(groupFlows([f("x"), f("y")]).length, 1);
});
