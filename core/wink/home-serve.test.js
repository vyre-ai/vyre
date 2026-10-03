// @ts-check
// homeServe: the home's peer door dispatcher (kernel-2's ask). A joined device calls through a real admitPeer/joinPeer pair over a loopback pipe; the
// kernel's withKernelCall is wrapped INSIDE homeServe so the proven node key reaches Wink first. peer-cache: the sync allow over wink.peer.allow.

import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homeServe } from "./index.js";
import { createPairing, MIGRATIONS, PEER_MIGRATIONS } from "./pairing.js";
import { createPeerAllowCache } from "./peer-cache.js";
import { admitPeer, joinPeer, socketPipe } from "./node/peer-wire.js";

const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const NK = "nodekey:" + "44".repeat(32);

async function sockets(t) {
  const server = net.createServer();
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = net.connect(server.address().port, "127.0.0.1");
  const b = await new Promise(r => server.once("connection", r));
  await new Promise(r => a.once("connect", r));
  t.after(() => { a.destroy(); b.destroy(); server.close(); });
  return { a, b };
}
function pairing() {
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  const p = createPairing({ ctx: { store: { db }, config: {}, log() {}, events: { emit() {} }, tool() {} }, now: Date.now, identity: async () => ME, space: async () => "harlow", directory: { memberships: async () => [] }, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "", spaceNow: () => "harlow" });
  p.devices.add({ id: "srv1", identity: ME, kind: "server", name: "juno", target: { kind: "identity", id: ME } });
  return p;
}
/** The kernel's own wrapper when its branch is in the tree (kernel/remote/wink.js, work/kernel-spaces), else a stand-in with the same shape. */
async function kernelWrapper() {
  const url = new URL("../../kernel/remote/wink.js", import.meta.url);
  if (fs.existsSync(url)) return { real: true, withKernelCall: (await import(url.href)).withKernelCall };
  return { real: false, withKernelCall: (next, o) => async (caller, tool, input) => {
    if (tool !== "kernel.call") return next(caller, tool, input);
    const m = /^device:([A-Za-z0-9_-]{1,64})$/.exec(String(caller));
    const server = m && o.serverFor(input.space);
    const person = m && await o.personOf(m[1], input.space);
    if (!server || !person) return { v: 1, id: input.id, ok: false, error: { code: "not_a_member", message: "no chain for this connection" } };
    return server.serve(input, { device_key_id: m[1], person, path: "wink" });
  } };
}

test("homeServe: a peer's call reaches the registry as device:<id>, kernel.call goes to the Space's server with the proven device, and the node key binds once", async t => {
  const p = pairing();
  const { a, b } = await sockets(t);
  const seen = [];
  const registry = async (caller, tool, input) => { seen.push([caller, tool]); return { tool, input }; };
  const k = await kernelWrapper();
  const served = [];
  const serve = homeServe(p.peers, k.withKernelCall(registry, {
    serverFor: space => (space === "harlow" ? { serve: async (req, peer) => { served.push([req, peer]); return { v: 1, id: req.id, ok: true, result: { members: ["alex"] } }; } } : null),
    personOf: (device, space) => (device === "srv1" ? "per_alex" : null),
    pathOf: () => "wink", // this test drives the direct door by hand; host.test.js covers the real legs (host.pathOf)
  }));
  // the host's own composition: direct peers pass the node key the connection proved
  const kp = crypto.generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const home = admitPeer(socketPipe(b), { id: { nodeKey: NK }, box: "box1", entry: eid => (eid === "srv1" ? { eid, kind: "device", pub } : null), serve: (c, tool, input) => serve(c, tool, input, { nodeKey: NK, stableId: "stable-x" }) });
  const session = await joinPeer(socketPipe(a), { device: "srv1", nodeKey: NK, sign: m => crypto.sign(null, m, kp.privateKey).toString("base64url") });
  await home;
  assert.deepEqual(await session.call("about.text", { q: 1 }), { tool: "about.text", input: { q: 1 } });
  assert.deepEqual(seen[0], ["device:srv1", "about.text"]);
  const r = await session.call("kernel.call", { v: 1, space: "harlow", id: "r1", call: "members.list", args: {} });
  assert.deepEqual(r, { v: 1, id: "r1", ok: true, result: { members: ["alex"] } });
  assert.deepEqual(served[0][1], { device_key_id: "srv1", person: "per_alex", path: "wink" });
  const gone = await session.call("kernel.call", { v: 1, space: "nowhere", id: "r2", call: "members.list", args: {} });
  assert.equal(gone.ok, false, "a refusal is data, not a wire error");
  session.close();
});

test("peer-cache: a sync allow over wink.peer.allow, a removal answers no at once, a pairing event refreshes", async () => {
  const handlers = new Map();
  const events = { on: (n, f) => { handlers.set(n, f); return () => handlers.delete(n); } };
  let live = new Set();
  let asked = 0;
  const c = createPeerAllowCache({ events, call: async (tool, input) => { asked++; return { data: { allow: live.has(input.device) } }; }, ttlMs: 60_000 });
  assert.equal(c.allow("srv1"), false, "a device never asked about is no, and is asked about now");
  await c.refresh("srv1");
  assert.equal(c.allow("srv1"), false);
  live.add("srv1");
  handlers.get("wink.pair-done")({ payload: { device: "srv1" } });
  await c.refresh("srv1");
  assert.equal(c.allow("srv1"), true);
  const n = asked;
  assert.equal(c.allow("srv1"), true);
  assert.equal(asked, n, "a fresh answer is not asked again");
  live.delete("srv1");
  handlers.get("wink.removed")({ payload: { device: "srv1" } });
  assert.equal(c.allow("srv1"), false, "removal answers no before the refresh returns");
  await c.refresh("srv1");
  assert.equal(c.allow("srv1"), false);
  // the identity port as the source: a removal event answers no at once, a list change answers no for everything until re-read
  const ids = new Set(["e1", "e2"]);
  const ic = createPeerAllowCache({ events, has: async eid => ids.has(eid) });
  await ic.refresh("e1"); await ic.refresh("e2");
  assert.equal(ic.allow("e1"), true);
  ids.delete("e1");
  handlers.get("identity.entry-removed")({ payload: { eid: "e1" } });
  assert.equal(ic.allow("e1"), false, "removed entry: no before the refresh");
  handlers.get("identity.changed")({});
  assert.equal(ic.allow("e2"), false, "a list change: no until read again");
  await new Promise(r => setImmediate(r)); await ic.refresh("e2");
  assert.equal(ic.allow("e2"), true);
  ic.stop();
  const bad = createPeerAllowCache({ events, call: async () => { throw new Error("down"); } });
  await bad.refresh("x");
  assert.equal(bad.allow("x"), false, "a failed call is a no");
  c.stop(); bad.stop();
  assert.equal(handlers.size, 0);
});
