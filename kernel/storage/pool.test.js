// @ts-check
// The storage pool: classes and copy counts, encryption before it leaves, healing, draining, capacity and the one number, quotas, residency.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool, CLASSES } from "./pool.js";
import { memoryBackend, dirBackend } from "./backends.js";
import { tmp } from "../seal/testing.js";

const KEY = Buffer.alloc(32, 7), code = p => p.then(() => null, e => e.code);
const MB = 1 << 20, rand = n => crypto.randomBytes(n);
/** A pool with a home and some other places, all in memory. */
function world(t, spec = { home: 10, nas: 10, cloud: 10 }, opts = {}) {
  const dir = tmp("pool"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000; const pool = new Pool({ dir, key: KEY, now: () => clock, chunk: MB, ...opts }), b = {};
  for (const [id, mb] of Object.entries(spec)) { b[id] = memoryBackend(); pool.addNode({ id, backend: b[id], home: id === "home", kind: id === "home" ? "server" : id === "nas" ? "network_drive" : "s3", site: id, offered: mb * MB }); }
  return { pool, b, dir, tick: ms => { clock += ms; }, holders: cid => pool.ix.chunks[cid].nodes };
}
const chunkIds = (pool, id) => pool.ix.manifests[id].chunks;

test("a round trip across chunks, and no node ever holds plaintext", async t => {
  const { pool, b } = world(t), data = Buffer.concat([rand(MB + 500), Buffer.from("Harlow Legal estate file ".repeat(5000))]);
  const r = await pool.put(data, { class: "working" });
  assert.equal(r.atRisk, false); assert.deepEqual(await pool.get(r.id), data);
  for (const be of Object.values(b)) for (const blob of be.m.values()) assert.equal(blob.includes(Buffer.from("Harlow Legal")), false);
  const other = new Pool({ dir: tmp("pool2"), key: Buffer.alloc(32, 9), chunk: MB }); const cid = chunkIds(pool, r.id)[0];
  assert.equal(other.open(cid, b.home.m.get(`c/${cid}`)), null, "another owner's key opens nothing");
});

test("classes: working is home plus one replica, cold is two nodes, backup is off the home, hot is refused", async t => {
  const { pool, holders } = world(t), d = rand(1000);
  const w = await pool.put(d, { class: "working" }), c = await pool.put(rand(1000), { class: "cold" }), k = await pool.put(rand(1000), { class: "backup" });
  const hw = holders(chunkIds(pool, w.id)[0]), hc = holders(chunkIds(pool, c.id)[0]), hk = holders(chunkIds(pool, k.id)[0]);
  assert.ok(hw.includes("home") && hw.length === 2); assert.equal(hc.length, 2); assert.equal(new Set(hc).size, 2);
  assert.ok(hk.length >= 1 && !hk.includes("home"), "a backup is never only on the home");
  assert.equal(await code(pool.put(d, { class: "hot" })), "hot_not_pooled");
  assert.equal(await code(pool.put(d, { class: "nope" })), "bad_class");
  assert.throws(() => pool.addNode({ id: "p", backend: memoryBackend(), kind: "phone" }), /phones_do_not/);
  assert.deepEqual(Object.keys(CLASSES).sort(), ["backup", "cold", "rebuildable", "working"]);
});

test("equal content is stored once, and removing one reader keeps it for the other", async t => {
  const { pool, b } = world(t), d = rand(3000);
  const a = await pool.put(d, { class: "cold" }), a2 = await pool.put(d, { class: "cold" });
  assert.equal(Object.keys(pool.ix.chunks).length, 1);
  await pool.remove(a.id); assert.deepEqual(await pool.get(a2.id), d);
  await pool.remove(a2.id); assert.equal(Object.keys(pool.ix.chunks).length, 0); assert.equal([...Object.values(b)].reduce((n, x) => n + x.m.size, 0), 0);
});

test("a node that drops out: reads keep working, the copy counts during the grace period, and past it healing makes a new one", async t => {
  const { pool, b, tick, holders } = world(t, { home: 10, nas: 10, cloud: 10, extra: 10 }), data = rand(MB * 2);
  const r = await pool.put(data, { class: "cold" }), cid = chunkIds(pool, r.id)[0], lost = holders(cid)[0];
  b[lost].down = true; assert.deepEqual(await pool.probe(), [lost]);
  assert.deepEqual(await pool.get(r.id), data, "a read comes from the other copy");
  assert.deepEqual(await pool.heal(), { copied: 0, atRisk: 0, unreachable: 0 }, "inside the grace period nothing moves");
  assert.match(pool.report().nudges.join(" "), /Nothing is at risk/);
  tick(11 * 60_000); const h = await pool.heal(); assert.ok(h.copied >= 1 && h.atRisk === 0);
  assert.ok(pool.held(pool.ix.chunks[cid]).length >= 2 && !pool.held(pool.ix.chunks[cid]).some(n => n.id === lost));
  assert.deepEqual(await pool.get(r.id), data);
});

test("a copy that was changed behind the pool's back is never returned, and the next copy is used", async t => {
  const { pool, b, holders } = world(t), d = rand(5000), r = await pool.put(d, { class: "cold" }), cid = chunkIds(pool, r.id)[0];
  const first = holders(cid)[0], blob = Buffer.from(b[first].m.get(`c/${cid}`)); blob[20] ^= 1; b[first].m.set(`c/${cid}`, blob);
  assert.deepEqual(await pool.get(r.id), d);
  for (const n of holders(cid)) { const x = Buffer.from(b[n].m.get(`c/${cid}`)); x[20] ^= 1; b[n].m.set(`c/${cid}`, x); }
  assert.equal(await code(pool.get(r.id)), "unavailable");
});

test("withdrawing a node drains it first, refuses when the others lack room, and a node lost for good is healed around", async t => {
  const { pool, b } = world(t, { home: 10, nas: 10, cloud: 10 }), data = rand(MB * 3), r = await pool.put(data, { class: "working" });
  await pool.put(rand(MB * 2), { class: "cold" });
  const out = await pool.drain("nas"); assert.ok(out.moved > 0); assert.equal(pool.nodes.has("nas"), true === false);
  assert.equal(b.nas.m.size, 0, "everything was copied off and cleared");
  assert.equal(pool.report().stored > 0, true); assert.deepEqual(await pool.get(r.id), data);
  for (const c of Object.values(pool.ix.chunks)) assert.ok(pool.satisfied(c));
  // Not enough room elsewhere: refused, the node stays.
  const small = world(t, { home: 4, nas: 4 }); await small.pool.put(rand(MB * 3), { class: "working" });
  assert.equal(await code(small.pool.drain("nas")), "no_room"); assert.equal(small.pool.nodes.has("nas"), true);
  // Lost for good.
  pool.forget("cloud"); const h = await pool.heal(); assert.equal(h.unreachable, 0); assert.deepEqual(await pool.get(r.id), data);
});

test("the one number is usable space after copies; rebuildable things are given up first and nothing else; a full pool says so and leaves nothing behind", async t => {
  const { pool, b } = world(t, { home: 5, nas: 5 });
  assert.equal(pool.report().usable, 5 * MB, "10 MB raw with two copies is 5 MB usable");
  const rb = await pool.put(rand(MB), { class: "rebuildable" }), w = await pool.put(rand(2 * MB), { class: "working" });
  assert.equal(await pool.evict(MB), MB); assert.equal(pool.ix.manifests[rb.id], undefined); assert.ok(pool.ix.manifests[w.id], "working data is never given up");
  assert.equal(await pool.evict(10 * MB), 0, "nothing else is evictable");
  const before = Object.values(b).map(x => x.m.size);
  assert.equal(await code(pool.put(rand(8 * MB), { class: "cold" })), "no_room", "a write that cannot be placed says so");
  assert.deepEqual(Object.values(b).map(x => x.m.size), before, "the failed write left no orphan chunks");
  assert.equal((await pool.get(w.id)).length, 2 * MB, "reads always work");
});

test("backups with no second place say so, and a meter stops one project filling the pool", async t => {
  const { pool } = world(t, { home: 10, nas: 10 }, { quotas: { "project:a": 3000 } });
  await pool.put(rand(100), { class: "backup" }); pool.forget("nas");
  assert.match(pool.report().nudges.join(" "), /Backups need a second place/);
  await pool.put(rand(2000), { class: "cold", meter: "project:a" });
  assert.equal(await code(pool.put(rand(2000), { class: "cold", meter: "project:a" })), "quota");
  assert.equal(pool.ix.meters["project:a"], 2000);
});

test("residency: a space that says owned places only uses nodes it owns", async t => {
  const dir = tmp("res"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new Pool({ dir, key: KEY, policy: { ownedOnly: true }, chunk: MB }), mine = memoryBackend(), rented = memoryBackend();
  pool.addNode({ id: "home", backend: mine, home: true, offered: 5 * MB }); pool.addNode({ id: "bucket", backend: rented, kind: "s3", owned: false, offered: 50 * MB });
  const r = await pool.put(rand(1000), { class: "cold" }); assert.equal(r.atRisk, true); assert.equal(rented.m.size, 0, "nothing went to the rented bucket");
  assert.equal(pool.report().raw_free <= 5 * MB, true);
});

test("a node with copies inside itself (a SeaweedFS service at replication 010) satisfies two copies alone", async t => {
  const dir = tmp("sw"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new Pool({ dir, key: KEY, chunk: MB }); pool.addNode({ id: "svc", backend: memoryBackend(), kind: "s3", copies: 2, offered: 5 * MB });
  assert.equal((await pool.put(rand(1000), { class: "cold" })).atRisk, false);
});

test("a directory node (a mounted drive) works and the index survives a restart", async t => {
  const dir = tmp("dirpool"), drive = tmp("drive"); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(drive, { recursive: true, force: true }); });
  const mk = () => { const p = new Pool({ dir, key: KEY, chunk: MB }); p.addNode({ id: "home", backend: dirBackend(path.join(drive, "home")), home: true, offered: 50 * MB }); p.addNode({ id: "usb", backend: dirBackend(path.join(drive, "usb")), offered: 50 * MB }); return p; };
  const p1 = mk(), data = rand(MB + 10), r = await p1.put(data, { class: "working" });
  assert.deepEqual(await mk().get(r.id), data);
  assert.deepEqual(await p1.probe(), []); assert.ok(p1.nodes.get("usb").deviceFree > 0);
  assert.ok(fs.readdirSync(drive, { recursive: true }).every(f => !String(f).endsWith(".tmp")));
});

test("the controller probes, heals when something changed, never ticks faster than 60 s, and withdraws a node by draining it", async t => {
  const { createController, MIN_TICK_MS } = await import("./controller.js");
  const { pool, b, tick } = world(t, { home: 10, nas: 10, cloud: 10, extra: 10 }), events = [], r = await pool.put(rand(MB), { class: "cold" });
  let every = 0; const c = createController({ pool, tickMs: 5, emit: e => events.push(e), setTimer: (fn, ms) => { every = ms; return {}; }, clearTimer: () => {} });
  c.start(); assert.equal(every, MIN_TICK_MS);
  assert.equal((await c.tick()).changed.length, 0); assert.equal(events.length, 0, "a quiet pool says nothing");
  const lost = pool.ix.chunks[pool.ix.manifests[r.id].chunks[0]].nodes.find(n => n !== "home"); b[lost].down = true;
  const out1 = await c.tick(); assert.deepEqual(out1.changed, [lost]); assert.equal(out1.copied, 0, "inside the grace period nothing moves");
  tick(11 * 60_000); const out = await c.tick(); assert.ok(out.copied >= 1, "past it, the missing copy is made"); assert.equal(events.at(-1).type, "storage.tick");
  b[lost].down = false; await c.tick();
  const w = await c.withdraw(lost); assert.ok(w.moved >= 0); assert.equal(events.at(-1).type, "storage.released"); assert.deepEqual(await pool.get(r.id), await pool.get(r.id));
});

test("devices: a paired bucket, volume or disk becomes a backend, a network drive only when mounted here, and a device's classes are honoured", async t => {
  const { backendFor } = await import("./devices.js");
  const drive = tmp("usb"); t.after(() => fs.rmSync(drive, { recursive: true, force: true }));
  assert.equal(typeof backendFor({ kind: "s3", location: { endpoint: "http://127.0.0.1:9", bucket: "b" }, accessKey: "k", secretKey: "s" }, { id: "dev1" }).put, "function");
  assert.equal(backendFor({ kind: "s3", location: { bucket: "b" }, accessKey: "k", secretKey: "s" }, { id: "dev1" }), null, "no endpoint, no backend");
  const usb = backendFor({ kind: "usb-disk", location: { path: drive } }, { id: "dev2" }); await usb.put("c/x", Buffer.from("hi")); assert.equal((await usb.get("c/x")).toString(), "hi");
  assert.equal(backendFor({ kind: "smb", location: { host: "nas.local", share: "office" } }, { id: "dev3" }), null, "not mounted here");
  assert.equal(typeof backendFor({ kind: "smb", location: { mount: drive } }, { id: "dev3" }).put, "function");
  // A cold-and-backup-only device never takes working data.
  const { pool } = world(t, { home: 10 }); pool.addNode({ id: "nas", backend: memoryBackend(), offered: 10 * MB, classes: ["cold", "backup"] });
  const w = await pool.put(rand(1000), { class: "working" }); assert.equal(w.atRisk, true, "working needs a second copy and only the home may hold it");
  const c = await pool.put(rand(1000), { class: "cold" }); assert.equal(c.atRisk, false); assert.ok(pool.ix.chunks[pool.ix.manifests[c.id].chunks[0]].nodes.includes("nas"));
});

test("bridge: a drive only another device can reach works as a pool node, authenticated, bounded and idempotent, with ciphertext on both ends", async t => {
  const { createBridge, serveBridge, httpSend, bridgeBackend, sign, WINDOW_MS } = await import("./bridge.js");
  const { backendFor } = await import("./devices.js");
  const root = tmp("bridge"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 5_000_000; const secret = "bridge-secret-0123456789", br = createBridge({ dir: path.join(root, "drive"), secret, capacity: 3 * MB, now: () => clock });
  const srv = await serveBridge(br); t.after(srv.close); const url = `http://127.0.0.1:${srv.port}`;
  const be = bridgeBackend({ secret, send: httpSend(url), now: () => clock });
  const v = rand(1000); await be.put("c/aa", v); assert.deepEqual(await be.get("c/aa"), v); assert.equal(await be.get("c/none"), null);
  assert.ok(await be.ping() > 0); await be.del("c/aa"); assert.equal(await be.get("c/aa"), null);
  // Wrong secret, stale time, a body altered after signing, bad key names: all refused.
  const bad = bridgeBackend({ secret: "another-secret-0123456789", send: httpSend(url), now: () => clock }); await assert.rejects(bad.put("c/x", v), /401/);
  const old = bridgeBackend({ secret, send: httpSend(url), now: () => clock - WINDOW_MS - 1 }); await assert.rejects(old.get("c/x"), /401/);
  const raw = await httpSend(url)({ op: "put", key: "c/y", body: Buffer.from("tampered"), ts: clock, nonce: "nonce-tamper-1", sig: sign(secret, { op: "put", key: "c/y", ts: clock, nonce: "nonce-tamper-1", body: Buffer.from("original") }) }); assert.equal(raw.status, 401);
  for (const k of ["../x", "a//b", "/abs", "c/%2e%2e/x"]) assert.equal((await br.handle({ op: "put", key: k, body: Buffer.from("x"), ts: clock, nonce: "nonce-key-" + Buffer.from(k).toString("hex"), sig: sign(secret, { op: "put", key: k, ts: clock, nonce: "nonce-key-" + Buffer.from(k).toString("hex"), body: Buffer.from("x") }) })).status, 400, k);
  // Capacity: 3 MB offered.
  await be.put("c/big1", rand(MB + 10)); await be.put("c/big2", rand(MB + 10)); await assert.rejects(be.put("c/big3", rand(MB + 10)), /full|507/);
  assert.equal(br.used, 2 * (MB + 10));
  // A pool whose home is local and whose second node is the bridge: end to end, the bridge holds only ciphertext.
  const { pool } = world(t, { home: 10 }); pool.addNode({ id: "office", backend: be, kind: "network_drive", offered: 3 * MB, site: "office" });
  await be.del("c/big1"); await be.del("c/big2");
  const secretText = "Harlow Legal estate plan ".repeat(2000), r = await pool.put(Buffer.from(secretText), { class: "cold" });
  assert.equal(r.atRisk, false); assert.equal((await pool.get(r.id)).toString(), secretText);
  for (const f of fs.readdirSync(path.join(root, "drive"), { recursive: true })) { const p = path.join(root, "drive", String(f)); if (fs.statSync(p).isFile()) assert.equal(fs.readFileSync(p).includes(Buffer.from("Harlow Legal")), false, "the bridge holds ciphertext"); }
  // backendFor picks the bridge for a drive no local mount reaches.
  const viaBridge = backendFor({ kind: "smb", location: { host: "nas.local", share: "office" }, seenFrom: "dev_office_mac" }, { id: "dev9" }, { bridge: { secret: () => secret, send: () => httpSend(url) } });
  assert.equal(typeof viaBridge.put, "function"); assert.equal(backendFor({ kind: "smb", location: { host: "nas.local" } }, { id: "dev9" }, { bridge: { secret: () => secret, send: () => httpSend(url) } }), null, "no device to go through, no backend");
});

test("review S-1: two writers at once get two versions and a conflict, not two version 1s", async t => {
  const { Drive } = await import("./drive.js"), dir = tmp("s1"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { pool } = world(t, { home: 10, nas: 10 }), drive = new Drive(pool);
  const [a, b] = await Promise.all([drive.put("f.txt", rand(500), { by: "a" }), drive.put("f.txt", rand(600), { by: "b" })]);
  assert.deepEqual([a.version, b.version].sort(), [1, 2]); assert.equal([a, b].filter(x => x.conflict).length, 1);
  assert.deepEqual(drive.history("f.txt").map(v => v.ver), [1, 2]);
});

test("review S-2 and S-7: a drain that cannot finish leaves the node counted, and concurrent passes never count a node twice", async t => {
  const { pool, b } = world(t, { home: 10, nas: 10 }), r = await pool.put(rand(MB), { class: "cold" });
  pool.nodes.get("nas").classes = null; b.home.down = true; // the only other place is away: the drain cannot finish
  await pool.probe(); assert.equal(await code(pool.drain("nas")), "no_room");
  assert.equal(pool.nodes.get("nas").draining, false, "nothing is left half withdrawn"); b.home.down = false; await pool.probe();
  const w = world(t, { home: 10, nas: 10, cloud: 10 }), x = await w.pool.put(rand(MB), { class: "cold" }), cid = w.pool.ix.manifests[x.id].chunks[0];
  await Promise.all([w.pool.ensure(cid), w.pool.ensure(cid), w.pool.ensure(cid)]);
  assert.equal(new Set(w.pool.ix.chunks[cid].nodes).size, w.pool.ix.chunks[cid].nodes.length, "no node listed twice");
  assert.equal(await code(w.pool.drain("home")), "home_stays");
});

test("review S-3 and S-9: emptied or corrupted copies are noticed and repaired, and a delete a node missed is retried", async t => {
  const { pool, b } = world(t, { home: 10, nas: 10, cloud: 10 }), data = rand(MB), r = await pool.put(data, { class: "cold" }), cid = pool.ix.manifests[r.id].chunks[0];
  const [n1, n2] = pool.ix.chunks[cid].nodes, c = () => pool.ix.chunks[cid];
  b[n1].m.clear(); // a node that still pings but has lost what it accepted
  assert.equal(pool.satisfied(c()), true, "before a scrub it still looks fine");
  let s = await pool.scrub({ limit: 10 }); assert.equal(s.dropped, 1); assert.ok(pool.satisfied(c()) && c().nodes.length === 2 && c().nodes.includes(n2), "healed from the good copy");
  const [m1, m2] = c().nodes, bad = Buffer.from(b[m1].m.get(`c/${cid}`)); bad[30] ^= 1; b[m1].m.set(`c/${cid}`, bad); // a copy changed behind its back
  s = await pool.scrub({ limit: 10 }); assert.equal(s.dropped, 1); assert.ok(pool.satisfied(c()), "repaired"); for (const n of c().nodes) assert.ok(pool.open(cid, b[n].m.get(`c/${cid}`)), "every counted copy opens"); assert.deepEqual(await pool.get(r.id), data);
  // A node that is away when a file is deleted keeps nothing once it answers: the delete is retried.
  const other = c().nodes[0]; b[other].down = true; await pool.probe(); await pool.remove(r.id);
  assert.ok(pool.ix.pending.some(p => p.node === other)); b[other].down = false; await pool.probe(); assert.equal(pool.ix.pending.length, 0); assert.equal(b[other].m.has(`c/${cid}`), false);
});

test("review S-4, S-5, S-6, S-8, S-10: the bridge server survives a bad escape, refuses before reading, a NaN time, a replayed frame, and an oversized reply or write", async t => {
  const { createBridge, serveBridge, httpSend, bridgeBackend, sign, MAX_BODY } = await import("./bridge.js"), http = await import("node:http");
  const root = tmp("s4"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = "bridge-secret-0123456789", br = createBridge({ dir: path.join(root, "d"), secret, capacity: 2 * MB }), srv = await serveBridge(br); t.after(srv.close);
  const url = `http://127.0.0.1:${srv.port}`, post = (p, headers, body) => new Promise(res => { const r = http.request(url + p, { method: "POST", agent: false, headers: { connection: "close", ...headers } }, x => { x.resume(); x.on("end", () => res(x.statusCode)); }); r.on("error", () => res(0)); r.end(body); });
  assert.equal(await post("/%E0%A4%A", { "x-vyre-op": "get", "x-vyre-ts": String(Date.now()), "x-vyre-sig": "x", "x-vyre-nonce": "nonce-12345" }), 400, "a bad escape is a 400, not a crash");
  assert.equal(await post("/c/x", {}), 400, "no headers, no read"); assert.equal(await post("/c/x", { "x-vyre-op": "put", "x-vyre-ts": String(Date.now()), "x-vyre-sig": "x", "x-vyre-nonce": "nonce-12345", "content-length": String(MAX_BODY + 1) }), 413);
  assert.equal(await post("/c/x", { "x-vyre-op": "ping", "x-vyre-ts": "NaN", "x-vyre-sig": "x", "x-vyre-nonce": "nonce-12345" }), 400, "a NaN time is refused");
  const be = bridgeBackend({ secret, send: httpSend(url) }); await be.put("c/ok", rand(10)); assert.ok(await be.ping() >= 0, "and the server is still up");
  // Replay: the same signed frame twice, the second is refused.
  const ts = Date.now(), nonce = "replay-nonce-1", f = { op: "get", key: "c/ok", ts, nonce, sig: sign(secret, { op: "get", key: "c/ok", ts, nonce }) };
  assert.equal((await httpSend(url)(f)).status, 200); assert.equal((await httpSend(url)(f)).status, 409, "a captured frame cannot be replayed");
  // A reply bigger than the cap is cut, and capacity is held under concurrent writes.
  const huge = http.createServer((q, r) => { r.writeHead(200); r.end(Buffer.alloc(9 * MB)); }); await new Promise(r => huge.listen(0, "127.0.0.1", r)); t.after(() => huge.close());
  await assert.rejects(bridgeBackend({ secret, send: httpSend(`http://127.0.0.1:${huge.address().port}`) }).get("c/x"), /too big/);
  const results = await Promise.allSettled([1, 2, 3].map(i => be.put("c/cap" + i, rand(MB)))); assert.ok(results.filter(r => r.status === "fulfilled").length <= 2 && br.used <= 2 * MB + 10, "two MB of room, no over-commit");
});

test("review S-11: the pool key is derived from the home's master for that purpose, per owner", async t => {
  const { startSealer } = await import("../seal/client.js"), dir = tmp("pk"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = startSealer({ dir, timeoutMs: 8000, dev: true }); t.after(() => s.close());
  const a = await s.poolKey({ owner: "per_alexalexalexalex" }), b = await s.poolKey({ owner: "spc_harlowharlowharlow" });
  assert.equal(a.length, 32); assert.notDeepEqual(a, b); assert.deepEqual(a, await s.poolKey({ owner: "per_alexalexalexalex" }));
  assert.equal(await code(s.poolKey({ owner: "nobody" })), "bad_input");
});

test("scrub scales with the pool to a two-week cycle, and when no copy opens it keeps every pointer and raises an alert instead of deleting", async t => {
  const { pool, b } = world(t, { home: 50, nas: 50, cloud: 50 });
  for (let i = 0; i < 12; i++) await pool.put(rand(MB / 4), { class: "cold" });
  const first = await pool.scrub({ cycleMs: 14 * 86_400_000, tickMs: 60_000 }); assert.equal(first.checked, 5, "a small pool still checks a few a tick");
  const big = Object.keys(pool.ix.chunks).length; for (let i = 0; i < 20_000 * 3; i++) pool.ix.chunks["x" + i] = { size: 1, nodes: [], refs: { m: "cold" } };
  const many = await pool.scrub({ cycleMs: 14 * 86_400_000, tickMs: 60_000 }); assert.ok(many.checked >= 3 && many.checked <= 5 + Math.ceil((big + 60_000) / 20_160), "scaled: " + many.checked);
  for (let i = 0; i < 20_000 * 3; i++) delete pool.ix.chunks["x" + i];
  // A wrong key (or a failing store) makes every copy fail to open: the pointers stay and an alert says so.
  const cid = Object.keys(pool.ix.chunks)[0], nodes = [...pool.ix.chunks[cid].nodes];
  for (const n of nodes) { const x = Buffer.from(b[n].m.get(`c/${cid}`)); x[40] ^= 1; b[n].m.set(`c/${cid}`, x); }
  const s = await pool.scrub({ limit: 1000 }); assert.ok(s.alerts >= 1); assert.deepEqual(pool.ix.chunks[cid].nodes, nodes, "no pointer was deleted");
  assert.ok(pool.alerts.has(cid)); assert.equal(pool.ix.chunks[cid].dropped, undefined);
  const events = [], { createController } = await import("./controller.js"), c = createController({ pool, emit: e => events.push(e), setTimer: () => ({}), clearTimer: () => {}, loaded: () => false }); await c.tick();
  assert.ok(events.some(e => e.type === "storage.alert"));
  // One bad copy beside a good one is dropped, and the drop is remembered for the cycle.
  const w = world(t, { home: 10, nas: 10, cloud: 10 }), r = await w.pool.put(rand(1000), { class: "cold" }), id = w.pool.ix.manifests[r.id].chunks[0], bad = w.pool.ix.chunks[id].nodes[0];
  const y = Buffer.from(w.b[bad].m.get(`c/${id}`)); y[40] ^= 1; w.b[bad].m.set(`c/${id}`, y);
  await w.pool.scrub({ limit: 100 }); assert.ok(w.pool.ix.chunks[id].dropped.some(d => d.node === bad), "the dropped copy is on the list for the cycle");
});

test("bridge: a frame signed before the bridge started is refused, so a restart does not reopen the replay window", async t => {
  const { createBridge, sign } = await import("./bridge.js"), root = tmp("epoch"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = "bridge-secret-0123456789"; let clock = 9_000_000;
  const frame = (ts, nonce) => ({ op: "ping", key: "", ts, nonce, sig: sign(secret, { op: "ping", key: "", ts, nonce }) });
  const first = createBridge({ dir: root + "/a", secret, now: () => clock }), captured = frame(clock, "captured-nonce-1");
  assert.equal((await first.handle(captured)).status, 200);
  clock += 10_000; const restarted = createBridge({ dir: root + "/a", secret, now: () => clock });
  assert.equal((await restarted.handle(captured)).status, 401, "the nonce table is gone but the frame predates this start");
  assert.equal((await restarted.handle(frame(clock, "fresh-nonce-0001"))).status, 200);
});
