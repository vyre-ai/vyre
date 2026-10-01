// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { nearRole, editDistance, markMade, madeNow, unmark } from "./made.js";

test("nearRole: a typo, a plural or a prefix of an existing role, never the exact role", () => {
  const roles = ["design", "review", "qa"];
  assert.equal(nearRole("desgin", roles), "design");
  assert.equal(nearRole("designs", roles), "design");
  assert.equal(nearRole("des", roles), "design");
  assert.equal(nearRole("reveiw", roles), "review");
  assert.equal(nearRole("design", roles), null, "the exact role is not a near miss");
  assert.equal(nearRole("research", roles), null, "a new role stays new");
  assert.equal(nearRole("qb", roles), null, "under 3 letters never guesses");
  assert.equal(nearRole("DESGIN", roles), "design");
});

test("editDistance", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("same", "same"), 0);
});

test("made teammates are remembered by project and role until unmarked", () => {
  markMade("northwind", "design", "design-northwind");
  assert.equal(madeNow("northwind", "design")?.id, "design-northwind");
  assert.equal(madeNow("harlow", "design"), null);
  unmark("northwind", "design");
  assert.equal(madeNow("northwind", "design"), null);
});
