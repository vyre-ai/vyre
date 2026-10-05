// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { peerSession, socketPipe } from "./node/peer-wire.js";
import { createEgressAgent, createEgressHome, createSocksGate, listed, REP, MAX_TUNNELS } from "./egress.js";

/** A real TCP pair carrying a real peer session each way: the Mac answers `serve`, the home calls. */
async function pair(t, serve) {
  const srv = net.createServer(); await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (srv.address()).port;
  const [a, b] = await Promise.all([new Promise(r => srv.once("connection", r)), new Promise(r => { const c = net.connect(port, "127.0.0.1", () => r(c)); })]);
  srv.close();
  const mac = peerSession(socketPipe(/** @type {net.Socket} */ (a)), { serve, first: 2 });
  const home = peerSession(socketPipe(/** @type {net.Socket} */ (b)), { first: 1 });
  t.after(() => { try { mac.close(); home.close(); } catch { /* gone */ } });
  return { mac, home };
}

/** A site on loopback that echoes with a prefix. */
async function site(t) {
  const seen = [];
  const s = net.createServer(c => { c.on("data", d => { seen.push(String(d)); c.write("echo:" + d); }); c.on("error", () => {}); });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => s.close());
  return { port: /** @type {any} */ (s.address()).port, seen };
}

/** Everything wired: a site, the Mac's agent (resolving "bank.example.com" to the loopback site, with loopback allowed as the test's public), the held link, the home and the SOCKS gate. */
async function world(t, { sites = ["bank.example.com"], enabled = true, device = /** @type {string | null} */ ("dev_mac"), connected = true, agent = {} } = {}) {
  const s = await site(t);
  const dialed = [];
  const ag = createEgressAgent({ sites: () => sites, resolve: async h => (h === "bank.example.com" || h === "www.harlow.example" ? [{ address: "127.0.0.1", family: 4 }] : h === "lan.example.com" ? [{ address: "192.168.1.5", family: 4 }] : []),
    allow: ip => ip === "127.0.0.1", connect: o => { dialed.push(o); return net.connect({ host: o.host, port: s.port }); }, ...agent });
  t.after(() => ag.close());
  const { home: session } = await pair(t, ag.serve);
  const home = createEgressHome({ linkTo: () => ({ call: (tool, input, opt) => session.call(tool, input, opt) }), has: () => connected, device: () => device, enabled: () => enabled, cacheMs: 0, pollMs: 300 });
  const gate = createSocksGate({ home, host: "127.0.0.1", port: 0, handshakeMs: 2000 });
  const { port } = await gate.listen(); t.after(() => gate.close());
  return { s, ag, home, gate, port, dialed };
}

const socks = (port, host, dport, { data = "", wait = 1500 } = {}) => new Promise(resolve => {
  const c = net.connect(port, "127.0.0.1"); const ch = []; let stage = 0;
  c.on("data", d => {
    if (stage === 0) { stage = 1; c.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([dport >> 8, dport & 255])])); return; }
    if (stage === 1) { stage = 2; ch.push(Buffer.from(d.subarray(0, 10))); if (d[1] === 0 && data) c.write(data); const rest = d.subarray(10); if (rest.length) ch.push(rest); return; }
    ch.push(d);
  });
  c.on("connect", () => c.write(Buffer.from([5, 1, 0])));
  c.on("error", () => {}); c.on("close", () => resolve(Buffer.concat(ch)));
  setTimeout(() => c.destroy(), wait).unref();
});

test("egress: a listed site goes through the Mac's connection and the answer comes back", async t => {
  const w = await world(t);
  const r = await socks(w.port, "bank.example.com", w.s.port, { data: "hello" });
  assert.deepEqual([...r.subarray(0, 2)], [5, REP.OK]);
  assert.equal(r.subarray(10).toString(), "echo:hello");
  assert.deepEqual(w.s.seen, ["hello"]);
  assert.equal(w.dialed[0].host, "127.0.0.1", "the Mac connected by the address it resolved, not by the name");
});

test("egress: a wildcard on the Mac's list covers the name and everything under it, and nothing else", () => {
  assert.equal(listed("harlow.example", ["*.harlow.example"]), true);
  assert.equal(listed("www.harlow.example", ["*.harlow.example"]), true);
  assert.equal(listed("evilharlow.example", ["*.harlow.example"]), false);
  assert.equal(listed("bank.example.com.", ["bank.example.com"]), true);
  assert.equal(listed("x.bank.example.com", ["bank.example.com"]), false);
});

test("egress: fails closed with every doubt, and never dials the site from the box", async t => {
  for (const [label, o, rep] of [
    ["off", { enabled: false }, REP.NOT_ALLOWED],
    ["no Mac chosen", { device: null }, REP.NOT_ALLOWED],
    ["the Mac is not connected", { connected: false }, REP.NOT_ALLOWED],
    ["the Mac's own list names no sites", { sites: [] }, REP.NOT_ALLOWED],
  ]) {
    const w = await world(t, /** @type {any} */ (o));
    const r = await socks(w.port, "bank.example.com", w.s.port, { data: "x", wait: 800 });
    assert.deepEqual([...r.subarray(0, 2)], [5, rep], label);
    assert.deepEqual(w.s.seen, [], `${label}: nothing reached the site`);
    assert.equal((await w.home.status()).allowed, false, label);
  }
});

