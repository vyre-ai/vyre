// The group writes in box-stream go to the server's stream.* tools with their inputs, through the box layer's send.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./box-stream.ts", import.meta.url), "utf8");

test("box-stream has sendGroup, keep, react, pin and markRead, each a stream.* tool through write()", () => {
  for (const [fn, tool] of [["sendGroup", "stream.send"], ["keep", "stream.keep"], ["react", "stream.react"], ["pin", "stream.pin"], ["markRead", "stream.mark-read"]]) {
    assert.match(src, new RegExp(`${fn}(Text|To|Answer|Message)?[(:]`), fn);
    assert.ok(src.includes(`"${tool}"`), tool);
  }
  assert.ok(!/fetch\(|XMLHttpRequest/.test(src), "writes never bypass the outbox");
  assert.match(src, /async function write[\s\S]*send</, "write goes through the box layer's send (outbox, Idempotency-Key)");
});

test("a refusal reads in plain words: no ids, no thread or session", async () => {
  const { reason } = await import("./reason.js");
  assert.equal(reason({ code: "bad_input", message: "no thread chat_01a10a23-bd19-4144" }), "This chat cannot be opened yet.");
  assert.equal(reason({ code: "not_found", message: "anything" }), "This chat cannot be opened yet.");
  assert.equal(reason({ code: "denied", message: "this call is not from chat_abc123 yet" }), "this call is not from yet");
  assert.equal(reason({ code: "x" }), "x");
});

test("every stream.* call names the chat, not a session (the engine's stream tools took the rename)", () => {
  for (const tool of ["stream.open", "stream.send", "stream.keep", "stream.react", "stream.pin", "stream.mark-read"]) {
    const calls = src.split("\n").filter((l) => l.includes(`"${tool}"`));
    assert.ok(calls.length, tool);
    for (const l of calls) { assert.match(l, /\{ chat: session/, `${tool}: ${l.trim().slice(0, 80)}`); assert.ok(!/\{ session[,: ]/.test(l), tool); }
  }
});
