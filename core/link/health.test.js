// @ts-check
// Connection health: the checker's one-check-a-minute cache and the reach shape, with a fake clock and a fake network.wink.status in place of the node.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHealth, describe, unknown } from "./health.js";

/** A fake ctx whose network.wink.status answers `world.st`, counting calls and holding them while `world.gate` is open. */
function fakeCtx(world) {
  const calls = [];
  return { calls, ctx: { call: async (tool, input) => { calls.push([tool, input]); if (world.gate) await world.gate; return { data: world.st }; } } };
}
const space = (o = {}) => ({ id: "home", state: "connected", path: "direct", latencyMs: 23, since: 1, peerList: [], ...o });

test("health: one real check per peer per minute, however often it is asked", async () => {
  const clock = { t: 1_000_000 };
  const world = { st: { spaces: [space()] } };
  const { ctx, calls } = fakeCtx(world);
  const h = createHealth({ ctx, now: () => clock.t });
  const first = await h.check({ stableId: "home" });
  assert.deepEqual(first, { path: "direct", relay: null, latencyMs: 23, lastHandshake: 1, online: true, checkedAt: 1_000_000, cached: false });
  assert.equal(calls.length, 1);
  clock.t += 59_999;
  const again = await h.check({ stableId: "home" });
  assert.equal(again.cached, true);
  assert.equal(again.checkedAt, 1_000_000);
  assert.equal(calls.length, 1, "no second check inside the minute");
  // A minute on, the link goes through the relay.
  clock.t += 1;
  world.st = { spaces: [space({ state: "relayed", path: "relay", latencyMs: 81 })] };
  const later = await h.check({ stableId: "home" });
  assert.deepEqual({ path: later.path, latencyMs: later.latencyMs, cached: later.cached }, { path: "relay", latencyMs: 81, cached: false });
  assert.equal(calls.length, 2);
  assert.equal(describe(later), "relayed 81 ms");
  assert.equal(describe(first), "direct 23 ms");
});

test("health: calls at the same moment share one check", async () => {
  let open = () => {};
  const world = { st: { spaces: [space({ latencyMs: 9 })] }, gate: new Promise(r => { open = () => r(undefined); }) };
  const { ctx, calls } = fakeCtx(world);
  const h = createHealth({ ctx });
  const all = Promise.all([h.check({ stableId: "home" }), h.check({ stableId: "home" }), h.check({ stableId: "home" })]);
  open();
  const got = await all;
  assert.equal(calls.length, 1);
  assert.deepEqual(got.map(x => x.cached), [false, true, true]);
  assert.ok(got.every(x => x.latencyMs === 9));
});

test("health: offline, unknown and no node all answer in the contract's shape", async () => {
  const keys = ["cached", "checkedAt", "lastHandshake", "latencyMs", "online", "path", "relay", "why"];
  const world = { st: { spaces: [space({ state: "offline", why: "the link to this space is down", path: null })] } };
  const offline = await createHealth(fakeCtx(world)).check({ stableId: "home" });
  assert.deepEqual(Object.keys(offline).sort(), keys);
  assert.equal(offline.online, false);
  assert.equal(describe(offline), "unknown");
  const missing = await createHealth(fakeCtx({ st: { spaces: [space(), space({ id: "work" })] } })).check({ stableId: "nOTHER" });
  assert.equal(missing.path, "unknown");
  assert.match(String(missing.why), /not connected to a space/);
  // A checker with nothing to read says so, in the same shape.
  const none = await createHealth().check({ stableId: "home" });
  assert.deepEqual(Object.keys(none).sort(), keys);
  assert.match(String(none.why), /no network link/);
  assert.deepEqual(Object.keys(unknown("x", 1)).sort(), keys);
});

