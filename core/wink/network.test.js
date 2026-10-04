// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetwork, registerNetwork } from "./network.js";
import { otherVpnRunning } from "../network/other-vpn.js";

/** A fake node host: spaces by id, each with a status() row, plus the calls made on it. */
function fakeHost(rows = []) {
  const log = /** @type {string[]} */ ([]);
  const spaces = new Map(rows.map(r => [r.id, { ...r }]));
  const link = (/** @type {any} */ st) => { const l = { st, closed: false, status: () => l.st, ping: async () => 12, ready: async () => {}, close() { l.closed = true; log.push("close"); }, onchange() {} }; return l; };
  const links = new Map();
  return {
    log, links,
    status: () => [...spaces.values()].map(s => ({ ...s, links: links.has(s.id) && !links.get(s.id).closed ? [links.get(s.id).status()] : s.links || [], peers: s.peers || [] })),
    whois: (/** @type {any} */ q) => [...spaces.values()].flatMap(s => s.peers || []).map(p => ({ ...p, space: "personal", addr: p.addr || null })).find(p => (q.eid && p.eid === q.eid) || (q.addr && p.addr === String(q.addr).replace(/:\d+$/, ""))) || null,
    info: (/** @type {string} */ id) => (spaces.get(id) ? { id, spec: spaces.get(id).spec || { id } } : null),
    addSpace: (/** @type {any} */ spec) => { log.push(`add ${spec.id}`); spaces.set(spec.id, { id: spec.id, node: "down", door: "none", ips: [], links: [], peers: [], spec }); },
    start: async (/** @type {string} */ id) => { log.push(`start ${id}`); spaces.get(id).node = "up"; },
    stop: async (/** @type {string} */ id) => { log.push(`stop ${id}`); },
    connect: (/** @type {string} */ id, /** @type {any} */ o) => { log.push(`connect ${id}${o && o.dial ? " relay-only" : ""}`); const l = link({ state: "up", path: o && o.dial ? "relay" : "direct", direct: "up", relay: "idle", since: 1 }); links.set(id, l); return l; },
  };
}

function fakeCtx(answers = {}) {
  const events = /** @type {any[]} */ ([]);
  return { events: { emit: (/** @type {string} */ n, /** @type {any} */ b) => events.push([n, b]) }, emitted: events,
    call: async (/** @type {string} */ name) => { if (name in answers) { const a = /** @type {any} */ (answers)[name]; if (a instanceof Error) throw a; return a; } throw new Error("no such tool " + name); } };
}

const relayOn = { data: { enabled: true, connected: true } };
const storage = { data: { devices: [{ id: "s1", name: "nas-1", state: "online", storage: { capacity: 500e9, used: 88e9 } }, { id: "s2", name: "bucket-a", state: "unreachable", reason: "timeout", storage: { capacity: 1e9, used: 0 } }] } };

test("status: signed in, a connected link, the relay, storage with room left, the clock", async () => {
  const host = fakeHost([{ id: "personal", node: "up", door: "none", ips: ["100.64.0.2"], links: [{ state: "up", path: "direct", since: 5 }], peers: [{ eid: "p1" }, { eid: "p2" }] }]);
  const net = createNetwork(fakeCtx({ "relay.status": relayOn }), { host, storage: { status: async () => storage.data }, identity: { self: () => ({ signedIn: true, name: "alex.vyre.run", devices: 3 }) },
    spaces: { name: () => "Personal" }, clock: () => ({ skewMs: 40 }), relayPing: async () => 38 });
  host.connect("personal"); // a link the module made, so it can be pinged
  const s = await net.status();
  assert.deepEqual(s.identity, { signedIn: true, name: "alex.vyre.run", devices: 3 });
  assert.equal(s.spaces[0].state, "connected");
  assert.deepEqual([s.spaces[0].name, s.spaces[0].path, s.spaces[0].peers], ["Personal", "direct", 2]);
  assert.deepEqual(s.relay, { enabled: true, reachable: true, latencyMs: 38 });
  assert.deepEqual(s.storage.map(d => [d.name, d.reachable, d.free]), [["nas-1", true, 412e9], ["bucket-a", false, 1e9]]);
  assert.equal(s.storage[1].reason, "timeout");
  assert.deepEqual(s.clock, { skewMs: 40 });
  assert.equal(s.otherVpn, false);
});

test("status: a relayed link, a down node, a refused device, and an unreachable relay each say so", async () => {
  const host = fakeHost([
    { id: "a", node: "up", door: "none", ips: [], links: [{ state: "up", path: "relay", since: 1 }], peers: [] },
    { id: "b", node: "down", door: "none", ips: [], links: [], peers: [] },
    { id: "c", node: "up", door: "none", ips: [], links: [{ state: "connecting", path: null, since: 1, lastError: "unknown device" }], peers: [] },
    { id: "d", node: "up", door: "listening", ips: [], links: [], peers: [] },
  ]);
  const net = createNetwork(fakeCtx({ "relay.status": { data: { enabled: true, connected: false } } }), { host });
  const s = await net.status({ ping: false });
  assert.deepEqual(s.spaces.map(x => x.state), ["relayed", "offline", "joining", "connected"]);
  assert.equal(s.spaces[2].door.refused, true);
  assert.equal(s.spaces[3].door.listening, true);
  assert.equal(s.relay.reachable, false);
  assert.equal(s.relay.latencyMs, null);
});

test("status: a port that is absent is unknown, never guessed", async () => {
  const net = createNetwork(fakeCtx({}), {});
  const s = await net.status();
  assert.deepEqual(s.identity, { signedIn: null });
  assert.deepEqual([s.spaces, s.storage, s.clock.skewMs, s.relay.reachable], [[], [], null, null]);
});

