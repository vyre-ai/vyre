// @ts-check
// Connection health: the ping and status parsers, and the checker's one-check-a-minute cache,
// with a fake clock and a fake `run` in place of the tailscale CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePing, peerFromStatus, createHealth, describe } from "./health.js";

const ZERO = "0001-01-01T00:00:00Z";

/** A status with the box as its one peer; `box` overrides its fields. */
const status = (box = {}) => ({
  BackendState: "Running", MagicDNSSuffix: "tail0000.ts.net",
  Self: { ID: "nMAC", HostName: "alex-mac", DNSName: "alex-mac.tail0000.ts.net.", TailscaleIPs: ["100.64.0.2"] },
  Peer: {
    "nodekey:box": { ID: "nBOX", HostName: "box", DNSName: "box.tail0000.ts.net.", TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"], Online: true,
      CurAddr: "203.0.113.7:41641", Relay: "fra", PeerRelay: "", LastHandshake: "2026-09-27T10:00:00Z", RxBytes: 1200, TxBytes: 3400, ...box },
  },
});

test("health: ping lines, direct, DERP, peer relay, and a timeout", () => {
  assert.deepEqual(parsePing("pong from box (100.64.0.5) via 203.0.113.7:41641 in 23ms\n"),
    { path: "direct", relay: null, endpoint: "203.0.113.7:41641", latencyMs: 23 });
  assert.deepEqual(parsePing("pong from box (100.64.0.5) via [2001:db8::7]:41641 in 12ms"),
    { path: "direct", relay: null, endpoint: "[2001:db8::7]:41641", latencyMs: 12 });
  assert.deepEqual(parsePing("pong from box (100.64.0.5) via DERP(fra) in 81ms"),
    { path: "relay", relay: "fra", endpoint: null, latencyMs: 81 });
  assert.deepEqual(parsePing("pong from box (100.64.0.5) via peer-relay(198.51.100.4:7777:vni:3) in 30ms"),
    { path: "peer-relay", relay: null, endpoint: "198.51.100.4:7777", latencyMs: 30 });
  assert.equal(parsePing("pong from box (100.64.0.5) via DERP(nyc) in 1.2s").latencyMs, 1200);
  const none = { path: "unknown", relay: null, endpoint: null, latencyMs: null };
  assert.deepEqual(parsePing("timeout waiting for ping reply\n"), none);
  assert.deepEqual(parsePing("ping \"100.64.0.5\" timed out\n"), none);
  assert.deepEqual(parsePing(""), none);
});

test("health: a peer from status, by stable id or address, with its path and handshake", () => {
  const direct = peerFromStatus(status(), { stableId: "nBOX" });
  assert.deepEqual(direct, { online: true, path: "direct", relay: null, endpoint: "203.0.113.7:41641", ip: "100.64.0.5",
    lastHandshake: Date.parse("2026-09-27T10:00:00Z"), rx: 1200, tx: 3400 });
  assert.equal(peerFromStatus(status(), { ip: "100.64.0.5" })?.path, "direct");
  const relayed = peerFromStatus(status({ CurAddr: "" }), { stableId: "nBOX" });
  assert.equal(relayed?.path, "relay");
  assert.equal(relayed?.relay, "fra");
  assert.equal(peerFromStatus(status({ CurAddr: "", PeerRelay: "198.51.100.4:7777" }), { stableId: "nBOX" })?.path, "peer-relay");
  assert.equal(peerFromStatus(status({ CurAddr: "", Relay: "" }), { stableId: "nBOX" })?.path, "unknown");
  // Never shook hands: the zero time is null, not year one.
  assert.equal(peerFromStatus(status({ LastHandshake: ZERO }), { stableId: "nBOX" })?.lastHandshake, null);
  assert.equal(peerFromStatus(status(), { stableId: "nOTHER" }), null);
  assert.equal(peerFromStatus(status(), {}), null);
  assert.equal(peerFromStatus({}, { stableId: "nBOX" }), null);
});

