// @ts-check
// The link, end to end: two vyreds in two temp homes stand in for the Mac and the box, through
// the harness in test/link-harness.js (the simulated tailnet at both ends).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { request } from "../core/daemon/client.js";
import { tempHome, writeModule, present } from "./helpers.js";
import { OWNER, MAC, PHONE, wait, until, pair } from "./link-harness.js";

test("link: pairing, box tools from the Mac, a federated search and a fetch", async t => {
  const s = await pair(t);
  // The key is on the Mac at 0600, and the box keeps only its hash with the Mac's node.
  const saved = path.join(s.macRoot, "link.json");
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  const peers = (await s.boxCall("link.peers")).data;
  assert.equal(peers.length, 1);
  assert.equal(peers[0].node, "test-mac");
  const status = await until(async () => { const st = (await s.macCall("link.status")).data; return st.reachable && st; });
  assert.equal(status.box.name, "testbox");
  assert.equal(status.box.node, "test-box");

  // A box tool, through the link, as the owner's tailnet identity.
  const echo = await s.macCall("link.call", { tool: "system.echo", input: { text: "hi" } });
  assert.deepEqual(echo.data, { text: "hi" });
  const linkTool = await s.macCall("link.call", { tool: "link.peers", input: {} });
  assert.match(linkTool.error.message, /not callable through the link/);
  // The person's own actions never ride the link: a model on the Mac would answer its own ask on
  // the box, or approve a held send, as the owner's device.
  for (const tool of ["threads.answer", "gate.approve", "gate.reject", "term.open", "agents.create", "vault.reveal"]) {
    const r = await s.macCall("link.call", { tool, input: {} });
    assert.equal(r.error && r.error.code, "person_session_required", `${tool}: ${JSON.stringify(r)}`);
  }

  fs.writeFileSync(path.join(s.boxWork, "plan-box.md"), "the box's plan");
  fs.writeFileSync(path.join(s.macWork, "plan-mac.md"), "the Mac's plan");
  const found = (await s.macCall("files.search", { q: "plan" })).data;
  assert.deepEqual(found.results.map(r => `${r.source}:${r.name}`).sort(), ["box:plan-box.md", "mac:plan-mac.md"]);
  assert.ok(found.sources.every(x => x.ok));

  const big = Buffer.alloc(2.5 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(s.boxWork, "big.bin"), big);
  const got = await s.macCall("files.fetch", { path: path.join(s.boxWork, "big.bin"), source: "box" });
  assert.ok(!got.error, JSON.stringify(got.error));
  assert.ok(got.data.local.startsWith(s.macRoot));
  assert.ok(fs.readFileSync(got.data.local).equals(big));
});

test("link: box events stream to the Mac, tagged with their source", async t => {
  const s = await pair(t);
  const seen = [];
  const sock = (await import("../core/config/index.js")).paths(s.macRoot).socket;
  const req = http.get({ socketPath: sock, path: "/v1/link/events?type=system.*&since=latest" }, res => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", c => { buf += c; for (const b of buf.split("\n\n").slice(0, -1)) { const d = b.split("\n").find(l => l.startsWith("data: ")); if (d) seen.push(JSON.parse(d.slice(6))); } buf = buf.slice(buf.lastIndexOf("\n\n") + 2); });
  });
  t.after(() => req.destroy());
  await wait(200);
  // A box event appears on the Mac's stream with source "box".
  s.box.events.emit("system", "system.started", { again: true });
  const e = await until(() => seen.find(x => x.payload && x.payload.again));
  assert.equal(e.source, "box");
});

