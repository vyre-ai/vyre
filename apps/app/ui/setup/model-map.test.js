// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { iconOfType, splitTypes, subLine } from "./model-map.js";

test("two types never share a mark: each has its own icon", () => {
  assert.notEqual(iconOfType("contact"), iconOfType("communication"));
  assert.equal(iconOfType("something-new"), "records");
});

test("built-in objects are listed apart from a person's own", () => {
  const { own, builtIn } = splitTypes([{ name: "contact" }, { name: "template" }, { name: "deal" }, { name: "team-member" }, { name: "project" }]);
  assert.deepEqual(own.map((t) => t.name), ["contact", "deal"]);
  assert.deepEqual(builtIn.map((t) => t.name), ["template", "team-member", "project"]);
});

test("the line under a name folds the links in", () => {
  const labelOf = (/** @type {string} */ n) => ({ o: "Organizations", c: "Contacts", d: "Deals" })[n] || n;
  const t = { fields: 12, records: 4, label: "Contact", plural: "Contacts", links: [{ to: "o", label: "", many: false }, { to: "c", label: "", many: true }, { to: "o", label: "", many: false }] };
  assert.equal(subLine(t, labelOf), "12 fields, 4 contacts. Links to Organizations and Contacts.");
  assert.equal(subLine({ ...t, fields: 1, records: 1, links: [] }, labelOf), "1 field, 1 contact");
  assert.equal(subLine({ ...t, links: [{ to: "d", label: "", many: false }] }, labelOf), "12 fields, 4 contacts. Links to Deals.");
});
