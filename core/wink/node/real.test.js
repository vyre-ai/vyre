// @ts-check
// The real thing, on a disposable server only: the Go forwarder joined to a headscale, a second core (this
// package's core.js driving a real tailscaled) connecting to it, and the peer channel receiving the node key
// and stable id the forwarder read from its own WhoIs. Skipped unless VYRE_WINK_REAL=1.
//
//   VYRE_WINK_REAL=1 VYRE_WINK_SPIKE=~/spike-wink VYRE_WINK_FORWARDER_BIN=~/wf-test node --test core/wink/node/real.test.js
//
// VYRE_WINK_SPIKE holds bin/{headscale,tailscale,tailscaled} and hs/config.yaml (a working headscale config
// whose paths point into that folder); this test copies the config, moves every path and port to its own
// folder, and starts its own headscale, so nothing already running is touched.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { SCRATCH } from "../../../test/scratch.mjs";
import { listenPeers } from "./peer-channel.js";
import { createCore } from "./core.js";

const SPIKE = process.env.VYRE_WINK_SPIKE || "";
const FWD = process.env.VYRE_WINK_FORWARDER_BIN || "";
const skip = process.env.VYRE_WINK_REAL !== "1" ? "set VYRE_WINK_REAL=1 on a disposable server to run" : !SPIKE || !FWD ? "needs VYRE_WINK_SPIKE and VYRE_WINK_FORWARDER_BIN" : false;

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => res(p)); }); });
const until = async (/** @type {() => any} */ f, ms = 20_000, what = "condition") => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 100)); } };