test("link: a device that is not the owner is refused, and a Mac cannot approve itself", async t => {
  const s = await pair(t, { approve: false });
  // Another tailnet login cannot even start pairing.
  s.net.who = { login: "someone-else@example.com", node: "stranger", stableId: "nX" };
  const refused = await s.macCall("link.pair", { box: s.address });
  assert.match(refused.error.message, /does not serve this device/);

  s.net.who = MAC;
  const p = (await s.macCall("link.pair", { box: s.address })).data;
  // The Mac, over the tailnet, cannot approve its own request with the right code alone, nor with
  // a presence session (a proof made earlier): only a fresh passkey assertion on that Mac counts.
  const self = await s.boxCall("link.pair.approve", { code: p.code }, `tailnet:${OWNER}`, { peer: MAC });
  assert.match(self.error.message, /cannot approve its own pairing without one/);
  const session = await s.boxCall("link.pair.approve", { code: p.code }, `tailnet:${OWNER}`, { peer: MAC, presence: { method: "session" } });
  assert.match(session.error.message, /cannot approve its own/);
  // Claude on the box through MCP cannot approve, and a tailnet caller without a known node cannot.
  assert.ok((await s.boxCall("link.pair.approve", { code: p.code }, "mcp")).error);
  assert.ok((await s.boxCall("link.pair.approve", { code: p.code }, `tailnet:${OWNER}`)).error);
  // The code is never listed on the box. It carries the request's real created time, not just
  // when it expires, so waiting dates it exactly instead of guessing from the TTL.
  const pending = (await s.boxCall("link.pending")).data;
  assert.equal(pending.length, 1);
  assert.ok(!JSON.stringify(pending).includes(p.code.replace("-", "")));
  assert.equal(typeof pending[0].created, "number");
  assert.ok(pending[0].created <= pending[0].expires && pending[0].expires - pending[0].created <= 600_000);
  // Five wrong codes cancel every request.
  for (let i = 0; i < 4; i++) assert.match((await s.boxCall("link.pair.approve", { code: "000-000" === p.code ? "111-111" : "000-000" })).error.message, /no pairing request/);
  assert.match((await s.boxCall("link.pair.approve", { code: "000-000" === p.code ? "111-111" : "000-000" })).error.message, /too many wrong codes/);
  assert.equal((await s.boxCall("link.pending")).data.length, 0);

  // With a fresh passkey but a wrong code, nothing is approved.
  const r0 = (await s.macCall("link.pair", { box: s.address })).data;
  const wrongCode = r0.code === "123-456" ? "654-321" : "123-456";
  assert.match((await s.boxCall("link.pair.approve", { code: wrongCode }, `tailnet:${OWNER}`, { peer: MAC, presence: { method: "passkey" } })).error.message, /no pairing request/);
  // A fresh passkey on the asking Mac and its code: a Mac-only owner can pair.
  const mine = await s.boxCall("link.pair.approve", { code: r0.code }, `tailnet:${OWNER}`, { peer: MAC, presence: { method: "passkey" } });
  assert.ok(!mine.error, JSON.stringify(mine.error));
  await until(async () => (await s.macCall("link.status")).data.linked);
  await s.macCall("link.unpair");

  // Another of the owner's devices may approve (the Deck on a phone).
  const q = (await s.macCall("link.pair", { box: s.address })).data;
  assert.ok(!(await s.boxCall("link.pair.approve", { code: q.code }, `tailnet:${OWNER}`, { peer: PHONE })).error);
  await until(async () => (await s.macCall("link.status")).data.linked);

  // After pairing, a different login behind the same address is refused by the box.
  s.net.who = { login: "someone-else@example.com", node: "stranger", stableId: "nX" };
  const r = await s.macCall("link.call", { tool: "system.echo", input: { text: "x" } });
  assert.equal(r.error.code, "not_owner");
  assert.match(r.error.message, /does not recognise this device/);
  // And the Mac refuses a node other than the one it paired with.
  s.net.who = MAC;
  s.net.box = { stableId: "nOTHER", node: "impostor" };
  const other = await s.macCall("link.call", { tool: "system.echo", input: { text: "x" } });
  assert.match(other.error.message, /different node/);
});

test("link: files on the box are confined to its roots, through the link too", async t => {
  const s = await pair(t);
  const outside = fs.mkdtempSync(path.join(s.boxWork, "..", "vyre-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside the roots");
  fs.writeFileSync(path.join(s.boxWork, ".env"), "TOKEN=x");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(s.boxWork, "escape.txt"));
  for (const p of [path.join(s.boxWork, "..", path.basename(outside), "secret.txt"), path.join(outside, "secret.txt"),
    path.join(s.boxWork, "escape.txt"), path.join(s.boxWork, ".env"), "secret.txt"]) {
    for (const tool of ["files.stat", "files.preview", "files.fetch"]) {
      const r = await s.macCall(tool, { path: p, source: "box" });
      assert.ok(r.error, `${tool} ${p} is refused`);
      assert.ok(!JSON.stringify(r).includes("outside the roots") && !JSON.stringify(r).includes("TOKEN"));
    }
  }
  const found = (await s.macCall("files.search", { q: "e", where: "box" })).data;
  assert.ok(!found.results.some(r => /escape|\.env|secret/.test(r.name)), JSON.stringify(found.results));
});

