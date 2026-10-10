// @ts-check
// The box's end of the public door inside a real vyred: with an edge address set (relay.tunnel_url) and a claimed name, the daemon dials the edge on its own, says so on relay.status, and takes a
// visitor the edge hands it; with no address set it dials nothing. The edge is the Node relay with the tunnel front (relay/node); the directory's answer to "who serves this host" is the test's.
// The gate behind the tunnel end is covered by relay/node/ingress.e2e.test.js and relay/deploy/edge.live.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { createRelay } from "../../relay/node/server.js";
import { tempHome } from "../../test/helpers.js";

const lenient = {
  required: () => false, verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }), challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "",
  covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: /** @type {any[]} */ ([]), removed: /** @type {any[]} */ ([]),
  enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(what); await new Promise(r => setTimeout(r, 100)); } };

async function world(/** @type {import("node:test").TestContext} */ t, /** @type {boolean} */ withTunnel) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (real)));
  const route = { id: /** @type {string | null} */ (null) };
  /** @type {string[]} */ const asked = [];
  const relay = createRelay({ tunnel: { resolve: async h => { asked.push(h); return h === "documents.alex.vyre.run" && route.id ? { route: route.id } : null; }, limits: { ttlMs: 0 } } });
  const base = await relay.listen(); const { tls: tlsPort } = await relay.listenTunnel();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex", via: "vyre.run" },
    relay: { enabled: false, url: base, ...(withTunnel ? { tunnel_url: base.replace(/^http/, "ws") } : {}) }, modules: { disable: ["names", "onboard"] } }));
  /** @type {string[]} */ const lines = [];
  const d = await start({ presence: lenient, root, log: (m) => { lines.push(String(m)); } });
  t.after(() => d.stop());
  const status = async () => (await d.registry.call("relay.status", {}, "cli")).data;
  const cli = (/** @type {string} */ tool, /** @type {any} */ input) => call(tool, input, { root, caller: "cli", timeout: 20_000 });
  return { d, relay, tlsPort, route, asked, lines, status, cli, base };
}

test("the box dials the edge by itself once an address is set and a name is claimed, and takes a visitor the edge hands it", async t => {
  const w = await world(t, true);
  const s = await until(async () => { const x = await w.status(); return x.tunnel && x.tunnel.connected ? x : null; }, "the box's link to the edge came up");
  assert.match(s.tunnel.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  w.route.id = s.route;
  assert.ok(w.route.id, "the box has its route");
  // a visitor for a host the directory (here, the test) says this box serves: the edge asks the box for a stream, and the box's tunnel end takes it (there is no public gate in this world, so it closes it)
  const v = tls.connect({ host: "127.0.0.1", port: w.tlsPort, servername: "documents.alex.vyre.run", rejectUnauthorized: false }); v.on("error", () => {});
  await new Promise(r => v.once("close", r));
  assert.ok(w.asked.includes("documents.alex.vyre.run"), "the edge asked who serves the host");
  await until(() => w.lines.some(l => /relay: tunnel/.test(l)) || w.relay.tunnel.stats.accepted > 0, "the edge handed the visitor to the box");
  // a host nobody serves never reaches the box
  const before = w.relay.tunnel.stats.accepted;
  const stranger = tls.connect({ host: "127.0.0.1", port: w.tlsPort, servername: "other.alex.vyre.run", rejectUnauthorized: false }); stranger.on("error", () => {});
  await new Promise(r => stranger.once("close", r));
  assert.equal(w.relay.tunnel.stats.accepted, before);
});

test("with no edge address set, the box dials nothing and says the door is shut", async t => {
  const w = await world(t, false);
  await new Promise(r => setTimeout(r, 1500));
  const s = await w.status();
  assert.deepEqual(s.tunnel, { url: null, connected: false });
});

test("the edge address is a live setting: set it and the box dials, clear it and the door shuts, with no restart", async t => {
  const w = await world(t, false);
  assert.deepEqual((await w.status()).tunnel, { url: null, connected: false });
  const set = await w.cli("settings.set", { key: "relay.tunnel_url", value: w.base.replace(/^http/, "ws") });
  assert.ok(!set.error, JSON.stringify(set.error));
  const s = await until(async () => { const x = await w.status(); return x.tunnel && x.tunnel.connected ? x : null; }, "the box dialled the edge after the setting changed");
  assert.match(s.tunnel.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  const off = await w.cli("settings.set", { key: "relay.tunnel_url", value: "" });
  assert.ok(!off.error, JSON.stringify(off.error));
  await until(async () => { const x = await w.status(); return x.tunnel && !x.tunnel.connected && x.tunnel.url === null; }, "the door shut when the address was cleared");
});
