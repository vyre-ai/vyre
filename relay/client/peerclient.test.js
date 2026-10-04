import { test } from "node:test";
import assert from "node:assert/strict";
import { peerSession } from "../../core/wink/node/peer-wire.js";
import { peerClient } from "./peerclient.js";

/** A server session (the real peer-wire) on one end of an in-memory pair, the Buffer-free client on the other. */
function pair(serve) {
  const stream = { ondata() {}, onend() {}, onreset() {}, write(b) { queueMicrotask(() => pipe.ondata(Buffer.from(b))); }, end() {} };
  const pipe = { ondata() {}, onclose() {}, buffered: () => 0, write(b) { queueMicrotask(() => stream.ondata(new Uint8Array(b))); }, end() {}, destroy() {} };
  peerSession(pipe, { first: 2, serve });
  return peerClient(stream);
}
test("peerclient speaks the real peer wire: a call, an error, and a message larger than a slice both ways", async () => {
  const c = pair(async (tool, input) => { if (tool === "boom") throw Object.assign(new Error("no"), { code: "denied" }); return { tool, echo: input }; });
  assert.deepEqual(await c.call("a.b", { x: 1 }), { tool: "a.b", echo: { x: 1 } });
  await assert.rejects(() => c.call("boom"), e => e.code === "denied" && e.message === "no");
  const big = "é".repeat(100_000);
  assert.equal((await c.call("big", { big })).echo.big, big);
  c.close();
  await assert.rejects(() => c.call("a"), e => e.code === "unreachable");
});
