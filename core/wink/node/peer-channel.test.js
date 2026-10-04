// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { SCRATCH } from "../../../test/scratch.mjs";
import { listenPeers, encodeHeader, decodeHeader, MAGIC, encodeRelayHeader, relayIdentity } from "./peer-channel.js";

const NK = "nodekey:" + "ab".repeat(32);
const ID = { nodeKey: NK, stableId: "12", tags: ["tag:device"], remoteAddr: "100.97.143.12:51234" };

async function world(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "pc-"));
  const sock = path.join(dir, "peers", "p.sock");
  const peers = /** @type {any[]} */ ([]), refused = /** @type {string[]} */ ([]);
  const l = await listenPeers({ path: sock, onPeer: (c, id) => { peers.push({ c, id }); c.resume(); }, onRefuse: w => refused.push(w), headerTimeoutMs: 400, ...extra });
  t.after(() => { for (const p of peers) p.c.destroy(); return l.close(); });
  return { dir, sock, l, peers, refused };
}

const send = (sock, ...bufs) => new Promise(resolve => {
  const c = net.connect(sock, () => { for (const b of bufs) c.write(b); });
  c.on("error", () => resolve("err")); c.on("close", () => resolve("closed"));
  setTimeout(() => resolve(c), 150);
});
const settle = () => new Promise(r => setTimeout(r, 100));

test("peer-channel: the socket is 0600 in a 0700 directory", async t => {
  const w = await world(t);
  if (process.platform === "win32") return;
  assert.equal(fs.statSync(w.sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(w.sock)).mode & 0o777, 0o700);
});

test("peer-channel: a forwarded connection arrives with the node key, id, tags and address, and the stream after the header intact", async t => {
  const w = await world(t);
  const got = /** @type {Buffer[]} */ ([]);
  const c = net.connect(w.sock);
  c.write(Buffer.concat([encodeHeader(ID), Buffer.from("hello")]));
  await settle();
  assert.equal(w.peers.length, 1);
  assert.deepEqual(w.peers[0].id, { via: "direct", ...ID });
  w.peers[0].c.on("data", (/** @type {Buffer} */ d) => got.push(d));
  c.write(" world");
  await settle();
  assert.equal(Buffer.concat(got).toString(), " world", "later bytes arrive; the first 'hello' was consumed before we attached");
  c.destroy();
});

test("peer-channel: the header may arrive in pieces; the bytes right behind it are not lost", async t => {
  const w = await world(t);
  const h = Buffer.concat([encodeHeader(ID), Buffer.from("tail")]);
  const bytes = /** @type {Buffer[]} */ ([]);
  const l2 = await listenPeers({ path: path.join(w.dir, "q", "q.sock"), onPeer: (c, id) => { c.on("data", d => bytes.push(d)); c.resume(); assert.equal(id.stableId, "12"); } });
  t.after(() => l2.close());
  const c = net.connect(l2.path);
  for (let i = 0; i < h.length; i += 5) { c.write(h.subarray(i, i + 5)); await new Promise(r => setTimeout(r, 5)); }
  await settle();
  assert.equal(Buffer.concat(bytes).toString(), "tail");
  c.destroy();
});

test("peer-channel: a missing or malformed header is refused and the connection destroyed", async t => {
  const w = await world(t);
  const good = encodeHeader(ID).subarray(8).toString();
  const frame = (/** @type {any} */ o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(8); MAGIC.copy(h); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const cases = [
    ["no magic", Buffer.from("GET / HTTP/1.1\r\n\r\n")],
    ["silence", Buffer.alloc(0)],
    ["zero length", Buffer.concat([MAGIC, Buffer.alloc(4)])],
    ["huge length", Buffer.concat([MAGIC, Buffer.from([0, 0, 0xff, 0xff])])],
    ["not json", Buffer.concat([MAGIC, Buffer.from([0, 0, 0, 3]), Buffer.from("abc")])],
    ["array", frame([1])],
    ["extra field", frame({ ...JSON.parse(good), name: "root" })],
    ["bad key", frame({ ...JSON.parse(good), nodeKey: "nodekey:zz" })],
    ["bad id", frame({ ...JSON.parse(good), stableId: "1 2" })],
    ["bad tag", frame({ ...JSON.parse(good), tags: ["admin"] })],
    ["loopback address", frame({ ...JSON.parse(good), remoteAddr: "127.0.0.1:5000" })],
    ["not a tailnet address", frame({ ...JSON.parse(good), remoteAddr: "10.0.0.5:5000" })],
    ["bad version", frame({ ...JSON.parse(good), v: 2 })],
  ];
  for (const [name, bytes] of cases) {
    const before = w.l.stats.refused;
    const r = await send(w.sock, bytes);
    await new Promise(res => setTimeout(res, name === "silence" ? 500 : 80));
    if (r && typeof r === "object") /** @type {net.Socket} */ (r).destroy();
    assert.equal(w.l.stats.refused, before + 1, name);
  }
  assert.equal(w.peers.length, 0);
  assert.equal(w.refused.length, cases.length);
});

test("peer-channel: a socket or directory widened after listen refuses the connection and stops the listener", async t => {
  if (process.platform === "win32") return;
  const w = await world(t);
  fs.chmodSync(path.dirname(w.sock), 0o755);
  await send(w.sock, encodeHeader(ID));
  await settle();
  assert.equal(w.peers.length, 0);
  assert.match(w.refused[0], /open to group or others/);
});

test("peer-channel: encode and decode agree", () => {
  const r = /** @type {any} */ (decodeHeader(Buffer.concat([encodeHeader(ID), Buffer.from("x")])));
  assert.deepEqual(r.id, { via: "direct", ...ID });
  assert.equal(r.used, encodeHeader(ID).length);
  assert.ok("need" in decodeHeader(encodeHeader(ID).subarray(0, 6)));
});

test("peer-channel: the relay form of the header carries the device and the space, and nothing a node would", () => {
  const r = decodeHeader(encodeRelayHeader({ deviceId: "srv1", space: "harlow" }));
  assert.deepEqual("id" in r && r.id, { via: "relay", deviceId: "srv1", space: "harlow" });
  assert.deepEqual(relayIdentity("srv1", "harlow"), { via: "relay", deviceId: "srv1", space: "harlow" });
  assert.throws(() => relayIdentity("bad id!", "harlow"));
  const j = o => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(8); MAGIC.copy(h, 0); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  assert.match(String(/** @type {any} */ (decodeHeader(j({ v: 1, via: "relay", deviceId: "a", space: "b", nodeKey: NK }))).error), /unknown header field/);
  assert.match(String(/** @type {any} */ (decodeHeader(j({ v: 1, via: "tailnet", deviceId: "a", space: "b" }))).error), /unknown path/);
  assert.match(String(/** @type {any} */ (decodeHeader(j({ v: 1, via: "relay", deviceId: "a b", space: "b" }))).error), /bad device id/);
});
