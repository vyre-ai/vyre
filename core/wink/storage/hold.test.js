// @ts-check
// The held connection on the real peer wire (peer-wire.js sessions over an in-memory pipe pair): the device opens, the home calls back down it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { peerSession } from "../node/peer-wire.js";
import { createHolds } from "./hold.js";

function pipePair() {
  /** @type {any} */ const a = { ondata: () => {}, onclose: () => {}, buffered: () => 0 }, b = { ondata: () => {}, onclose: () => {}, buffered: () => 0 };
  let shut = false;
  const close = () => { if (shut) return; shut = true; setImmediate(() => { a.onclose("ended"); b.onclose("ended"); }); };
  a.write = (/** @type {Buffer} */ x) => setImmediate(() => b.ondata(Buffer.from(x)));
  b.write = (/** @type {Buffer} */ x) => setImmediate(() => a.ondata(Buffer.from(x)));
  a.end = b.end = a.destroy = b.destroy = close;
  return { device: a, home: b };
}

test("the device holds a session open and the home calls back on it, a big frame included, while a ping is not starved", async () => {
  const { device, home } = pipePair();
  const holds = createHolds({ waitMs: 100 });
  // the device's side: joinPeer's session answers the home's calls through `serve`
  const dev = peerSession(/** @type {any} */ (device), { first: 1, serve: async (tool, input) => ({ status: 200, echo: tool, n: input.body.length }) });
  const homeSide = peerSession(/** @type {any} */ (home), { first: 2, serve: async () => { throw new Error("the device asks nothing"); } });
  holds.onSession("device:dev_mini", homeSide);
  const big = "x".repeat(3 * 1024 * 1024);
  const call = holds.linkTo("dev_mini").call("wink.storage.bridge", { body: big });
  const rtt = await homeSide.ping(2000);
  assert.ok(rtt !== null && rtt < 2000, "a ping is answered while a 3 MB frame is in flight");
  assert.deepEqual(await call, { status: 200, echo: "wink.storage.bridge", n: big.length });
  dev.close("device gone");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(holds.has("dev_mini"), false, "a closed session is dropped");
  await assert.rejects(() => holds.linkTo("dev_mini").call("wink.storage.bridge", { body: "" }), { code: "unreachable" });
});
