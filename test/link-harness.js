// @ts-check
// The link's test harness: two vyreds in two temp homes stand in for the Mac and the box. The
// tailnet is simulated at both ends. On the box, a small listener plays the part of the names
// module's tailnet listener: it identifies each connection with an injectable function (whois,
// in real life) and hands the request to the box's registry as `tailnet:<login>` with the peer
// node. On the Mac, the link's `verify` seam plays the Mac's own whois of the box's address.
// test/link.test.js and test/link-federation.test.js share it.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start, callerFacts } from "../core/daemon/index.js";
import { seams as linkSeams } from "../core/link/index.js";
import { seams as fileSeams } from "../core/files/index.js";
import { writeTranscripts } from "./fixtures/corpus.js";
import { tempHome, present } from "./helpers.js";

export const OWNER = "owner@example.com";
export const MAC = { login: OWNER, node: "test-mac", stableId: "nMAC" };
export const PHONE = { login: OWNER, node: "test-phone", stableId: "nPHONE" };
export const BOX = { stableId: "nBOX", node: "test-box" };
export const wait = ms => new Promise(r => setTimeout(r, ms));

// Generous: under a loaded full-suite run a state change can take seconds, and a test that waits
// on state rather than a fixed sleep costs nothing extra when things are fast.
export async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await wait(20); }
}

/**
 * The box's tailnet listener, simulated: identity comes from `net.who`, never from a header.
 * With `router`, every request but health goes to vyred's real router, as the names listener
 * hands it (person sessions, /v1/person/token); without, straight to the registry.
 */
