// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { liveDuplex } from "./member-live.js";

test("liveDuplex delivers frames from chat.open and closes with the stream", async () => {
  const frames = [{ type: "chat.user-message", data: { text: "hi" } }];
  let ended = false;
  const dx = await liveDuplex({
    chat: "chat_1",
    from: 0,
    openChat: async (_chat, _from, h) => {
      for (const f of frames) h.onframe(f, 1);
      return { result: { stream: "st_test", viewer: "person:p1", head: 2, floor: 0 }, close: () => { ended = true; h.onend && h.onend("done"); } };
    },
  });
  const seen = [];
  dx.onMessage((f) => seen.push(f));
  dx.send();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, 1);
  assert.equal(dx.info.head, 2);
  dx.close();
  assert.ok(ended);
});
