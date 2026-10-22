import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { peerStreamDuplex } from "./peer-stream.js";

test("frames that arrive with the open answer are delivered when the chat starts listening, and a stream that already ended waits for that", async () => {
  /** @type {any} */
  let handlers;
  const duplex = await peerStreamDuplex(async (_tool, input, h) => {
    assert.equal(input.chat, "chat_1");
    assert.equal(input.from, 0);
    handlers = h;
    h.onframe({ cur: 1, type: "chat.user-message", data: { text: "kept" } });
    h.onframe({ cur: 2, type: "chat.text-delta", data: { text: "reply from the assistant" } });
    return { id: "st_1", result: { stream: "st_1", viewer: "person:ada", head: 2, floor: 1 }, close() { h.onend("client"); } };
  }, { chat: "chat_1", from: 0 });
  assert.equal(duplex.info.head, 2, "head is known before the listener is set, so a replay is not typed out");
  assert.equal(duplex.info.viewer, "person:ada");
  const got = /** @type {any[]} */ ([]);
  let closed = 0;
  duplex.onClose(() => { closed += 1; });
  duplex.onMessage((m) => got.push(m));
  assert.deepEqual(got.map((m) => m.data.text), ["kept", "reply from the assistant"]);
  assert.equal(closed, 0);
  handlers.onframe({ cur: 3, type: "chat.text-done", data: { text: "done" } });
  assert.equal(got[2].data.text, "done");
  duplex.send({ t: "subscribe" });

  const ended = await peerStreamDuplex(async (_tool, _input, h) => {
    h.onframe({ cur: 1, data: { text: "held" } });
    h.onend("ended");
    return { id: "st_2", result: { head: 4 }, close() {} };
  }, { chat: "chat_1", from: 0 });
  const got2 = /** @type {any[]} */ ([]);
  let closeSawTheFrame = false;
  ended.onClose(() => { closeSawTheFrame = got2.length === 1; });
  ended.onMessage((m) => got2.push(m));
  await new Promise((r) => queueMicrotask(r));
  assert.equal(got2.length, 1);
  assert.equal(closeSawTheFrame, true, "the close runs after the held frame is delivered");
});
