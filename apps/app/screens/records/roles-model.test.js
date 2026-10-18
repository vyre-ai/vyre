// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { roleChips, roleLabel } from "./roles-model.js";

test("a role with a stage reads Role then the stage", () => {
  assert.equal(roleLabel({ role: "lead", stage: "Talking" }), "Lead · Talking");
  assert.equal(roleLabel({ role: "partner" }), "Partner");
});

test("current roles come first and ended ones are marked", () => {
  const chips = roleChips([
    { role: "lead", stage: "Won", current: false, record: { urn: "vyre://s/lead/1" } },
    { role: "client", stage: "Active", current: true, record: { urn: "vyre://s/client/2" } },
  ]);
  assert.deepEqual(chips.map((c) => [c.label, c.ended, c.tone]), [["Client · Active", false, "client"], ["Lead · Won", true, "lead"]]);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(roleChips(undefined), []);
});
