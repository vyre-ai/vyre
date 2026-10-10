// @ts-check
// The one outgoing scrub (core/switchboard/scrub.js): a key-shaped string in each of the four places an agent's words leave by (assistant text, a stream delta, a tool call's input, a tool's result and the
// turn's result) does not reach what persists or shows it, for any provider; everything else passes unchanged.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scrubOut } from "./scrub.js";

const KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const OPENAI = "sk-proj-" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg";

test("scrubOut: a key in assistant text, thinking, a tool call's input, a tool's result, a stream delta or the final result is removed; the shape is kept", () => {
  const msgs = [
    { type: "assistant", message: { id: "a", content: [{ type: "text", text: `my key is ${KEY}` }, { type: "thinking", thinking: `the key ${OPENAI}` }, { type: "tool_use", id: "t", name: "Bash", input: { command: `echo ${KEY}`, nested: { list: [OPENAI] } } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: `out ${KEY}` }] }, { type: "tool_result", tool_use_id: "u", content: `plain ${OPENAI}` }] } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `delta ${KEY}` } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: `think ${OPENAI}` } } },
    { type: "result", subtype: "success", result: `done ${KEY}`, total_cost_usd: 0 },
  ];
  for (const m of msgs) {
    const out = scrubOut(m);
    const s = JSON.stringify(out);
    assert.ok(!s.includes(KEY) && !s.includes(OPENAI), `a key survived in a ${m.type}: ${s.slice(0, 200)}`);
    assert.equal(out.type, m.type);
  }
  const a = scrubOut(msgs[0]);
  assert.equal(a.message.content[2].name, "Bash");
  assert.equal(a.message.content[2].id, "t");
  assert.ok(Array.isArray(a.message.content[2].input.nested.list), "the shape of a tool call's input is kept");
});

test("scrubOut: a message with no words in it, and a plain one, pass unchanged", () => {
  const init = { type: "system", subtype: "init", session_id: "s", model: "m" };
  assert.deepEqual(scrubOut(init), init);
  const plain = { type: "assistant", message: { id: "a", content: [{ type: "text", text: "nothing secret here" }] } };
  assert.deepEqual(scrubOut(plain), plain);
  assert.equal(scrubOut(null), null);
});

test("the Switchboard puts every message of every provider through scrubOut before it translates it for the record", () => {
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const at = src.indexOf("  onMessage(id, st, m) {");
  assert.ok(at > 0, "Switchboard.onMessage exists");
  const body = src.slice(at, at + 400);
  assert.ok(body.indexOf("scrubOut(m)") > 0 && body.indexOf("scrubOut(m)") < body.indexOf("translate(m"), "the scrub comes before the translation that feeds the transcript, Recall and the screen");
});
