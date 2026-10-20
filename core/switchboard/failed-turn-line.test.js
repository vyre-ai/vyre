// @ts-check
// The line vyred.log gets for a failed turn says what and where and why, and never a key: another provider's error text (a CLI's stderr) is not scrubbed of one before it gets here.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { failedTurnLine, translate } from "./translate.js";

test("a failed turn's log line names the thread, provider and model, and holds no key-shaped text", () => {
  const KEYS = ["sk-or-v1-" + "a".repeat(40), "sk-ant-api03-" + "b".repeat(40), "Bearer " + "c".repeat(40), "ghp_" + "d".repeat(36)];
  const line = failedTurnLine("01a15395-aaaa", { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }, `exited 1: stderr said ${KEYS.join(" and ")}\nsecond line`);
  assert.match(line, /^threads: 01a15395 turn failed on openrouter\/anthropic\/claude-sonnet-4\.5: exited 1: stderr said /);
  for (const k of KEYS) assert.ok(!line.includes(k.replace(/^Bearer /, "")), `no ${k.slice(0, 8)} key in the log line`);
  assert.ok(!/\n/.test(line), "one line");
  assert.ok(line.length < 300, "capped");
  assert.match(failedTurnLine("x", {}, undefined), /turn failed on claude\/default: no reason given$/);
});

test("an error result with no text gives its errors as the reason", () => {
  const r = translate({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: abc"] });
  const fin = r.events.find(e => e.type === "thread.finished");
  assert.match(String(fin && fin.payload.error), /No conversation found with session ID: abc/);
});

test("every provider's failed turn reaches the thread as its own words: an ACP agent's refusal, an API driver's plain line", () => {
  for (const why of ["Codex did not accept its sign-in (invalid key)", "OpenRouter refused the key. Check it in Settings, AI accounts.", "The model is overloaded. Try again in a minute."]) {
    const r = translate({ type: "result", subtype: "error", is_error: true, result: why, total_cost_usd: 0 });
    const fin = r.events.find(e => e.type === "thread.finished");
    assert.equal(fin && fin.payload.ok, false);
    assert.equal(fin && fin.payload.error, why);
  }
});
