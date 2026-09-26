// @ts-check
// The link, end to end: two vyreds in two temp homes stand in for the Mac and the box. The
// tailnet is simulated at both ends. On the box, a small listener plays the part of the names
// module's tailnet listener: it identifies each connection with an injectable function (whois,
// in real life) and hands the request to the box's registry as `tailnet:<login>` with the peer
// node. On the Mac, the link's `verify` seam plays the Mac's own whois of the box's address.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { request } from "../core/daemon/client.js";
import { seams as linkSeams } from "../core/link/index.js";
import { seams as fileSeams } from "../core/files/index.js";
import { tempHome, writeModule } from "./helpers.js";

const OWNER = "owner@example.com";
const MAC = { login: OWNER, node: "test-mac", stableId: "nMAC" };
const PHONE = { login: OWNER, node: "test-phone", stableId: "nPHONE" };
const BOX = { stableId: "nBOX", node: "test-box" };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await wait(20); }
}

/** The box's tailnet listener, simulated: identity comes from `net.who`, never from a header. */
function tailnet(box, net, port = 0) {
  const server = http.createServer(async (req, res) => {
    const who = net.who;
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!who || who.login !== OWNER) return json(403, { error: { code: "not_owner", message: "not served" } });
    const url = new URL(req.url || "/", "http://box");
    if (req.method === "GET" && url.pathname === "/v1/health") return json(200, { data: { role: box.config.role, version: "0.0.0" } });
    if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
      let raw = "";
      for await (const c of req) raw += c;
      const r = await box.registry.call(decodeURIComponent(url.pathname.slice(10)), raw ? JSON.parse(raw) : {}, `tailnet:${who.login}`, { peer: who });
      return json(r.error ? 400 : 200, r);
    }
    if (req.method === "GET" && url.pathname === "/v1/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const since = url.searchParams.get("since");
      let cursor = since === "latest" ? box.events.latestId() : Number(since || 0);
      const write = e => { if (e.id > cursor) { cursor = e.id; res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); } };
      for (const e of box.events.since(cursor, { limit: 500 })) write(e);
      const off = box.events.on("*", write);
      req.on("close", off);
      return;
    }
    json(404, { error: { code: "not_found", message: url.pathname } });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** A box and a Mac, both running, with a work folder on each. */
