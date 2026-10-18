// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { callsFromItems, flowNameOf, afterMake } from "./make-flow-model.js";

test("the assistant's Vyre tool calls, in order, are the calls; model tools, failures and non-tools are not", () => {
  const items = [
    { kind: "tool", name: "work.chat.list", input: { limit: 5 }, status: "completed" },
    { kind: "tool", name: "Read", input: { path: "a" } },
    { kind: "tool", name: "records.create", input: { type: "contact" }, status: "failed" },
    { kind: "text", name: "records.update" },
    { kind: "tool", name: "comms.mail.draft", input: { to: "a@b.example" } },
    { kind: "tool", name: "mcp__vyre__x", input: {} },
    { kind: "tool", name: "files.search" },
  ];
  assert.deepEqual(callsFromItems(items), [{ tool: "work.chat.list", input: { limit: 5 } }, { tool: "comms.mail.draft", input: { to: "a@b.example" } }, { tool: "files.search", input: {} }]);
  assert.equal(callsFromItems(Array.from({ length: 60 }, () => ({ kind: "tool", name: "a.b" }))).length, 40, "at most 40");
});

test("the name is the thread's title, shortened; the answer opens the draft or says why not", () => {
  assert.equal(flowNameOf("  Spring   launch email "), "Spring launch email");
  assert.equal(flowNameOf(""), "Flow from a chat");
  assert.deepEqual(afterMake({ ok: true, id: "flw_1" }), { open: "/u/flows/flw_1" });
  assert.deepEqual(afterMake({ ok: false, errors: [{ message: "none of those calls can be a step of a Flow" }] }), { say: "That did not become a Flow: none of those calls can be a step of a Flow." });
  assert.deepEqual(afterMake(null), { say: "That did not become a Flow." });
});
