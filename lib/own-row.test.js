// @ts-check
// lib/own-row: a member reaches only her own hub row by name.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownRow } from "./own-row.js";

const OWNER = "per_" + "o".repeat(26), SAM = "per_" + "s".repeat(26), EVE = "per_" + "e".repeat(26);

test("a member reaches only her own hub row by name; the owner's row of the same name and another member's are not found, and the owner reaches by name as before", () => {
  const key = (/** @type {string} */ label, /** @type {string} */ person) => `${label}~${person.slice(4, 8)}`;
  const rows = new Map([["notion", { owner: null }], [key("notion", SAM), { owner: SAM }], [key("notion", EVE), { owner: EVE }]]);
  const hub = { row: (/** @type {string} */ k) => rows.get(k) || null };
  assert.equal(ownRow(hub, key, "notion", SAM), key("notion", SAM));
  assert.equal(ownRow(hub, key, "notion", EVE), key("notion", EVE));
  assert.equal(ownRow(hub, key, "notion", ""), "notion", "the owner by name");
  assert.throws(() => ownRow(hub, key, "linear", SAM), e => /** @type {any} */ (e).code === "not_found", "she has no such row");
  rows.set(key("slack", SAM), { owner: OWNER });
  assert.throws(() => ownRow(hub, key, "slack", SAM), e => /** @type {any} */ (e).code === "not_found", "a row at her key that is not hers is not hers");
});