test("real: the forwarder names a peer from its own WhoIs and the peer channel receives the node key and stable id", { skip, timeout: 180_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "real-"));
  /** @type {import("node:child_process").ChildProcess[]} */ const procs = [];
  const cleanups = /** @type {(() => any)[]} */ ([]);
  t.after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } } for (const p of procs) { try { p.kill("SIGTERM"); } catch { /* gone */ } } });

  // 1. our own headscale, every path and port moved into dir
  const hs = path.join(dir, "hs"); fs.mkdirSync(hs, { recursive: true });
  const port = await freePort();
  let cfg = fs.readFileSync(path.join(SPIKE, "hs", "config.yaml"), "utf8").split(path.join(SPIKE, "hs")).join(hs);
  cfg = cfg.replace(/127\.0\.0\.1:\d+/g, m => (m.endsWith("18080") ? `127.0.0.1:${port}` : m)).replace(/^(metrics_listen_addr|grpc_listen_addr): .*$/gm, (_m, k) => `${k}: 127.0.0.1:0`);
  cfg = cfg.replace(/stun_listen_addr: .*/, "stun_listen_addr: 127.0.0.1:0");
  fs.writeFileSync(path.join(hs, "config.yaml"), cfg);
  for (const f of ["derp-dummy.yaml", "policy.hujson"]) fs.copyFileSync(path.join(SPIKE, "hs", f), path.join(hs, f));
  const HSBIN = path.join(SPIKE, "bin", "headscale");
  const hsLog = fs.openSync(path.join(hs, "hs.log"), "a");
  const hsProc = spawn(HSBIN, ["serve", "-c", path.join(hs, "config.yaml")], { stdio: ["ignore", hsLog, hsLog] });
  procs.push(hsProc);
  const controlUrl = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(controlUrl + "/health")).ok; } catch { return false; } }, 20_000, "headscale up");
  const hsCli = (/** @type {string[]} */ ...a) => execFileSync(HSBIN, ["-c", path.join(hs, "config.yaml"), ...a], { encoding: "utf8" });
  hsCli("users", "create", "owner");
  const mintKey = (/** @type {string} */ tag) => { const f = path.join(dir, `key-${tag}`); fs.writeFileSync(f, hsCli("preauthkeys", "create", "-u", "1", "--tags", "tag:" + tag, "-e", "10m").trim().split("\n").pop() || "", { mode: 0o600 }); return f; };

  // 2. the peer channel, and the forwarder joined as tag:hub, listening on 8443
  const seen = /** @type {any[]} */ ([]);
  const chan = await listenPeers({ path: path.join(dir, "peers", "peer.sock"), onPeer: (c, id) => { seen.push(id); c.on("data", d => c.write(Buffer.concat([Buffer.from("saw:"), d]))); c.on("error", () => {}); c.resume(); } });
  cleanups.push(() => chan.close());
  const fwdKey = mintKey("hub");
  const fwd = spawn(FWD, ["-state-dir", path.join(dir, "fwd"), "-control-url", controlUrl, "-auth-key-file", fwdKey, "-hostname", "hub", "-listen", `8443=${chan.path}`], { stdio: ["ignore", "pipe", "inherit"] });
  procs.push(fwd);
  let outBuf = "";
  const events = /** @type {any[]} */ ([]);
  fwd.stdout.on("data", d => { outBuf += d; let i; while ((i = outBuf.indexOf("\n")) >= 0) { try { events.push(JSON.parse(outBuf.slice(0, i))); } catch { /* not an event */ } outBuf = outBuf.slice(i + 1); } });
  const ready = await until(() => events.find(e => e.event === "ready"), 60_000, "forwarder ready");
  console.log("forwarder ready:", JSON.stringify({ nodeKey: ready.nodeKey, stableId: ready.stableId, ips: ready.ips }));
  assert.equal(fs.existsSync(fwdKey), false, "the forwarder deleted its key file once it was up");
  const hubIp = ready.ips.find((/** @type {string} */ ip) => ip.includes("."));

  // 3. a second core, this package's core.js driving a real tailscaled, joined as tag:device
  const home = path.join(dir, "client");
  const events2 = /** @type {any[]} */ ([]);
  const client = createCore({
    env: { VYRE_WINK_CORE_BIN: path.join(SPIKE, "bin", "tailscaled"), VYRE_WINK_CLI_BIN: path.join(SPIKE, "bin", "tailscale") },
    onEvent: e => events2.push(e),
    // headscale here speaks plain HTTP on loopback, so there is no certificate to pin: the shim is replaced by a stub
    startShim: async () => ({ url: controlUrl, port, close: async () => {}, stats: { proxied: 0, upgraded: 0, refused: 0, pinMismatch: 0 } }),
  });
  cleanups.push(() => client.stop());
  const devKey = mintKey("device");
  await client.start({ home, controlUrl: "https://127.0.0.1:9", pinnedKeyPin: "00".repeat(32), authKeyFile: devKey, hostname: "alex-phone", tags: [] });
  assert.equal(fs.existsSync(devKey), false);
  const st = await until(async () => { const s = await client.status(); return s.self && s.peers.length ? s : null; }, 30_000, "client sees the hub");
  console.log("client core:", JSON.stringify({ state: st.state, self: st.self, peers: st.peers.map(p => ({ stableId: p.stableId, nodeKey: p.nodeKey, tags: p.tags, direct: p.direct })) }));
  assert.deepEqual(events2.filter(e => e.type === "error"), [], "no drift or error on a real core");

  // 4. connect through the tailnet; the peer channel must see the client's node key and id
  const cli = path.join(SPIKE, "bin", "tailscale"), sock = path.join(home, "run", "ts.sock");
  const nc = spawn(cli, [`--socket=${sock}`, "nc", hubIp, "8443"], { stdio: ["pipe", "pipe", "inherit"] });
  procs.push(nc);
  let echoed = "";
  nc.stdout.on("data", d => (echoed += d));
  nc.stdin.write("ping\n");
  await until(() => seen.length >= 1 && echoed.includes("saw:ping"), 30_000, "peer channel saw the connection");
  const id = seen[0];
  console.log("peer channel received:", JSON.stringify(id));
  assert.equal(id.nodeKey, st.self?.nodeKey);
  assert.equal(id.stableId, st.self?.stableId);
  assert.deepEqual(id.tags, ["tag:device"]);
  assert.ok(st.self?.ips.includes(id.remoteAddr.split(":")[0]), "the remote address is the client's tailnet address, not loopback");
  nc.kill("SIGTERM");

  // 5. whois from the client core names the forwarder's node
  const w = await client.whois(hubIp);
  console.log("client whois(hub):", JSON.stringify(w));
  assert.equal(w?.nodeKey, ready.nodeKey);
  assert.equal(w?.stableId, ready.stableId);

  // 6. Taildrop: the core has no storage directory, so it cannot receive
  fs.mkdirSync(path.join(dir, "inbox"));
  let drop = "";
  try { execFileSync(cli, [`--socket=${sock}`, "file", "get", path.join(dir, "inbox")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); drop = "received"; }
  catch (e) { drop = String(/** @type {any} */ (e).stderr || /** @type {any} */ (e).message); }
  console.log("taildrop receive attempt:", drop.trim());
  assert.match(drop, /Taildrop disabled; no storage directory/);
  assert.equal(fs.existsSync(path.join(home, "state", "files")), false);
  // and sending is refused too (the hub is not a file-sharing target of this node)
  fs.writeFileSync(path.join(dir, "f.txt"), "hi");
  let sent = "";
  try { execFileSync(cli, [`--socket=${sock}`, "file", "cp", path.join(dir, "f.txt"), hubIp + ":"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); sent = "sent"; }
  catch (e) { sent = String(/** @type {any} */ (e).stderr || /** @type {any} */ (e).message); }
  console.log("taildrop send attempt:", sent.trim());
  assert.notEqual(sent, "sent");

  // 7. the real prefs the core reports
  const prefs = JSON.parse(execFileSync(cli, [`--socket=${sock}`, "debug", "prefs"], { encoding: "utf8" }));
  console.log("prefs:", JSON.stringify({ ControlURL: prefs.ControlURL, RouteAll: prefs.RouteAll, CorpDNS: prefs.CorpDNS, RunSSH: prefs.RunSSH, ExitNodeIP: prefs.ExitNodeIP, AdvertiseRoutes: prefs.AdvertiseRoutes, AutoUpdate: prefs.AutoUpdate }));
});