test("link: with the box down, the Mac degrades to its own results and recovers", async t => {
  const s = await pair(t);
  const events = async type => (await request("GET", `/v1/events?type=${type}`, undefined, { root: s.macRoot })).data;
  // The first heartbeat after pairing announces the box; wait for it so the counts below are exact.
  await until(async () => (await events("link.connected")).length === 1);
  fs.writeFileSync(path.join(s.macWork, "notes-mac.md"), "x");
  fs.writeFileSync(path.join(s.boxWork, "notes-box.md"), "x");
  await s.stopTailnet();

  // The search answers with the Mac's own results and says the box's share failed.
  const found = (await s.macCall("files.search", { q: "notes" })).data;
  assert.deepEqual(found.results.map(r => r.source), ["mac"]);
  const boxSrc = found.sources.find(x => x.source === "box");
  assert.equal(boxSrc.ok, false);
  assert.ok(boxSrc.error);

  // The link notices, once, and says so in its status.
  await until(async () => (await events("link.lost")).length === 1);
  const st = await until(async () => { const v = (await s.macCall("link.status")).data; return !v.reachable && v; });
  assert.equal(st.linked, true);
  const call = await s.macCall("link.call", { tool: "system.echo", input: { text: "x" } });
  assert.match(call.error.message, /not reachable/);

  // The box event stream on the Mac says the box is down instead of hanging.
  const sock = (await import("../core/config/index.js")).paths(s.macRoot).socket;
  const down = await new Promise(resolve => {
    const timer = setTimeout(() => { req.destroy(); resolve(false); }, 20_000);
    const req = http.get({ socketPath: sock, path: "/v1/link/events" }, res => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", c => { buf += c; if (buf.includes("event: link.down")) { clearTimeout(timer); req.destroy(); resolve(true); } });
    });
    req.on("error", () => {});
  });
  assert.ok(down, "the proxied stream said link.down");
  assert.equal((await events("link.lost")).length, 1, "lost is said once, not on every failed beat");

  // The box comes back on the same address, and the heartbeat finds it.
  await s.startTailnet();
  await until(async () => (await events("link.connected")).length === 2);
  assert.equal((await s.macCall("link.status")).data.reachable, true);
  assert.deepEqual((await s.macCall("link.call", { tool: "system.echo", input: { text: "back" } })).data, { text: "back" });
});

test("link: a listener's tailnet peer reaches the tool through vyred's router, never its input", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [] }));
  // A module fronting its own listener, as names does: it establishes caller and peer itself.
  writeModule(path.join(root, "modules"), "peerprobe", { roles: ["box"], does: { tools: ["peerprobe.who"] } }, `
    import http from "node:http";
    export default { async start(ctx) {
      ctx.tool("peerprobe.who", { effect: "read", input: { type: "object" }, run: async (input, meta) => ({ input, caller: meta.caller, peer: meta.peer || null }) });
      const handle = ctx.handler({});
      const server = http.createServer((req, res) => handle(req, res, "tailnet:owner@example.com", { node: "test-mac", stableId: "nMAC", login: "owner@example.com" }));
      await new Promise(r => server.listen(0, "127.0.0.1", r));
      globalThis.__peerprobePort = server.address().port;
      return { async stop() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
    } };`);
  const d = await start({ presence: present, root, firstPartyRoots: [path.join(root, "modules")], log: () => {} });
  t.after(() => d.stop());
  const port = /** @type {any} */ (globalThis).__peerprobePort;
  const r = await fetch(`http://127.0.0.1:${port}/v1/tools/peerprobe.who`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peer: "forged" }) });
  const body = await r.json();
  assert.deepEqual(body.data.input, { peer: "forged" });
  assert.equal(body.data.caller, "tailnet:owner@example.com");
  assert.deepEqual(body.data.peer, { node: "test-mac", stableId: "nMAC", login: "owner@example.com" });
});

test("link: approving a pairing needs the owner's presence, whoever calls, and the prompt names the Mac, not the code", async t => {
  const boxRoot = tempHome(t);
  fs.writeFileSync(path.join(boxRoot, "config.json"), JSON.stringify({ role: "box", transcripts: [] }));
  // The real presence check, not the stand-in the other tests use.
  const box = await start({ root: boxRoot, log: () => {} });
  t.after(() => box.stop());
  if (!box.registry.deps.presence) return t.skip("this vyred has no presence check yet");
  const MAC_PEER = { node: "test-mac", stableId: "nMAC", login: OWNER };
  const p = (await box.registry.call("link.pair.request", { name: "work laptop" }, `tailnet:${OWNER}`, { peer: MAC_PEER })).data;
  for (const [caller, meta] of [["cli", {}], ["local", {}], [`tailnet:${OWNER}`, { peer: PHONE, person: { id: "s1", kind: "cookie" } }]]) {
    const r = await box.registry.call("link.pair.approve", { code: p.code }, caller, meta);
    assert.equal(r.error && r.error.code, "presence_required", `${caller} alone cannot approve`);
  }
  assert.equal((await box.registry.call("link.pending", {}, "cli")).data.length, 1, "refusals for presence do not cancel the request");
  const summary = await box.registry.tools.get("link.pair.approve").presence.summary({ code: p.code });
  assert.match(summary, /work laptop/);
  assert.ok(!summary.includes(p.code) && !summary.includes(p.code.replace("-", "")), "the code is never in the prompt");
});

