// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createHost } from "./host.js";
import { peerSession } from "./peer-wire.js";

const FWD = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-forwarder.js");
const shared = crypto.randomBytes(32);
const HOME_NK = "nodekey:" + "11".repeat(32), SRV_NK = "nodekey:" + "22".repeat(32);

function scratch(name) { return fs.mkdtempSync(path.join(SCRATCH, `h-${name}-`)); }

/** A home host and a server host wired through the fake forwarder, the way two machines would be. */
async function world(t, { blackhole = false, graceMs = 150, retryMs = 60_000 } = {}) {
  const homeRoot = scratch("home"), srvRoot = scratch("srv");
  const calls = /** @type {any[]} */ ([]);
  const home = createHost({ root: homeRoot, forwarderBin: FWD, spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_NODEKEY: HOME_NK }) });
  home.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "home", box: "box1", peerPort: 8443 });
  const routes = { "100.64.0.1:8443": home.peerSock("harlow") };
  const relayHooks = { opened: 0, fail: false };
  const server = createHost({ root: srvRoot, forwarderBin: FWD, graceMs, retryMs,
    spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_NODEKEY: SRV_NK, FAKE_ROUTES: JSON.stringify(routes), ...(blackhole ? { FAKE_BLACKHOLE: "1" } : {}) }),
    device: { id: "srv1", shared: () => shared },
    relayPeer: async () => {
      relayHooks.opened++;
      if (relayHooks.fail) throw new Error("relay is down");
      // a relay peer stream is a pipe to the home's acceptRelay; model it with a socket pair
      const net = await import("node:net");
      const [a, b] = await pairSockets(net);
      const fakeStream = streamOver(b);
      home.acceptRelay("harlow")(fakeStream, { deviceId: "srv1" });
      return (await import("./peer-wire.js")).socketPipe(a);
    } });
  server.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "srv", box: "box1", peerAddr: "100.64.0.1:8443" });
  await home.start("harlow");
  await server.start("harlow");
  await home.serveHome("harlow", { shared: (d, nk) => (d === "srv1" && nk === SRV_NK ? shared : null), serve: async (caller, tool, input) => { calls.push({ caller, tool, input }); return { tool, input, caller }; } });
  t.after(async () => { await server.stopAll(); await home.stopAll(); });
  return { home, server, calls, relayHooks };
}

import { spawn } from "node:child_process";
function spawnFake(bin, args, env) { return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env }); }
async function pairSockets(net) {
  const srv = net.createServer(); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const a = net.connect(srv.address().port, "127.0.0.1"); const b = await new Promise(r => srv.once("connection", r));
  await new Promise(r => a.once("connect", r)); srv.close(); return [a, b];
}
/** The slice of a relay Stream that streamPipe uses, over a socket. */
function streamOver(sock) {
  const s = { ch: { transport: {} }, ondata: () => {}, onend: () => {}, onreset: () => {}, write: b => sock.write(b), end: () => sock.end(), reset: () => sock.destroy() };
  sock.on("data", b => s.ondata(b)); sock.on("end", () => s.onend()); sock.on("close", () => s.onreset("closed"));
  return s;
}

test("host: a paired server's call reaches the home over the direct path, as device:<id>", async t => {
  const w = await world(t);
  const link = w.server.connect("harlow");
  const r = await link.call("about.text", { q: 1 });
  assert.deepEqual(r, { tool: "about.text", input: { q: 1 }, caller: "device:srv1" });
  assert.equal(link.status().path, "direct");
  assert.equal(w.relayHooks.opened, 0, "the relay was never opened");
  assert.ok((await link.ping()) !== null);
  link.close();
});

test("host: with the direct path blackholed the relay peer stream starts after the grace time and carries the call", async t => {
  const w = await world(t, { blackhole: true, graceMs: 200 });
  const link = w.server.connect("harlow");
  const t0 = Date.now();
  const r = await link.call("about.text", { via: "relay" });
  assert.equal(r.caller, "device:srv1");
  assert.equal(link.status().path, "relay");
  assert.ok(Date.now() - t0 >= 180 && Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(link.status().direct, "trying", "the direct dial is still being tried");
  link.close();
});

test("host: no path at all fails with a clear error and never hangs past the timeout", async t => {
  const w = await world(t, { blackhole: true, graceMs: 50 });
  w.relayHooks.fail = true;
  const link = w.server.connect("harlow");
  await assert.rejects(link.call("about.text", {}, { timeoutMs: 600 }), e => e.code === "unreachable" && /direct trying, relay failed/.test(e.message));
  link.close();
});

test("host: a failed direct dial starts the relay at once, and the direct path is preferred once it is up", async t => {
  const w = await world(t, { graceMs: 5000, retryMs: 300 });
  // break the direct route first: the dial answers 'no path', so the relay must not wait for the grace time
  const link = w.server.connect("harlow", { dial: async () => { throw Object.assign(new Error("context deadline exceeded"), { code: "unreachable" }); } });
  const t0 = Date.now();
  assert.equal((await link.call("about.text", {})).caller, "device:srv1");
  assert.ok(Date.now() - t0 < 1500, "the relay did not wait for the 5 s grace");
  assert.equal(link.status().path, "relay");
  link.close();
  // and with a good direct path later: a link that starts on the relay moves to direct when it comes up
  let allow = false;
  const real = () => w.server.connect("harlow");
  void real;
  const l2 = w.server.connect("harlow", { dial: async () => { if (!allow) throw new Error("no path"); return peerSession({ write() {}, end() {}, destroy() {}, buffered: () => 0, ondata() {}, onclose() {} }, { first: 1 }); } });
  await l2.call("about.text", {});
  assert.equal(l2.status().path, "relay");
  allow = true;
  await new Promise(r => setTimeout(r, 900));
  assert.equal(l2.status().path, "direct", "direct is preferred as soon as it is up");
  l2.close();
});

test("host: an unknown device or a node that is not the device's is not admitted on the direct path", async t => {
  const w = await world(t, { graceMs: 100 });
  const bad = createHost({ root: scratch("bad"), forwarderBin: FWD, graceMs: 100,
    spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_NODEKEY: "nodekey:" + "33".repeat(32), FAKE_ROUTES: JSON.stringify({ "100.64.0.1:8443": w.home.peerSock("harlow") }) }),
    device: { id: "srv1", shared: () => shared } });
  bad.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "bad", box: "box1", peerAddr: "100.64.0.1:8443" });
  await bad.start("harlow");
  t.after(() => bad.stopAll());
  const link = bad.connect("harlow");
  await assert.rejects(link.call("about.text", {}, { timeoutMs: 1500 }), e => e.code === "unreachable");
  assert.equal(w.calls.length, 0, "nothing was served to a node that is not enrolled for the device");
  link.close();
});

test("host: no forwarder program is a clear error, and a failing node start reports why", async t => {
  const h = createHost({ root: scratch("nf") });
  h.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "x", box: "b" });
  await assert.rejects(h.start("harlow"), e => e.code === "unavailable");
  const f = createHost({ root: scratch("ff"), forwarderBin: FWD, spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_FAIL_START: "1" }) });
  f.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "x", box: "b" });
  await assert.rejects(f.start("harlow"), /no control/);
  assert.throws(() => h.addSpace({ id: "../x", controlUrl: "u", hostname: "x", box: "b" }), /space id/);
});

test("host: the dial socket is private (0600 in a 0700 directory)", async t => {
  const w = await world(t);
  const sock = w.server.dialSock("harlow");
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
});