async function pair(t, { approve = true } = {}) {
  const boxRoot = tempHome(t), macRoot = tempHome(t);
  const boxWork = fs.mkdtempSync(path.join(boxRoot, "..", "vyre-boxwork-"));
  const macWork = fs.mkdtempSync(path.join(macRoot, "..", "vyre-macwork-"));
  t.after(() => { fs.rmSync(boxWork, { recursive: true, force: true }); fs.rmSync(macWork, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(boxRoot, "config.json"), JSON.stringify({ role: "box", name: "testbox", transcripts: [], files: { roots: [boxWork] } }));
  fs.writeFileSync(path.join(macRoot, "config.json"), JSON.stringify({ role: "local", transcripts: [], files: { roots: [macWork] } }));
  const net = { who: /** @type {any} */ (MAC), box: /** @type {any} */ (BOX), address: "" };
  // Two peers on the simulated tailnet: the box, and the phone, whose node the box's address does not match.
  linkSeams.set(macRoot, { peers: async () => [{ ip: "127.0.0.1", dns: "test-box", stableId: "nBOX" }, { ip: "127.0.0.1", dns: "test-phone", stableId: "nPHONE" }],
    certNames: async () => [], addressOf: () => net.address, insecure: true, verify: async () => net.box, pollMs: 20, heartbeat: 100, hostname: "test-mac", timeout: 1500, ttl: 0 });
  // Spotlight, simulated: every file under the Mac's work folder whose name holds the query.
  fileSeams.set(macRoot, { platform: "darwin", remoteTimeout: 1500,
    mdfind: async args => fs.readdirSync(args[1]).filter(n => n.toLowerCase().includes(String(args[2]).toLowerCase())).map(n => path.join(args[1], n)) });
  t.after(() => { linkSeams.delete(macRoot); fileSeams.delete(macRoot); });

  // Stop the Mac first, so its heartbeat never reaches a box whose store is closed.
  /** @type {any} */ let mac = null, box = null, server = null;
  t.after(async () => {
    if (mac) await mac.stop();
    if (server) await new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); });
    if (box) await box.stop();
  });
  box = await start({ root: boxRoot, log: () => {} });
  server = await tailnet(box, net);
  mac = await start({ root: macRoot, log: () => {} });
  const address = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  net.address = address;
  for (const [n, d] of [["box", box], ["mac", mac]]) {
    const failed = d.registry.status().filter(m => ["link", "files"].includes(m.name) && m.state !== "running");
    assert.deepEqual(failed, [], `${n}: link and files are running`);
  }
  const macCall = (tool, input = {}, caller = "cli") => mac.registry.call(tool, input, caller);
  const boxCall = (tool, input = {}, caller = "cli", meta = {}) => box.registry.call(tool, input, caller, meta);
  let code = null;
  const find = (await macCall("link.find")).data;
  assert.deepEqual(find.boxes.map(b => b.node), ["test-box"], "only the node that is the box is offered");
  if (approve) {
    const p = await macCall("link.pair", { box: address });
    assert.ok(!p.error, JSON.stringify(p.error));
    code = p.data.code;
    assert.ok(!(await boxCall("link.pair.approve", { code })).error);
    await until(async () => (await macCall("link.status")).data.linked);
  }
  return { box, mac, net, macCall, boxCall, boxWork, macWork, macRoot, address, code,
    stopTailnet: () => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }),
    startTailnet: async () => { server = await tailnet(box, net, Number(new URL(address).port)); } };
}

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
  // The Mac, over the tailnet, cannot approve its own request, even with the right code.
  const self = await s.boxCall("link.pair.approve", { code: p.code }, `tailnet:${OWNER}`, { peer: MAC });
  assert.match(self.error.message, /cannot approve its own/);
  // Claude on the box through MCP cannot approve, and a tailnet caller without a known node cannot.
  assert.ok((await s.boxCall("link.pair.approve", { code: p.code }, "mcp")).error);
  assert.ok((await s.boxCall("link.pair.approve", { code: p.code }, `tailnet:${OWNER}`)).error);
  // The code is never listed on the box.
  const pending = (await s.boxCall("link.pending")).data;
  assert.equal(pending.length, 1);
  assert.ok(!JSON.stringify(pending).includes(p.code.replace("-", "")));
  // Five wrong codes cancel every request.
  for (let i = 0; i < 4; i++) assert.match((await s.boxCall("link.pair.approve", { code: "000-000" === p.code ? "111-111" : "000-000" })).error.message, /no pairing request/);
  assert.match((await s.boxCall("link.pair.approve", { code: "000-000" === p.code ? "111-111" : "000-000" })).error.message, /too many wrong codes/);
  assert.equal((await s.boxCall("link.pending")).data.length, 0);

  // Another of the owner's devices may approve (the Deck on a phone).
  const q = (await s.macCall("link.pair", { box: s.address })).data;
  assert.ok(!(await s.boxCall("link.pair.approve", { code: q.code }, `tailnet:${OWNER}`, { peer: PHONE })).error);
  await until(async () => (await s.macCall("link.status")).data.linked);

  // After pairing, a different login behind the same address is refused by the box.
  s.net.who = { login: "someone-else@example.com", node: "stranger", stableId: "nX" };
  const r = await s.macCall("link.call", { tool: "system.echo", input: { text: "x" } });
  assert.equal(r.error.code, "failed");
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
  fs.writeFileSync(path.join(s.macWork, "notes-mac.md"), "x");
  fs.writeFileSync(path.join(s.boxWork, "notes-box.md"), "x");
  await s.stopTailnet();
  const t0 = Date.now();
  const found = (await s.macCall("files.search", { q: "notes" })).data;
  assert.ok(Date.now() - t0 < 3000, "a down box does not hold up the search");
  assert.deepEqual(found.results.map(r => r.source), ["mac"]);
  const boxSrc = found.sources.find(x => x.source === "box");
  assert.equal(boxSrc.ok, false);
  const st = await until(async () => { const v = (await s.macCall("link.status")).data; return !v.reachable && v; });
  assert.equal(st.linked, true);
  const call = await s.macCall("link.call", { tool: "system.echo", input: { text: "x" } });
  assert.match(call.error.message, /not reachable/);
  // The box event stream on the Mac says the box is down instead of hanging.
  const sock = (await import("../core/config/index.js")).paths(s.macRoot).socket;
  const down = await new Promise(resolve => {
    const req = http.get({ socketPath: sock, path: "/v1/link/events" }, res => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", c => { buf += c; if (buf.includes("event: link.down")) { req.destroy(); resolve(true); } });
    });
    req.on("error", () => {});
  });
  assert.ok(down);
  const lost = (await request("GET", "/v1/events?type=link.lost", undefined, { root: s.macRoot })).data;
  assert.equal(lost.length, 1);

  // The box comes back on the same address, and the heartbeat finds it.
  await s.startTailnet();
  await until(async () => (await s.macCall("link.status")).data.reachable, 5000);
  const connected = (await request("GET", "/v1/events?type=link.connected", undefined, { root: s.macRoot })).data;
  assert.equal(connected.length, 2);
  assert.deepEqual((await s.macCall("link.call", { tool: "system.echo", input: { text: "back" } })).data, { text: "back" });
});

test("link: a listener's tailnet peer reaches the tool through vyred's router, never its input", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [] }));
  // A module fronting its own listener, as names does: it establishes caller and peer itself.
  writeModule(path.join(root, "modules"), "peerprobe", { roles: ["box"], does: { tools: ["peerprobe.who"] } }, `
    import http from "node:http";
    export default { async start(ctx) {
      ctx.tool("peerprobe.who", { input: { type: "object" }, run: async (input, meta) => ({ input, caller: meta.caller, peer: meta.peer || null }) });
      const handle = ctx.handler({});
      const server = http.createServer((req, res) => handle(req, res, "tailnet:owner@example.com", { node: "test-mac", stableId: "nMAC", login: "owner@example.com" }));
      await new Promise(r => server.listen(0, "127.0.0.1", r));
      globalThis.__peerprobePort = server.address().port;
      return { async stop() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
    } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const port = /** @type {any} */ (globalThis).__peerprobePort;
  const r = await fetch(`http://127.0.0.1:${port}/v1/tools/peerprobe.who`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peer: "forged" }) });
  const body = await r.json();
  assert.deepEqual(body.data.input, { peer: "forged" });
  assert.equal(body.data.caller, "tailnet:owner@example.com");
  assert.deepEqual(body.data.peer, { node: "test-mac", stableId: "nMAC", login: "owner@example.com" });
});