test("whois: from the host's admitted sessions and the identity entry, by id or by address; never from anything a peer says", async () => {
  const host = fakeHost([{ id: "personal", node: "up", door: "listening", ips: [], links: [], peers: [{ eid: "phone1", via: "direct", since: 3, addr: "100.64.0.9" }] }]);
  const entries = { phone1: { eid: "phone1", kind: "device", deviceKind: "phone", identity: "alex.vyre.run", name: "Alex's iPhone" }, laptop: { eid: "laptop", kind: "device", identity: "alex.vyre.run" } };
  const net = createNetwork(fakeCtx(), { host, identity: { entry: async (/** @type {string} */ e) => /** @type {any} */ (entries)[e] || null } });
  const byAddr = await net.whois({ addr: "100.64.0.9:51000" });
  assert.deepEqual([byAddr.eid, byAddr.identity, byAddr.kind, byAddr.space, byAddr.online, byAddr.via], ["phone1", "alex.vyre.run", "phone", "personal", true, "direct"]);
  assert.equal((await net.whois({ eid: "phone1" })).name, "Alex's iPhone");
  const off = await net.whois({ eid: "laptop" });
  assert.deepEqual([off.online, off.space, off.kind], [false, null, "device"], "on the list but not connected");
  await assert.rejects(net.whois({ addr: "100.64.0.77" }), { code: "not_found" });
  await assert.rejects(net.whois({ eid: "ghost" }), { code: "not_found" });
  await assert.rejects(net.whois({}), { code: "bad_input" });
});

test("join: starts the node and connects; asking again changes nothing; leave closes the link and stops the node", async () => {
  const host = fakeHost();
  const ctx = fakeCtx({ "relay.status": relayOn });
  const net = createNetwork(ctx, { host, spaces: { spec: async (/** @type {string} */ id) => (id === "work" ? { id: "work", controlUrl: "https://c", hostname: "mac", box: "b1", peerAddr: "100.64.0.1:8443" } : null) } });
  const r = await net.join({ space: "work" });
  assert.equal(r.joined, true);
  assert.deepEqual(host.log, ["add work", "start work", "connect work"]);
  assert.equal(r.space.state, "connected");
  await net.join({ space: "work" });
  assert.equal(host.log.length, 3, "joined once");
  assert.deepEqual(ctx.emitted.map(e => e[0]), ["wink.network-changed"]);
  assert.deepEqual(await net.leave({ space: "work" }), { left: true, space: "work" });
  assert.deepEqual(host.log.slice(3), ["close", "stop work"]);
  await assert.rejects(net.leave({ space: "work" }), { code: "not_found" });
  await assert.rejects(net.join({ space: "nope" }), { code: "not_found" });
  await assert.rejects(net.join({ space: "bad space!" }), { code: "bad_input" });
});

test("join: with another VPN running here the node is not started and the link is relay-only, and status says why", async () => {
  const host = fakeHost();
  const net = createNetwork(fakeCtx({ "relay.status": relayOn }), { host, otherVpn: async () => true, spaces: { spec: async () => ({ id: "work", controlUrl: "https://c", hostname: "mac", box: "b1" }) } });
  const r = await net.join({ space: "work" });
  assert.deepEqual(host.log, ["add work", "connect work relay-only"]);
  assert.equal(r.space.state, "relayed");
  assert.equal(r.space.relayOnly, "another VPN is running here");
  assert.equal((await net.status({ ping: false })).otherVpn, true);
});

test("join: a server that hosts the space does not join it", async () => {
  const host = fakeHost([{ id: "home", node: "up", door: "listening", ips: [], links: [], peers: [], spec: { id: "home", peerPort: 8443 } }]);
  const net = createNetwork(fakeCtx(), { host });
  await assert.rejects(net.join({ space: "home" }), { code: "bad_input" });
});

test("tools: the four are internal to the network module, and nobody else may call them", async () => {
  const tools = new Map();
  const ctx = { ...fakeCtx({ "relay.status": relayOn }), tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) };
  registerNetwork(ctx, { host: fakeHost() });
  assert.deepEqual([...tools.keys()], ["wink.network.status", "wink.network.whois", "wink.network.join", "wink.network.leave"]);
  assert.equal((await tools.get("wink.network.status").run({}, { caller: "module:network" })).spaces.length, 0);
  for (const bad of ["cli", "module:link", "agent:kit", "anonymous", "tailnet-guest:x@y.z"]) for (const [n, d] of tools) await assert.rejects(Promise.resolve().then(() => d.run({ space: "x", eid: "e" }, { caller: bad })), { code: "denied" }, `${n} for ${bad}`);
  for (const d of tools.values()) assert.ok(!/tailscale|tailnet/i.test(d.description), "no word a person should not read");
});

test("other VPN: running means a Running backend; missing, stopped or unreadable means no", async () => {
  const run = (/** @type {any} */ r) => async () => r;
  assert.equal(await otherVpnRunning({ run: run({ code: 0, out: JSON.stringify({ BackendState: "Running" }), err: "" }) }), true);
  assert.equal(await otherVpnRunning({ run: run({ code: 0, out: JSON.stringify({ BackendState: "Stopped" }), err: "" }) }), false);
  assert.equal(await otherVpnRunning({ run: run({ code: 127, out: "", err: "" }) }), false);
  assert.equal(await otherVpnRunning({ run: run({ code: 0, out: "not json", err: "" }) }), false);
  assert.equal(await otherVpnRunning({ run: async () => { throw new Error("x"); } }), false);
});