test("health: the one reach shape, direct with its tailnet detail, and none with a reason and a fix", async () => {
  const { toReach, shaped, sinceTracker } = await import("./health.js");
  const ok = { path: "relay", relay: "fra", latencyMs: 81, lastHandshake: null, online: true, checkedAt: 1, cached: false };
  assert.deepEqual(toReach(ok, 500), { reach: "direct", why: "Connected to your server (relayed via fra 81 ms).", since: 500,
    tailnet: { path: "relay", latencyMs: 81 } });
  const down = (why, extra = {}) => ({ path: "unknown", relay: null, latencyMs: null, lastHandshake: null, online: false, checkedAt: 1, cached: false, why, ...extra });
  assert.deepEqual(toReach(down("this Mac is not paired with a box"), 7),
    { reach: "none", why: "this Mac is not paired with a box", fix: { action: "pair", label: "Pair with your server" }, since: 7 });
  assert.equal(toReach(down("the link to this space is down"), 7).fix?.action, "retry", "no fix names another program any more");
  assert.equal(toReach(down("the node is offline"), 7).fix?.action, "retry");
  assert.equal(toReach(down("say which node: a paired Mac's node id"), 7).fix, undefined);
  // The path is known but the ping went unanswered: not reachable, and the detail says what status saw.
  const quiet = toReach({ ...ok, path: "direct", latencyMs: null, why: "no answer to a ping in 3 s" }, 9);
  assert.equal(quiet.reach, "none");
  assert.deepEqual(quiet.tailnet, { path: "direct", latencyMs: null });

  // since is the start of the current reach, not of the latest check.
  const clock = { t: 100 };
  const tr = sinceTracker(() => clock.t);
  assert.equal(tr.at("box", "direct"), 100);
  clock.t = 900;
  assert.equal(tr.at("box", "direct"), 100);
  assert.equal(tr.at("box", "none"), 900);
  clock.t = 1500;
  assert.equal(tr.at("box", "direct"), 1500);
  assert.equal(tr.at("other", "direct"), 1500);

  // shaped keeps every old field beside the new ones.
  const s = shaped(ok, sinceTracker(() => 42), "k");
  assert.equal(s.path, "relay");
  assert.equal(s.latencyMs, 81);
  assert.equal(s.reach, "direct");
  assert.equal(s.since, 42);
});

test("health: with a ctx the answer is the Wink node's, by space, by connected peer, or the one space there is; the shape is the same", async () => {
  const { fromWink } = await import("./health.js");
  const st = { spaces: [
    { id: "work", state: "relayed", path: "relay", latencyMs: 84, since: 5, peerList: [{ eid: "phone1", via: "relay", since: 7 }] },
    { id: "home", state: "connected", path: "direct", latencyMs: 12, since: 6, peerList: [{ eid: "mac1", via: "direct", since: 9 }] },
  ] };
  const keys = ["cached", "checkedAt", "lastHandshake", "latencyMs", "online", "path", "relay"];
  const bySpace = fromWink(st, { stableId: "home" }, 100);
  assert.deepEqual(Object.keys(bySpace).sort(), keys);
  assert.deepEqual([bySpace.path, bySpace.latencyMs, bySpace.online], ["direct", 12, true]);
  const byPeer = fromWink(st, { stableId: "phone1" }, 100);
  assert.deepEqual([byPeer.path, byPeer.lastHandshake], ["relay", 7]);
  assert.equal(describe(byPeer), "relayed");
  assert.equal(fromWink(st, { stableId: "ghost" }, 100).online, false);
  assert.match(String(fromWink({ spaces: [{ id: "x", state: "offline", why: "no route", peerList: [] }] }, { stableId: "x" }, 1).why), /no route/);
  assert.equal(fromWink({ spaces: [{ id: "only", state: "connected", path: "direct", latencyMs: 3, peerList: [] }] }, { stableId: "anything" }, 1).latencyMs, 3);

  let asked = 0;
  const calls = [];
  const h = createHealth({ ctx: { call: async (tool, input) => { asked++; calls.push([tool, input]); return { data: st }; } }, now: () => 1 });
  const first = await h.check({ stableId: "home" });
  await h.check({ stableId: "home" });
  assert.equal(first.path, "direct");
  assert.equal(asked, 1, "one read a minute, and it is the Wink status, not the CLI");
  assert.deepEqual(calls[0][0], "network.wink.status");
  const failing = await createHealth({ ctx: { call: async () => { throw new Error("no such tool network.wink.status"); } } }).check({ stableId: "home" });
  assert.equal(failing.online, false);
  assert.match(String(failing.why), /no such tool/);
});
