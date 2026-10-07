// @ts-check
// The held connection on the real peer wire (peer-wire.js sessions over an in-memory pipe pair): the device opens, the home calls back down it.
import "../../../scripts/mac-test-guard.mjs";
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

test("a connection a NAT dropped quietly: the call that finds no pong closes it and goes down the next session; a slow call with a pong is left alone", async () => {
  const holds = createHolds({ waitMs: 300, raceMs: 20, probeMs: 20, quietMs: 3_600_000 });
  const dead = { closed: false, onclose: () => {}, call: () => new Promise(() => {}), ping: async () => null, close(why) { this.closed = true; this.onclose(why); } };
  holds.onSession("device:dev_mini", dead);
  const live = { closed: false, onclose: () => {}, call: async () => ({ status: 200 }), ping: async () => 1, close() { this.closed = true; } };
  setTimeout(() => holds.onSession("device:dev_mini", live), 60);
  assert.deepEqual(await holds.linkTo("dev_mini").call("wink.storage.bridge", {}), { status: 200 });
  assert.equal(dead.closed, true, "the dead session was closed");
  const slow = { closed: false, onclose: () => {}, call: () => new Promise(r => setTimeout(() => r({ status: 200, slow: true }), 120)), ping: async () => 2, close() { this.closed = true; } };
  const h2 = createHolds({ waitMs: 300, raceMs: 20, probeMs: 20, quietMs: 3_600_000 }); h2.onSession("device:dev_x", slow);
  assert.deepEqual(await h2.linkTo("dev_x").call("t", {}), { status: 200, slow: true });
  assert.equal(slow.closed, false, "a slow call with a pong keeps its session");
  const quiet = { closed: false, onclose: () => {}, call: async () => ({}), ping: async () => null, close(why) { this.closed = true; this.onclose(why); } };
  const h3 = createHolds({ waitMs: 300, raceMs: 20, probeMs: 20, quietMs: 10 }); h3.onSession("device:dev_y", quiet);
  await new Promise(r => setTimeout(r, 30));
  await assert.rejects(() => h3.linkTo("dev_y").call("t", {}), { code: "unreachable" });
  assert.equal(quiet.closed, true, "a quiet session is pinged before a call and closed when it does not answer; nothing pings on a timer");
});

test("P-1: nothing in hold.js recurs under 60 s: a held session and a connected holdDrive create no interval, and a quiet session is pinged only before a call", async () => {
  const made = [];
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (f, ms, ...a) => { made.push(ms); return realSet(f, ms, ...a); };
  try {
    const holds = createHolds({ waitMs: 100 });
    let pings = 0;
    const s = { closed: false, onclose: () => {}, call: async () => ({ status: 200 }), ping: async () => { pings++; return 1; }, close() { this.closed = true; } };
    holds.onSession("device:dev_p", s);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(pings, 0, "an idle held session is never pinged on a timer");
    await holds.linkTo("dev_p").call("t", {});
    assert.equal(pings, 0, "a session that was not quiet is not pinged before a call either");
    const { holdDrive } = await import("./hold.js");
    const link = { closed: false, status: () => ({ state: "up" }), close() {}, ready: async () => {}, onchange() {} };
    const h = holdDrive({ connect: () => link, serve: async () => {}, space: "harlow" });
    await new Promise(r => setTimeout(r, 30));
    h.stop();
  } finally { globalThis.setInterval = realSet; }
  assert.deepEqual(made.filter(ms => ms < 60_000), [], "no recurring timer under 60 s");
  // the quiet rule: silent for quietMs, pinged once before the call
  const quietHolds = createHolds({ waitMs: 100, quietMs: 20 });
  let n = 0;
  const q = { closed: false, onclose: () => {}, call: async () => ({ status: 200 }), ping: async () => { n++; return 1; }, close() { this.closed = true; } };
  quietHolds.onSession("device:dev_q", q);
  await new Promise(r => setTimeout(r, 40));
  await quietHolds.linkTo("dev_q").call("t", {});
  assert.equal(n, 1, "one ping before the call, after the silence");
});

test("devices() lists the devices with a connection open now", async () => {
  const holds = createHolds({ waitMs: 50 });
  assert.deepEqual(holds.devices(), []);
  const { device, home } = pipePair();
  peerSession(/** @type {any} */ (device), { first: 1, serve: async () => ({}) });
  const side = peerSession(/** @type {any} */ (home), { first: 2, serve: async () => ({}) });
  holds.onSession("device:dev_mini", side);
  assert.deepEqual(holds.devices(), ["dev_mini"]);
  side.close("done");
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(holds.devices(), [], "a closed session is not listed");
});
