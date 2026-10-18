import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, titleOf } from "./ask-model.js";

test("an @ agent name sends to that agent, anything else to the assistant", () => {
  const names = ["alex", "juno"];
  assert.deepEqual(route("@Juno what is open?", names, "alex"), { agent: "juno", text: "what is open?" });
  assert.deepEqual(route("@nobody hello", names, "alex"), { agent: "alex", text: "@nobody hello" });
  assert.deepEqual(route("  plan my day ", names, "alex"), { agent: "alex", text: "plan my day" });
  assert.deepEqual(route("@juno", names, "alex"), { agent: "alex", text: "@juno" });
});

test("the title is the first few words, cut short", () => {
  assert.equal(titleOf("what is open for the Harlow account today please"), "what is open for the Harlow");
  assert.equal(titleOf("x".repeat(80)).length, 48);
  assert.equal(titleOf("  "), "");
});
