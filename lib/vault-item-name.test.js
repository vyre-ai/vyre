import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { freeItemName, itemNameOf } from "./vault-item-name.js";

test("an account's label becomes a Vault item name of letters, digits, dot, dash and underscore", () => {
  assert.equal(itemNameOf("Work Claude"), "Work-Claude");
  assert.equal(itemNameOf("  My  key / 2 "), "My-key-2");
  assert.equal(itemNameOf("../etc/x"), "etc-x", "no path survives");
  assert.equal(itemNameOf("..."), "ai-key");
  assert.equal(itemNameOf(""), "ai-key");
  assert.equal(itemNameOf("a".repeat(300)).length, 100);
  assert.match(itemNameOf("Zoë's Codex"), /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
});

test("the first free name takes a number after it, never an item that exists", () => {
  assert.equal(freeItemName("Gmail", new Set()), "Gmail");
  assert.equal(freeItemName("Gmail", new Set(["gmail"])), "Gmail-2");
  assert.equal(freeItemName("Gmail", new Set(["gmail", "gmail-2", "gmail-3"])), "Gmail-4");
  assert.equal(freeItemName("x", new Set(["x", ...Array.from({ length: 98 }, (_, i) => `x-${i + 2}`)])), null);
});
