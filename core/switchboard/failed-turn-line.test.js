// @ts-check
// The line vyred.log gets for a failed turn says what and where and why, and never a key: another provider's error text (a CLI's stderr) is not scrubbed of one before it gets here.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { failedTurnLine } from "./translate.js";

test("a failed turn's log line names the thread, provider and model, and holds no key-shaped text", () => {
  const KEYS = ["sk-or-v1-" + "a".repeat(40), "sk-ant-api03-" + "b".repeat(40), "Bearer " + "c".repeat(40), "ghp_" + "d".repeat(36)];
  const line = failedTurnLine("01a15395-aaaa", { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }, `exited 1: stderr said ${KEYS.join(" and ")}\nsecond line`);
  assert.match(line, /^threads: 01a15395 turn failed on openrouter\/anthropic\/claude-sonnet-4\.5: exited 1: stderr said /);
  for (const k of KEYS) assert.ok(!line.includes(k.replace(/^Bearer /, "")), `no ${k.slice(0, 8)} key in the log line`);
  assert.ok(!/\n/.test(line), "one line");
  assert.ok(line.length < 300, "capped");
  assert.match(failedTurnLine("x", {}, undefined), /turn failed on claude\/default: no reason given$/);
});