test("egress: the Mac dials only what its own list names, and only a public address it resolved", async t => {
  const w = await world(t, { sites: ["bank.example.com", "lan.example.com", "nowhere.example.com"] });
  // not on the list: the home asked, the Mac said no
  const off = await socks(w.port, "other.example.org", w.s.port, { data: "x", wait: 800 });
  assert.deepEqual([...off.subarray(0, 2)], [5, REP.NOT_ALLOWED]);
  // on the list but the name leads to the Mac's LAN: refused, never dialed
  const lan = await socks(w.port, "lan.example.com", w.s.port, { data: "x", wait: 800 });
  assert.deepEqual([...lan.subarray(0, 2)], [5, REP.NOT_ALLOWED]);
  // an address literal is not a listed hostname
  const ip = await socks(w.port, "127.0.0.1", w.s.port, { data: "x", wait: 800 });
  assert.deepEqual([...ip.subarray(0, 2)], [5, REP.NOT_ALLOWED]);
  // a name that does not resolve
  const gone = await socks(w.port, "nowhere.example.com", w.s.port, { wait: 800 });
  assert.notEqual(gone[1], REP.OK);
  assert.deepEqual(w.dialed, [], "the Mac dialed nothing");
  assert.deepEqual(w.s.seen, []);
});

test("egress: the gate speaks CONNECT only, with no auth, and refuses the rest in the same words", async t => {
  const w = await world(t);
  const bind = await new Promise(resolve => { const c = net.connect(w.port, "127.0.0.1"); const ch = []; c.on("connect", () => c.write(Buffer.from([5, 1, 0]))); let st = 0; c.on("data", d => { if (!st) { st = 1; c.write(Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80])); } else ch.push(d); }); c.on("close", () => resolve(Buffer.concat(ch))); c.on("error", () => {}); setTimeout(() => c.destroy(), 800).unref(); });
  assert.equal(bind[1], REP.BAD_COMMAND);
  const auth = await new Promise(resolve => { const c = net.connect(w.port, "127.0.0.1"); const ch = []; c.on("connect", () => c.write(Buffer.from([5, 1, 2]))); c.on("data", d => ch.push(d)); c.on("close", () => resolve(Buffer.concat(ch))); c.on("error", () => {}); setTimeout(() => c.destroy(), 800).unref(); });
  assert.deepEqual([...auth], [5, 0xff]);
});

test("egress: a tunnel carries a lot of bytes both ways, and closing either end closes the other", async t => {
  const big = Buffer.alloc(300_000, 7);
  const received = [];
  const s = net.createServer(c => { c.on("data", d => received.push(d)); c.on("end", () => c.end(big)); c.on("error", () => {}); });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined))); t.after(() => s.close());
  const ag = createEgressAgent({ sites: () => ["bank.example.com"], resolve: async () => [{ address: "127.0.0.1", family: 4 }], allow: () => true, connect: () => net.connect({ host: "127.0.0.1", port: /** @type {any} */ (s.address()).port }) });
  t.after(() => ag.close());
  const { home: session } = await pair(t, ag.serve);
  const home = createEgressHome({ linkTo: () => ({ call: (a, b, c) => session.call(a, b, c) }), device: () => "d", enabled: () => true, cacheMs: 0, pollMs: 200 });
  const tun = await home.open("bank.example.com", 443);
  const out = Buffer.alloc(200_000, 9);
  tun.end(out);
  const got = await new Promise((res, rej) => { const ch = []; tun.on("data", d => ch.push(d)); tun.on("end", () => res(Buffer.concat(ch))); tun.on("error", rej); setTimeout(() => rej(new Error("timed out")), 20_000).unref(); });
  assert.equal(got.length, big.length);
  assert.equal(Buffer.concat(received).length, out.length);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(ag.tunnels(), 0, "the Mac's tunnel is gone with the stream");
});

test("egress: the Mac caps its tunnels, drops an idle one, and answers nothing but the egress calls", async t => {
  const w = await world(t, { agent: { maxTunnels: 2, idleMs: 400 } });
  const link = { call: (tool, input) => w.ag.serve(tool, input) };
  const a = await link.call("wink.egress.open", { host: "bank.example.com", port: w.s.port });
  await link.call("wink.egress.open", { host: "bank.example.com", port: w.s.port });
  await assert.rejects(link.call("wink.egress.open", { host: "bank.example.com", port: w.s.port }), /as many tunnels/);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(w.ag.tunnels(), 0, "idle tunnels are closed");
  await assert.rejects(link.call("wink.egress.read", { id: a.id }), /no such tunnel/);
  await assert.rejects(w.ag.serve("vault.list", {}), /only the egress calls/);
  await assert.rejects(w.ag.serve("wink.egress.write", { id: "t99", data: "" }), /no such tunnel/);
  assert.ok(MAX_TUNNELS >= 8);
});

test("egress: the Mac's held connection answers egress calls itself and leaves every other call to whatever else it serves", async t => {
  const { startEgressAgent } = await import("./egress.js");
  /** @type {any} */ let given = null;
  const connect = (/** @type {string} */ space, /** @type {any} */ o) => { given = { space, serve: o.serve }; return { status: () => ({ state: "up", path: "relay" }), onchange() {}, close() {}, ready: async () => {} }; };
  const calls = [];
  const a = startEgressAgent({ connect, space: "spc_x", sites: () => ["bank.example.com"], otherServe: async (tool, input) => { calls.push(tool); return { ok: true }; } });
  t.after(() => a.stop());
  assert.equal(given.space, "spc_x");
  assert.deepEqual(await given.serve("wink.egress.status", {}), { ok: true, sites: 1, tunnels: 0 });
  assert.deepEqual(await given.serve("wink.storage.bridge", {}), { ok: true });
  assert.deepEqual(calls, ["wink.storage.bridge"]);
  assert.equal(a.status().up, true);
  const bare = startEgressAgent({ connect, space: "spc_y", sites: () => [] });
  t.after(() => bare.stop());
  await assert.rejects(given.serve.call(null, "vault.list", {}).then(() => bare.serve("vault.list", {})), /only the egress calls/);
});
