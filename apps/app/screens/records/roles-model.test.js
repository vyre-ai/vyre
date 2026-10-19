// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { roleChips, roleLabel, summaryChips, toneOfColour, chipsByHolder } from "./roles-model.js";

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

test("the summary gives each role its label, stage and colour, ended ones last", () => {
  const chips = summaryChips([
    { role: "role-lead", label: "Lead", stage: "Won", current: false, color: "gray", urn: "u1" },
    { role: "role-client", label: "Client", stage: "Active", current: true, color: "green", urn: "u2" },
  ]);
  assert.deepEqual(chips.map((c) => [c.label, c.ended, c.tone]), [["Client \u00B7 Active", false, "ok"], ["Lead \u00B7 Won", true, "plain"]]);
  assert.equal(toneOfColour("red"), "err");
  assert.equal(toneOfColour("#ff0000"), "plain");
});

test("every holder's chips are worked out from the role kinds and who holds each", () => {
  const kinds = [{ role: "role-lead", label: "Lead", color: "yellow" }, { role: "role-client", label: "Client", color: "green" }];
  const byRole = {
    "role-lead": [{ holder: "a", stage: "Won", current: false }, { holder: "b", stage: "Talking", current: true }],
    "role-client": [{ holder: "a", stage: "Active", current: true }],
  };
  const m = chipsByHolder(kinds, byRole);
  assert.deepEqual(m.a, [{ label: "Client \u00B7 Active", tone: "ok", ended: false }, { label: "Lead \u00B7 Won", tone: "warn", ended: true }]);
  assert.deepEqual(m.b, [{ label: "Lead \u00B7 Talking", tone: "warn", ended: false }]);
  assert.equal(m.c, undefined);
  assert.deepEqual(chipsByHolder(undefined, undefined), {});
});