/** A fake `run`: answers status and ping from `world`, and counts calls. */
function fakeRun(world) {
  const calls = [];
  const run = async args => {
    calls.push(args[0]);
    if (world.gate) await world.gate;
    if (args[0] === "status") return { code: 0, out: JSON.stringify(world.status), err: "" };
    if (args[0] === "ping") return world.ping ? { code: 0, out: world.ping, err: "" } : { code: 1, out: "", err: "timeout waiting for ping reply" };
    return { code: 1, out: "", err: "unexpected" };
  };
  return { run, calls };
}

test("health: one real check per peer per minute, however often it is asked", async () => {
  const clock = { t: 1_000_000 };
  const world = { status: status(), ping: "pong from box (100.64.0.5) via 203.0.113.7:41641 in 23ms" };
  const { run, calls } = fakeRun(world);
  const h = createHealth({ run, now: () => clock.t });
  const first = await h.check({ stableId: "nBOX" });
  assert.deepEqual(first, { path: "direct", relay: null, latencyMs: 23, lastHandshake: Date.parse("2026-09-27T10:00:00Z"), online: true, checkedAt: 1_000_000, cached: false });
  assert.deepEqual(calls, ["status", "ping"]);
  clock.t += 59_999;
  const again = await h.check({ stableId: "nBOX" });
  assert.equal(again.cached, true);
  assert.equal(again.checkedAt, 1_000_000);
  assert.equal(calls.length, 2, "no second check inside the minute");
  // A minute on, the peer went through a relay.
  clock.t += 1;
  world.status = status({ CurAddr: "" });
  world.ping = "pong from box (100.64.0.5) via DERP(fra) in 81ms";
  const later = await h.check({ stableId: "nBOX" });
  assert.deepEqual({ path: later.path, relay: later.relay, latencyMs: later.latencyMs, cached: later.cached }, { path: "relay", relay: "fra", latencyMs: 81, cached: false });
  assert.equal(calls.length, 4);
  assert.equal(describe(later), "relayed via fra 81 ms");
  assert.equal(describe(first), "direct 23 ms");
});

test("health: calls at the same moment share one check", async () => {
  let open = () => {};
  const world = { status: status(), ping: "pong from box (100.64.0.5) via 203.0.113.7:41641 in 9ms", gate: new Promise(r => { open = () => r(undefined); }) };
  const { run, calls } = fakeRun(world);
  const h = createHealth({ run });
  const all = Promise.all([h.check({ stableId: "nBOX" }), h.check({ stableId: "nBOX" }), h.check({ stableId: "nBOX" })]);
  open();
  const got = await all;
  assert.deepEqual(calls, ["status", "ping"]);
  assert.deepEqual(got.map(x => x.cached), [false, true, true]);
  assert.ok(got.every(x => x.latencyMs === 9));
});

test("health: offline, unknown, timed out and no tailscale all answer in the contract's shape", async () => {
  const keys = ["cached", "checkedAt", "lastHandshake", "latencyMs", "online", "path", "relay", "why"];
  const offline = await createHealth(fakeRun({ status: status({ Online: false, CurAddr: "" }) })).check({ stableId: "nBOX" });
  assert.deepEqual(Object.keys(offline).sort(), keys);
  assert.equal(offline.online, false);
  assert.equal(offline.why, "the node is offline");
  assert.equal(describe(offline), "offline");
  const f = fakeRun({ status: status() });
  const missing = await createHealth(f).check({ stableId: "nOTHER" });
  assert.equal(missing.path, "unknown");
  assert.match(String(missing.why), /not on this tailnet/);
  assert.deepEqual(f.calls, ["status"], "no ping for a node the status does not list");
  const quiet = await createHealth(fakeRun({ status: status(), ping: null })).check({ stableId: "nBOX" });
  assert.equal(quiet.latencyMs, null);
  assert.equal(quiet.path, "direct", "the path still comes from status");
  assert.match(String(quiet.why), /no answer/);
  const none = await createHealth({ run: async () => ({ code: 127, out: "", err: "" }) }).check({ stableId: "nBOX" });
  assert.deepEqual(Object.keys(none).sort(), keys);
  assert.match(String(none.why), /not installed/);
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