/**
 * A fake tailscale binary for link.health: `status --json` and `ping` answered from world.json
 * beside it, every call logged to calls.log. Both vyreds in this process share it, as the Mac's
 * and the box's own CLIs would each know both nodes.
 */
function fakeTailscale(t, dir, world) {
  const bin = path.join(dir, "tailscale");
  fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const here = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, "calls.log"), args.join(" ") + "\\n");
const w = JSON.parse(fs.readFileSync(path.join(here, "world.json"), "utf8"));
if (args[0] === "status") { process.stdout.write(JSON.stringify(w.status)); process.exit(0); }
if (args[0] === "ping") { const ip = args[args.length - 1]; const line = w.ping[ip]; if (!line) { process.stderr.write("timeout waiting for ping reply\\n"); process.exit(1); } process.stdout.write(line + "\\n"); process.exit(0); }
process.stderr.write("the fake does not do " + args[0] + "\\n"); process.exit(1);
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  return { calls: () => { try { return fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } } };
}


/** The box reads its links from the Wink node (network.wink.status), not the Tailscale CLI: stand one in with the peers a test names (eid, via, since). */
function winkStub(s, peers) {
  const def = s.box.registry.tools.get("network.wink.status");
  const was = def.run;
  def.run = async () => ({ identity: null, spaces: [{ id: "spc_harlow", state: "connected", path: "direct", since: 1, peerList: peers }], relay: null, storage: [], clock: null });
  return () => { def.run = was; };
}

test("link: link.health on an unpaired Mac is unknown with a reason, and the seam can stand in", async t => {
  const s = await pair(t, { approve: false });
  const r = await s.macCall("link.health");
  assert.equal(r.data.path, "unknown");
  assert.match(r.data.why, /not paired/);
  assert.equal(r.data.cached, false);

  const asked = [];
  const stub = { check: async which => { asked.push(which); return { path: "peer-relay", relay: null, latencyMs: 40, lastHandshake: null, online: true, checkedAt: 1, cached: false }; } };
  const p = await pair(t, { health: stub });
  assert.equal((await p.macCall("link.health")).data.path, "peer-relay");
  assert.deepEqual(asked, [{ stableId: "nBOX" }]);
});

test("link.macs.call: a write for the person (threads.send, threads.answer) is refused when the call really came from a model, an agent or a module acting alone, whatever `as` and `by` claim", async t => {
  const s = await pair(t);
  const send = (origin, extra = {}) => s.boxCall("link.macs.call", { tool: "threads.send", input: { thread: "t1", text: "hi" }, as: "person", by: { caller: "deck" }, ...extra }, "module:switchboard", origin === undefined ? {} : { origin });
  for (const origin of ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness", "session:s1", "tailnet-guest:sam@harlow.example", "module:other"]) {
    const r = await send(origin);
    assert.equal(r.error && r.error.code, "denied", `origin ${origin} is refused`);
  }
  assert.equal((await send(undefined)).error?.code, "denied", "a module with no origin (a timer) is not the person");
  // the person's own surface gets through the gate (no Mac is online in this world, so nothing is delivered)
  for (const origin of ["cli", "deck", "capsule"]) assert.ok(!(await send(origin)).error, `origin ${origin} passes the person gate`);
  // a phone answering a Mac's thread: its own paired device is the origin and the caller named in `by`
  const phone = "device:abcdefghijklmnop";
  const viaPhone = await send(phone, { by: { caller: phone, device: "abcdefghijklmnop" } });
  assert.ok(!viaPhone.error, "a paired phone's own write passes the gate");
  assert.ok(viaPhone.data.length === 1 && (!viaPhone.data[0].error || viaPhone.data[0].error.code !== "denied"), "and gets as far as the Mac (offline or slow in this world), not refused by the gate");
});
