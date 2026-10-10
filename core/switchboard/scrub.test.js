// @ts-check
// The one outgoing scrub (REVIEW-LEDGER 35): a key an agent prints never reaches the Switchboard's translation, in any of the four places a message carries words.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubOut } from "./scrub.js";

const KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

test("a key in an assistant text block, a tool call input, a streamed delta and a result is taken out; nothing else changes", () => {
  const text = scrubOut({ type: "assistant", message: { content: [{ type: "text", text: `the key is ${KEY}` }] } });
  assert.ok(!JSON.stringify(text).includes(KEY));
  assert.match(text.message.content[0].text, /^the key is /);
  const tool = scrubOut({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: `cat auth.json # ${KEY}`, cwd: "/w" } }] } });
  assert.ok(!JSON.stringify(tool).includes(KEY));
  assert.equal(tool.message.content[0].input.cwd, "/w", "the input keeps its shape");
  const delta = scrubOut({ type: "stream_event", event: { delta: { type: "text_delta", text: `key ${KEY}` } } });
  assert.ok(!JSON.stringify(delta).includes(KEY));
  const result = scrubOut({ type: "result", result: `done ${KEY}`, is_error: false });
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(result.is_error, false);
});

test("a message with nothing to take out is the very same object, and a message that is not one of the four is left alone", () => {
  const clean = { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  assert.equal(scrubOut(clean), clean);
  const other = { type: "system", subtype: "init", note: KEY };
  assert.equal(scrubOut(other), other);
  assert.equal(scrubOut(null), null);
});
