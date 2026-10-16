import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { testFlowName } from "./test-flow-name.js";

test("testFlowName slugifies labels to the Flow name rule", () => {
  assert.equal(testFlowName("Options"), "options");
  assert.equal(testFlowName("All kinds"), "all_kinds");
  assert.equal(testFlowName("On refund"), "on_refund");
});

test("testFlowName matches NAME_RE used by checkFlow", () => {
  assert.match(testFlowName("Options"), /^[a-z][a-z0-9_-]{0,63}$/);
});
