// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthLines } from "./vault-health-model.js";

test("the card says how many need attention in one calm line, and is absent when none do", () => {
  assert.equal(healthLines({ total: 0, rotate: 0, fix: 0 }), null);
  assert.deepEqual(healthLines({ total: 5, rotate: 2, fix: 3 }), { title: "5 vault items need attention", detail: "2 to rotate, 3 to fix. The Vault names each one." });
  assert.equal(healthLines({ total: 1, rotate: 1, fix: 0 })?.title, "1 vault item needs attention");
});
