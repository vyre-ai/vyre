import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { presencePrompt } from "./presence-words.js";

test("presence prompt: plain words about the item, never the tool name", () => {
  assert.equal(presencePrompt("vault.update", { name: "Juniper Drive" }), "Save Juniper Drive");
  assert.equal(presencePrompt("vault.put", { name: "OpenAI key", kind: "key" }), "Save OpenAI key");
  assert.equal(presencePrompt("vault.reveal", { name: "Gmail" }), "Show Gmail");
  assert.equal(presencePrompt("vault.delete", { name: "Old card" }), "Delete Old card");
  assert.equal(presencePrompt("vault.update", {}), "Save this on your home");
  assert.equal(presencePrompt("flows.approve", {}), "Approve the flow on your home");
  assert.equal(presencePrompt("something.odd", { name: "x" }), "Confirm this on your home");
  assert.equal(presencePrompt("", undefined), "Confirm this on your home");
  assert.equal(presencePrompt("vault.put", { name: "line\nbreak\u0000 " + "x".repeat(80) }).includes("\n"), false);
});
