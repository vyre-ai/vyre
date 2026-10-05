// @ts-check
// The built-in network for real, on a disposable server only: netd starts a real Headscale, the gate in front of it and a real wink-forwarder node on this "home"; a second
// real node (a second forwarder in a second node host, with a device key) joins with a one-time key the home minted, dials the home's door over the network, proves its key on the
// identity list, and a call crosses as device:<eid>. A device taken off the list is refused at its next call. Skipped unless VYRE_WINK_REAL=1:
//
//   VYRE_WINK_REAL=1 VYRE_HEADSCALE_BIN=~/bin/headscale VYRE_WINK_FORWARDER_BIN=~/bin/wink-forwarder node --test core/wink/netd.real.test.js
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createNetd, findBinaries, nodeNameFor, PEER_PORT } from "./netd.js";
import { createHost } from "./node/host.js";

const bins = findBinaries();
const skip = process.env.VYRE_WINK_REAL !== "1" ? "set VYRE_WINK_REAL=1 on a disposable server to run" : !bins.headscale || !bins.forwarder ? "needs VYRE_HEADSCALE_BIN and VYRE_WINK_FORWARDER_BIN" : false;
const b64u = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const until = async (/** @type {() => any} */ f, ms = 30_000, what = "condition") => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 200)); } };

test("real netd: the daemon's network comes up, a second node joins and a call crosses the direct path as device:<eid>", { skip, timeout: 240_000 }, async t => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "netd-real-"));
  const space = "spc_realnet01", eid = "abcdefghijklmnop";
  /** the device rows that exist: a node reaches the door only while its device has one */
  const rows = new Set([eid]);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = b64u(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  /** @type {Map<string, any>} */ const entries = new Map([[eid, { eid, kind: "device", pub }]]);
  const served = /** @type {any[]} */ ([]);
  const logs = /** @type {string[]} */ ([]);
  const home = createNetd({
    root: path.join(root, "home"), space: async () => space, box: async () => "boxreal", entry: async x => entries.get(x) || null,
    serve: async (caller, tool, input) => { served.push({ caller, tool }); return { tool, input, caller }; },
    retryMs: 0, reach: null, devices: () => [...rows], log: m => logs.push(m),
  });
  t.after(async () => { try { await home.stop(); } catch { /* best effort */ } });
  await home.start();
  const s = home.status();
  assert.equal(s.state, "up", `netd state ${s.state}: ${s.why}\n${logs.join("\n")}`);
  const homeIp = s.ips.find(ip => ip.includes("."));
  assert.ok(homeIp, "the home's node has a network address");
  assert.ok(home.host().status().find((/** @type {any} */ x) => x.id === space && x.door === "listening"), "the door is listening");

  // a second machine: its own node host and device key, joined with a one-time key from the home
  const dev = createHost({ root: path.join(root, "dev"), forwarderBin: /** @type {string} */ (bins.forwarder), log: m => logs.push(`dev: ${m}`), graceMs: 60_000,
    device: { id: eid, sign: m => b64u(crypto.sign(null, m, privateKey)) } });
  t.after(async () => { try { await dev.stopAll(); } catch { /* best effort */ } });
  const key = await home.joinKey(120_000, eid);
  dev.addSpace({ id: space, controlUrl: /** @type {string} */ (s.controlUrl), authKey: key, hostname: nodeNameFor(eid), box: "boxreal", peerAddr: `${homeIp}:${PEER_PORT}` });
  await dev.start(space);
  const link = dev.connect(space);
  t.after(() => link.close());
  const r = await until(async () => { await home.syncPolicy().catch(() => {}); try { return await link.call("about.text", { q: 1 }, { timeoutMs: 15_000 }); } catch { return null; } }, 90_000, `a call to cross (${logs.slice(-6).join(" | ")})`);
  assert.equal(r.caller, `device:${eid}`);
  assert.equal(link.status().path, "direct", "the call crossed the Wink network, not the relay");
  assert.equal(served.at(-1).caller, `device:${eid}`);

  // the paired device row is removed: its node is deleted and its rule goes, so the next call cannot cross
  rows.delete(eid);
  await home.deviceChanged();
  // the node's session may outlive the rule for a few seconds while Headscale pushes the new map: the call must start failing soon
  await until(async () => { try { await link.call("about.text", { q: 3 }, { timeoutMs: 5_000 }); return false; } catch { return true; } }, 60_000, "the removed device's calls to fail");

  // taken off the identity list: the next call is refused
  entries.delete(eid);
  await assert.rejects(link.call("about.text", { q: 2 }, { timeoutMs: 8_000 }), /./);
});

test("real netd: a box without the programs reports no-binary and starts nothing", { skip: process.env.VYRE_WINK_REAL !== "1" ? "set VYRE_WINK_REAL=1 on a disposable server to run" : false }, async () => {
  const n = createNetd({ root: fs.mkdtempSync(path.join(SCRATCH, "netd-nobin-")), space: async () => "spc_x", box: async () => "b", entry: async () => null, binaries: { headscale: null, forwarder: null }, retryMs: 0, reach: null });
  await n.start();
  assert.equal(n.status().state, "no-binary");
});