export function tailnet(box, net, port = 0, { router = false } = {}) {
  const handle = router ? box.registry.deps.handler({}) : null;
  const server = http.createServer(async (req, res) => {
    const who = net.who;
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!who || who.login !== OWNER) return json(403, { error: { code: "not_owner", message: "not served" } });
    const url = new URL(req.url || "/", "http://box");
    if (handle && url.pathname !== "/v1/health") return handle(req, res, `tailnet:${who.login}`, who);
    if (req.method === "GET" && url.pathname === "/v1/health") return json(200, { data: { role: box.config.role, version: "0.0.0" } });
    if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
      let raw = "";
      for await (const c of req) raw += c;
      // The listener's own proof of who is calling (what the daemon's route hands the registry): the owner's tailnet device, a paired app row so the device is enrolled.
      const label = `tailnet:${who.login}`, node = "aaaaaaaaaaaaaaaa"; // a test peer's id ("nMAC") is shorter than a device id may be, so the row carries a well-formed one
      if (box.kernel) box.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)").run(node);
      const f0 = box.kernel ? callerFacts(label, { caller: label, peer: who }, null, box.kernel, false, null) : null, facts = f0 ? { ...f0, device_key_id: node } : null;
      const r = await box.registry.call(decodeURIComponent(url.pathname.slice(10)), raw ? JSON.parse(raw) : {}, label, { peer: who, ...(facts ? { kernelFacts: facts } : {}) });
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

/**
 * A box and a Mac, both running, with a work folder on each.
 * @param {any} t
 * `t` needs only `name` and `after(fn)`, so a script (web/test/mac-world.js) can pass its own.
 * @param {any} t
 * @param {{ approve?: boolean, hold?: number, allow?: string[], macTranscripts?: boolean | any[], boxTranscripts?: any[], health?: any,
 *   boxName?: string, macHost?: string, heartbeat?: number, boxConfig?: any, kernel?: boolean }} [opts]
 *   hold: how long the box holds link.serve (short, so stopping is quick); allow: the box's list of
 *   tools it may ask the Mac for, to reach the Mac's own check; macTranscripts: the Mac indexes the
 *   fixture corpus (true), or these sessions in the corpus's shape, so it has sessions for the box
 *   to read; boxTranscripts: sessions (in the corpus's shape) the box indexes as its own, so a
 *   federated read has rows from both; health: the Mac's link.health check (a fake tailscale), for
 *   link.health's tests; boxName, macHost: the box's config name and the Mac's hostname (the name
 *   the box knows it by); heartbeat: the Mac's check-in interval in ms; boxConfig: more of the
 *   box's config.json; router: the box's tailnet goes through vyred's real router; boxPresence:
 *   the box's presence verifier; kernel: start both with the kernel on (the planner keeps its records there).
 */
export async function pair(t, { approve = true, hold = 300, allow, macTranscripts = false, boxTranscripts, health = undefined,
  boxName = "testbox", macHost = "test-mac", heartbeat = 100, boxConfig = {}, macConfig = {}, router = false, boxPresence = present, macSeam = {}, kernel = undefined } = {}) {
  const boxRoot = tempHome(t), macRoot = tempHome(t);
  const boxWork = fs.mkdtempSync(path.join(boxRoot, "..", "vyre-boxwork-"));
  const macWork = fs.mkdtempSync(path.join(macRoot, "..", "vyre-macwork-"));
  t.after(() => { fs.rmSync(boxWork, { recursive: true, force: true }); fs.rmSync(macWork, { recursive: true, force: true }); });
  let boxSessions = [];
  if (boxTranscripts) { boxSessions = [path.join(boxRoot, "transcripts")]; writeTranscripts(boxSessions[0], boxTranscripts); }
  fs.writeFileSync(path.join(boxRoot, "config.json"), JSON.stringify({ role: "box", name: boxName, transcripts: boxSessions, files: { roots: [boxWork] },
    ...(boxTranscripts ? { recall: { every: 0, vectors: false } } : {}), ...boxConfig }));
  let macSessions = [];
  if (macTranscripts) { macSessions = [path.join(macRoot, "transcripts")]; writeTranscripts(macSessions[0], Array.isArray(macTranscripts) ? macTranscripts : undefined); }
  fs.writeFileSync(path.join(macRoot, "config.json"), JSON.stringify({ role: "local", transcripts: macSessions, files: { roots: [macWork] },
    ...(macTranscripts ? { recall: { every: 0, vectors: false } } : {}), ...macConfig }));
  const net = { who: /** @type {any} */ (MAC), box: /** @type {any} */ (BOX), address: "" };
  // Two peers on the simulated tailnet: the box, and the phone, whose node the box's address does not match.
  linkSeams.set(macRoot, { peers: async () => [{ ip: "127.0.0.1", dns: "test-box", stableId: "nBOX" }, { ip: "127.0.0.1", dns: "test-phone", stableId: "nPHONE" }],
    certNames: async () => [], addressOf: () => net.address, insecure: true, verify: async () => net.box, pollMs: 20, heartbeat, hostname: macHost, timeout: 1500, ttl: 0, hold, ...(health ? { health } : {}), ...macSeam });
  linkSeams.set(boxRoot, { hold, ...(allow ? { allow } : {}) });
  // Spotlight, simulated: every file under the Mac's work folder whose name holds the query.
  fileSeams.set(macRoot, { platform: "darwin", remoteTimeout: 1500,
    mdfind: async args => fs.readdirSync(args[1]).filter(n => n.toLowerCase().includes(String(args[2]).toLowerCase())).map(n => path.join(args[1], n)) });
  t.after(() => { linkSeams.delete(macRoot); linkSeams.delete(boxRoot); fileSeams.delete(macRoot); });

  // Stop the Mac first, so its heartbeat never reaches a box whose store is closed.
  /** @type {any} */ let mac = null, box = null, server = null;
  t.after(async () => {
    if (mac) await mac.stop();
    if (server) await new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); });
    if (box) await box.stop();
  });
  box = await start({ presence: boxPresence, root: boxRoot, log: () => {}, ...(kernel !== undefined ? { kernel } : {}) });
  server = await tailnet(box, net, 0, { router });
  mac = await start({ presence: present, root: macRoot, log: () => {}, ...(kernel !== undefined ? { kernel } : {}) });
  const address = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  net.address = address;
  for (const [n, d] of [["box", box], ["mac", mac]]) {
    const failed = d.registry.status().filter(m => ["link", "files"].includes(m.name) && m.state !== "running");
    assert.deepEqual(failed, [], `${n}: link and files are running`);
  }
  // With the kernel on, a call is the person's only by the facts the daemon's listener proves, never by its label (MH-1, LB-1): this stands in for the listener, for the person's own surfaces and for the
  // owner's tailnet device, so these tests keep saying who is calling in one word.
  const factsFor = (/** @type {any} */ d, /** @type {string} */ caller, /** @type {any} */ meta) => {
    if (!d.kernel || (meta && meta.kernelFacts)) return meta;
    if (["cli", "deck", "capsule"].includes(caller)) return { ...meta, kernelFacts: { kind: "socket", surface: caller, uid: typeof process.getuid === "function" ? process.getuid() : 0, pid: 0, inside_model_process: false, capsule_verified: caller === "capsule" } };
    // The device is enrolled only if the box knows it as a paired app (spaces.devices.enrolled): a well-formed id (eight characters or more) gets that row here, as pairing would have made it.
    if (caller.startsWith("tailnet:") && meta && meta.peer && /^[A-Za-z0-9_-]{8,64}$/.test(String(meta.peer.stableId || meta.peer.node || ""))) d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)").run(String(meta.peer.stableId || meta.peer.node));
    if (caller.startsWith("tailnet:") && meta && meta.peer) { const f = callerFacts(caller, { caller, peer: meta.peer }, null, d.kernel, false, null); return f ? { ...meta, kernelFacts: f } : meta; }
    return meta;
  };
  const macCall = (tool, input = {}, caller = "cli", meta = {}) => mac.registry.call(tool, input, caller, factsFor(mac, caller, meta));
  const boxCall = (tool, input = {}, caller = "cli", meta = {}) => box.registry.call(tool, input, caller, factsFor(box, caller, meta));
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
  return { box, mac, net, macCall, boxCall, boxWork, macWork, macRoot, boxRoot, address, code,
    stopTailnet: () => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }),
    startTailnet: async () => { server = await tailnet(box, net, Number(new URL(address).port), { router }); } };
}
