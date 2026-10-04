// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../../../relay/node/server.js";
import { relayLink } from "../../relay/link.js";
import { deviceSide } from "../../relay/channel.js";
import { bridge, resetPeerLimits } from "../../relay/bridge.js";
import { newRouteKey, routeId } from "../../relay/wire.js";
import { keyPair } from "../../relay/noise.js";
import { relayPeer } from "./relay-peer.js";
import { peerSession, streamPipe } from "./peer-wire.js";

/** A real relay on loopback, a real box link, and the bridge's peer door answering registry-shaped calls. */
async function world(t, { allow = () => true, space = "harlow", perMin } = {}) {
  resetPeerLimits();
  const relay = createRelay();
  const url = await relay.listen();
  const rk = newRouteKey(), route = routeId(rk.pub), box = keyPair(), dev = keyPair();
  const served = /** @type {any[]} */ ([]);
  const link = relayLink({ url, route, routeKey: rk, boxKey: box,
    admit: async pub => { if (!pub.equals(dev.pub)) throw new Error("not paired"); return { device: "srv1" }; },
    onchannel: (channel, { reply }) => bridge(channel, { handler: () => {}, caller: `device:${reply.device}`, peer: {},
      peers: { space, allow, perMin, accept: (s, who) => { peerSession(streamPipe(s), { first: 2, serve: async (tool, input) => { served.push({ who, tool, input }); return { tool, input }; } }); } } }) });
  await link.ready(5000);
  const client = relayPeer({ deviceSide, url, route, box: box.pub, keys: dev });
  t.after(async () => { client.close(); link.stop(); await relay.close(); });
  return { client, served, url, route, box };
}

test("relay-peer: a paired server opens a peer stream through a real relay and calls the home as that device", async t => {
  const w = await world(t);
  const pipe = await w.client.open("harlow");
  const s = peerSession(pipe, { first: 1 });
  assert.deepEqual(await s.call("appearance.presets", { a: 1 }), { tool: "appearance.presets", input: { a: 1 } });
  assert.deepEqual(w.served[0].who, { via: "relay", deviceId: "srv1", space: "harlow" });
  assert.ok((await s.ping()) !== null);
  s.close();
});

test("relay-peer: a wrong space is refused, an unpaired device never gets a channel, and the per-minute limit answers 429", async t => {
  const w = await world(t, { perMin: 2 });
  await assert.rejects(w.client.open("other"), e => e.code === "denied");
  const strangers = relayPeer({ deviceSide, url: w.url, route: w.route, box: w.box.pub, keys: keyPair() });
  await assert.rejects(strangers.open("harlow"), e => e.code === "unreachable");
  strangers.close();
  const a = await w.client.open("harlow");
  const b = await w.client.open("harlow");
  await assert.rejects(w.client.open("harlow"), e => e.code === "rate_limited");
  a.destroy(); b.destroy();
});

test("relay-peer: a home that allows no peer access refuses, unauthenticated for peers", async t => {
  const w = await world(t, { allow: () => false });
  await assert.rejects(w.client.open("harlow"), e => e.code === "denied");
});
