// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldBadges, fieldKindLine } from "./logic.js";

const types = [{ name: "contact", label: "Contact", plural: "Contacts" }];

test("a field's line says what it is, with its options counted", () => {
  assert.equal(fieldKindLine({ kind: "text" }), "Text");
  assert.equal(fieldKindLine({ kind: "choice", options: ["a", "b", "c"] }), "Choice, 3 options");
  assert.equal(fieldKindLine({ kind: "text", sealed: true }), "Kept sealed");
});

test("the badges are Required, Unique, where a link goes and hidden roles, in that order", () => {
  assert.deepEqual(fieldBadges({ kind: "text", required: true, unique: true }, types), ["Required", "Unique"]);
  assert.deepEqual(fieldBadges({ kind: "link", to: "contact", required: true }, types), ["Required", "Link to Contact"]);
  assert.deepEqual(fieldBadges({ kind: "link", to: "contact", many: true }, types), ["Links to many Contacts"]);
  assert.deepEqual(fieldBadges({ kind: "text", hidden_from: ["member", "temp"] }, types), ["Hidden from 2 roles"]);
  assert.deepEqual(fieldBadges({ kind: "text" }, types), []);
});
