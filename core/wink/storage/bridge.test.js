// @ts-check
// The Wink side of a bridged drive, with fakes: a fake engine (frames signed with HMAC-SHA256 as the pool engine does), a fake Wink link, a fake vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createBridgeSecrets, createBridgeEndpoint, makeBridgeSend, bridgeMakeBackend, pairFromHome, acceptDrive, localDriveDir, bridgeServe, resilientBackend, sealSecret, BRIDGE_TOOL, ACCEPT_TOOL } from "./bridge.js";
import { createHolds, holdDrive } from "./hold.js";
import { bridgedCard, bridgeAwayWords } from "./bridge-cards.js";
import { FORBIDDEN } from "../cards.js";
import { attachPool } from "./pool.js";

const sha = b => crypto.createHash("sha256").update(b ?? "").digest("hex");
const sign = (secret, { op, key, ts, body }) => crypto.createHmac("sha256", secret).update(`vyre-bridge-v1\n${op}\n${key}\n${ts}\n${sha(body)}`).digest("base64url");

/** The engine's createBridge in memory: same frame, same checks that matter here. */
function fakeCreateBridge({ secret, capacity }) {
  const files = new Map();
  return { files, async handle(f) {
    if (Math.abs(Date.now() - f.ts) > 60_000) return { status: 401 };
    if (sign(secret, { op: f.op, key: f.key ?? "", ts: f.ts, body: f.body }) !== f.sig) return { status: 401 };
    if (f.op === "ping") return { status: 200, body: Buffer.from(String(capacity)) };
    if (f.op === "put") { files.set(f.key, Buffer.from(f.body)); return { status: 200 }; }
    if (f.op === "get") return files.has(f.key) ? { status: 200, body: files.get(f.key) } : { status: 404 };
    files.delete(f.key); return { status: 200 };
  } };
}
function fakeBackendFor(c, offer, o) {
  const secret = o.bridge.secret(offer), send = o.bridge.send(offer.seenFrom, offer);
  const call = async (op, key = "", body) => { const ts = Date.now(); return send({ op, key, body, ts, sig: sign(secret, { op, key, ts, body }) }); };
  return { put: async (k, v) => { const r = await call("put", k, Buffer.from(v)); if (r.status !== 200) throw new Error("put " + r.status); },
    get: async k => { const r = await call("get", k); return r.status === 404 ? null : r.body; }, del: async k => { await call("del", k); }, ping: async () => Number(String((await call("ping")).body)) };
}
const fakeVault = () => { const items = new Map(); return { items, put: async ({ name, fields }) => { items.set(name, { ...fields }); }, fetch: async (n, f) => { const i = items.get(n); if (!i) throw new Error("none"); return i[f]; }, remove: async n => { items.delete(n); } }; };

/** Two devices, one wire between them: the home calls the drive's device, which proves who is calling. */
function world() {
  const dirD = fs.mkdtempSync(path.join(SCRATCH, "bridge-"));
  const homeVault = fakeVault(), devVault = fakeVault(), logs = [], wire = [];
  const homeSecrets = createBridgeSecrets({ vault: homeVault }), devSecrets = createBridgeSecrets({ vault: devVault });
  let liveNow = true, engine;
  const endpoint = createBridgeEndpoint({ createBridge: o => (engine = fakeCreateBridge(o)), secrets: devSecrets, live: () => liveNow, log: m => logs.push(m) });
  const drive = acceptDrive({ endpoint, secrets: devSecrets, home: () => "dev_home", exists: p => p === "/Volumes/Office" || fs.existsSync(p), roots: [dirD, "/Volumes"] });
  const callFrom = caller => ({ call: async (tool, input) => { wire.push({ tool, input: JSON.parse(JSON.stringify(input)) }); if (tool === BRIDGE_TOOL) return JSON.parse(JSON.stringify(await endpoint.handle(caller, input))); if (tool === ACCEPT_TOOL) return drive(caller, input); throw new Error("no tool " + tool); } });
  return { dirD, homeVault, devVault, homeSecrets, devSecrets, endpoint, logs, wire, callFrom, setLive: v => (liveNow = v), engine: () => engine };
}
const OFFER = { id: "sto_abc123", seenFrom: "dev_mini" };

async function pair(w, homeCaller = "device:dev_home") {
  await pairFromHome({ secrets: w.homeSecrets, linkTo: () => w.callFrom(homeCaller) }, { offer: OFFER.id, device: "dev_mini", kind: "usb-disk", location: { path: w.dirD }, capacity: 1e9 });
}

test("pairing makes one 32 byte secret, keeps it in both vaults, and the home then writes and reads through the wire", async () => {
  const w = world(); await pair(w);
  const a = await w.homeSecrets.get(OFFER.id), b = await w.devSecrets.get(OFFER.id);
  assert.equal(a, b); assert.equal(Buffer.from(a, "base64url").length, 32);
  const make = bridgeMakeBackend({ backendFor: fakeBackendFor, secrets: w.homeSecrets, linkTo: () => w.callFrom("device:dev_home") });
  const be = await make({ kind: "smb", location: { host: "nas", share: "Office" } }, OFFER);
  const chunk = crypto.randomBytes(300_000);
  await be.put("c/aa/one", chunk);
  assert.deepEqual(await be.get("c/aa/one"), chunk);
  assert.equal(await be.get("c/aa/none"), null);
  assert.equal(await be.ping(), 1e9);
  await be.del("c/aa/one"); assert.equal(await be.get("c/aa/one"), null);
  assert.equal(w.engine().files.size, 0);
});

test("a call from any device that is not the offer's owner device is refused before the engine sees it", async () => {
  const w = world(); await pair(w);
  const secret = await w.devSecrets.get(OFFER.id), ts = Date.now();
  const input = { offer: OFFER.id, op: "ping", key: "", ts, sig: sign(secret, { op: "ping", key: "", ts }) };
  await assert.rejects(() => w.endpoint.handle("device:dev_other", input), { code: "denied" });
  await assert.rejects(() => w.endpoint.handle("person:per_x", input), { code: "denied" });
  assert.equal((await w.endpoint.handle("device:dev_home", input)).status, 200);
  assert.ok(w.logs.some(l => /refused/.test(l)));
});

test("a wrong secret gets 401 from the engine, a stale offer or a taken grant is refused, and an unknown offer is not found", async () => {
  const w = world(); await pair(w);
  const ts = Date.now();
  const bad = { offer: OFFER.id, op: "ping", key: "", ts, sig: sign("x".repeat(43), { op: "ping", key: "", ts }) };
  assert.equal((await w.endpoint.handle("device:dev_home", bad)).status, 401);
  w.setLive(false);
  await assert.rejects(() => w.endpoint.handle("device:dev_home", bad), { code: "denied" });
  w.setLive(true);
  await assert.rejects(() => w.endpoint.handle("device:dev_home", { ...bad, offer: "sto_nope" }), { code: "not_found" });
  w.endpoint.stop(OFFER.id);
  await assert.rejects(() => w.endpoint.handle("device:dev_home", bad), { code: "not_found" });
});

test("a drive is accepted only from the home, only when this device sees it, and a failed pairing leaves no secret on either side", async () => {
  const w = world();
  const link = c => ({ call: (t, i) => w.callFrom(c).call(t, i) });
  const d = { offer: OFFER.id, device: "dev_mini", kind: "usb-disk", location: { path: w.dirD }, capacity: 1e9 };
  await assert.rejects(() => pairFromHome({ secrets: w.homeSecrets, linkTo: () => link("device:dev_other") }, d), { code: "denied" });
  await assert.rejects(() => pairFromHome({ secrets: w.homeSecrets, linkTo: () => link("device:dev_home") }, { ...d, location: { path: path.join(w.dirD, "gone") } }), { code: "not_found" });
  await assert.rejects(() => pairFromHome({ secrets: w.homeSecrets, linkTo: () => link("device:dev_home") }, { ...d, capacity: 0 }), { code: "bad_input" });
  await assert.rejects(() => pairFromHome({ secrets: w.homeSecrets, linkTo: () => link("device:dev_home") }, { ...d, kind: "smb", location: { mount: "/etc" } }), { code: "denied" });
  await assert.rejects(() => pairFromHome({ secrets: w.homeSecrets, linkTo: () => link("device:dev_home") }, { ...d, location: { path: path.join(w.dirD, "..", "..") } }), { code: "denied" });
  for (const v of [w.homeVault, w.devVault]) assert.equal(v.items.size, 0, "no secret left in either vault");
  assert.equal(w.endpoint.has(OFFER.id), false);
  await assert.rejects(() => acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => null })("device:dev_home", { ...d, secret: "s".repeat(43) }), { code: "not_found" });
  await assert.rejects(() => acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [w.dirD] })("device:dev_home", { ...d, secret: "short" , location: { path: w.dirD } }), { code: "bad_input" });
});

test("the secret is nowhere but the two vaults: not in the wire frames, cards, logs, the pool node or any call result", async () => {
  const w = world(); await pair(w);
  const secret = await w.homeSecrets.get(OFFER.id);
  const make = bridgeMakeBackend({ backendFor: fakeBackendFor, secrets: w.homeSecrets, linkTo: () => w.callFrom("device:dev_home") });
  const nodes = [], seen = [];
  const storage = { poolOffers: () => [{ id: OFFER.id, kind: "smb", location: { host: "nas", share: "Office" }, storage: { capacity: 1e9, class: ["cold", "backup"] }, seenFrom: "dev_mini" }], setUsed: () => {}, drainRequests: () => [] };
  const pool = { nodes: new Map(), addNode(n) { nodes.push(n); this.nodes.set(n.id, n); }, used: () => 0, drain: async () => ({ moved: 0 }) };
  const sync = await attachPool({ storage, pool, by: () => ({ kind: "person", id: "p" }), makeBackend: make, log: m => seen.push(m) }).sync();
  assert.deepEqual(sync.added, [OFFER.id]);
  assert.deepEqual(nodes[0].classes, ["cold", "backup"], "the device's classes reach the pool");
  await nodes[0].backend.put("c/x", Buffer.from("scrambled"));
  const card = bridgedCard({ name: "Office drive", owner: "Harlow Legal", capacity: 1.5e12, via: "Alex's Mac mini", classes: ["cold", "backup"] });
  assert.deepEqual(w.wire.filter(x => JSON.stringify(x).includes(secret)), [], "the secret is not in any call's input, not even the hand-over (it crosses sealed)");
  assert.ok(w.wire.some(x => x.tool === ACCEPT_TOOL && x.input.step === "seal" && x.input.box), "the hand-over carried a sealed box");
  const dump = JSON.stringify({ wire: w.wire, card, logs: [...w.logs, ...seen], sync, nodes: nodes.map(n => ({ ...n, backend: Object.keys(n.backend) })) });
  assert.ok(!dump.includes(secret), "no copy of the secret outside the vaults");
  assert.ok(!JSON.stringify([...w.homeVault.items].filter(([n]) => !n.startsWith("wink-bridge-"))).includes(secret));
});

test("a bridged drive with no secret on the home is skipped, not half built", async () => {
  const w = world();
  const make = bridgeMakeBackend({ backendFor: fakeBackendFor, secrets: w.homeSecrets, linkTo: () => w.callFrom("device:dev_home") });
  const storage = { poolOffers: () => [{ id: OFFER.id, kind: "smb", location: {}, storage: { capacity: 1, class: ["cold"] }, seenFrom: "dev_mini" }], setUsed() {}, drainRequests: () => [] };
  const r = await attachPool({ storage, pool: { nodes: new Map(), addNode() { throw new Error("no"); }, used: () => 0, drain: async () => ({ moved: 0 }) }, by: () => ({ kind: "person", id: "p" }), makeBackend: make }).sync();
  assert.deepEqual(r.added, []); assert.equal(r.skipped[0].why, "no_secret");
});

test("a frame too big for one Wink message is refused on both sides, and binary survives base64 whole", async () => {
  const w = world(); await pair(w);
  const send = makeBridgeSend({ linkTo: () => w.callFrom("device:dev_home") })("dev_mini", OFFER);
  assert.deepEqual(await send({ op: "put", key: "k", body: Buffer.alloc(21 * 1024 * 1024), ts: Date.now(), sig: "x" }), { status: 413 });
  const secret = await w.homeSecrets.get(OFFER.id), body = Buffer.from(Array.from({ length: 256 }, (_, i) => i)), ts = Date.now();
  assert.equal((await send({ op: "put", key: "k", body, ts, sig: sign(secret, { op: "put", key: "k", ts, body }) })).status, 200);
  assert.deepEqual(w.engine().files.get("k"), body);
});

test("localDriveDir finds the mounted folder on this device, and null when it is not here", () => {
  const has = new Set(["/Volumes/Office", "/mnt/disk1"]);
  const exists = p => has.has(p);
  assert.equal(localDriveDir({ share: "Office" }, { exists }), "/Volumes/Office");
  assert.equal(localDriveDir({ mount: "/mnt/disk1", share: "Office" }, { exists }), "/mnt/disk1");
  assert.equal(localDriveDir({ share: "Gone" }, { exists }), null);
  assert.equal(localDriveDir({ path: "/mnt/disk1" }, { kind: "usb-disk", exists }), "/mnt/disk1");
  assert.equal(localDriveDir({ share: "../../etc" }, { exists }), null);
});

test("the card says in plain words which device the drive hangs off, and uses none of the banned words", () => {
  const c = bridgedCard({ name: "Office drive", owner: "Harlow Legal", capacity: 1.5e12, via: "Alex's Mac mini", classes: ["cold", "backup"] });
  assert.match(c.allows, /Lets Harlow Legal keep encrypted copies on Office drive, up to 1\.5 TB, reached through Alex's Mac mini\./);
  assert.equal(c.who, "Office drive, reached through Alex's Mac mini");
  for (const s of [c.title, c.who, c.allows, c.goesInto, c.forHowLong, bridgeAwayWords({ name: "Office drive", via: "Alex's Mac mini", safe: true }), bridgeAwayWords({ name: "Office drive", via: "Alex's Mac mini", safe: false })]) {
    assert.ok(!FORBIDDEN.test(s), s); assert.ok(!/[—–§]/.test(s), s);
  }
  assert.ok(c.sensitive && c.primary === "Add storage");
});

test("the hand-over is sealed to the device's one-time key: a plain secret is refused, the key opens once, a late or wrong box does not open", async () => {
  const w = world();
  const d = { offer: OFFER.id, kind: "usb-disk", location: { path: w.dirD }, capacity: 1e9 };
  const drive = acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [w.dirD] });
  await assert.rejects(() => drive("device:dev_home", { ...d, step: "seal", secret: "s".repeat(43) }), { code: "bad_input" });
  const { pub } = await drive("device:dev_home", { ...d, step: "open" });
  const good = sealSecret(pub, OFFER.id, "k".repeat(43));
  await assert.rejects(() => drive("device:dev_home", { ...d, step: "seal", ...sealSecret(pub, "sto_other", "k".repeat(43)) }), { code: "denied" }, "a box sealed for another offer does not open here");
  await assert.rejects(() => drive("device:dev_home", { ...d, step: "seal", ...good }), { code: "denied" }, "the key is used once, even by a failed try");
  const second = await drive("device:dev_home", { ...d, step: "open" });
  assert.equal((await drive("device:dev_home", { ...d, step: "seal", ...sealSecret(second.pub, OFFER.id, "k".repeat(43)) })).ok, true);
  assert.equal(await w.devSecrets.get(OFFER.id), "k".repeat(43));
  let t = 0; const late = acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [w.dirD], now: () => t, ttlMs: 1000 });
  const o3 = await late("device:dev_home", { ...d, step: "open" }); t = 2000;
  await assert.rejects(() => late("device:dev_home", { ...d, step: "seal", ...sealSecret(o3.pub, OFFER.id, "z".repeat(43)) }), { code: "denied" });
});

/** The engine's bridge backend behind a flaky wire: the first `drop` calls never get an answer. */
function flaky(w, drop, how = "timeout") {
  let n = 0, dropped = 0;
  const link = { call: async (tool, input, opt) => { if (tool === BRIDGE_TOOL && input.op === "put" && n++ < drop) { dropped++; throw Object.assign(new Error("no answer to " + tool), { code: how }); } return w.callFrom("device:dev_home").call(tool, input, opt); } };
  return { link, dropped: () => dropped };
}

test("a put that times out is tried again for the same chunk and lands once; the node is not lost after one failed put", async () => {
  const w = world(); await pair(w);
  const f = flaky(w, 2);
  const make = bridgeMakeBackend({ backendFor: fakeBackendFor, secrets: w.homeSecrets, linkTo: () => f.link, retry: { baseMs: 1, sleep: async () => {} } });
  const be = await make({ kind: "smb" }, OFFER);
  const chunk = crypto.randomBytes(100_000);
  await be.put("c/ab/one", chunk);
  assert.equal(f.dropped(), 2); assert.equal(be.stats.retried, 2); assert.equal(be.stats.failedCalls, 0);
  assert.deepEqual(w.engine().files.get("c/ab/one"), chunk);
  assert.equal(w.engine().files.size, 1, "one chunk, however many tries");
  assert.deepEqual(await be.get("c/ab/one"), chunk);
});

test("tries are bounded per chunk, a refusal is not retried, and a disconnect is retried like a timeout", async () => {
  const w = world(); await pair(w);
  const f = flaky(w, 99, "unreachable");
  const be = resilientBackend((await bridgeMakeBackend({ backendFor: fakeBackendFor, secrets: w.homeSecrets, linkTo: () => f.link, retry: false })({ kind: "smb" }, OFFER)), { attempts: 3, baseMs: 1, sleep: async () => {} });
  await assert.rejects(() => be.put("k", Buffer.from("x")), { code: "unreachable" });
  assert.equal(f.dropped(), 3, "three tries, no more"); assert.equal(be.stats.failedCalls, 1);
  const waits = []; let tries = 0;
  const denied = resilientBackend({ put: async () => { tries++; throw Object.assign(new Error("no"), { code: "denied" }); }, get: async () => null, del: async () => {}, ping: async () => 1 }, { sleep: async ms => waits.push(ms) });
  await assert.rejects(() => denied.put("k", "v"), { code: "denied" }); assert.equal(tries, 1); assert.deepEqual(waits, []);
  const back = []; let k = 0;
  const slow = resilientBackend({ put: async () => { if (k++ < 3) throw Object.assign(new Error("t"), { code: "timeout" }); }, get: async () => null, del: async () => {}, ping: async () => 1 }, { sleep: async ms => back.push(ms), baseMs: 100 });
  await slow.put("k", "v"); assert.deepEqual(back, [100, 200, 400], "exponential backoff between tries");
});

test("ping keeps the last good answer through a short grace and a few misses, then says the drive is down", async () => {
  let t = 0, up = true;
  const be = resilientBackend({ put: async () => {}, get: async () => null, del: async () => {}, ping: async () => { if (!up) throw Object.assign(new Error("t"), { code: "timeout" }); return 7; } }, { now: () => t, grace: 10_000, failures: 3 });
  assert.equal(await be.ping(), 7); up = false;
  t = 1000; assert.equal(await be.ping(), 7); t = 2000; assert.equal(await be.ping(), 7);
  t = 3000; await assert.rejects(() => be.ping(), { code: "timeout" }, "three misses in a row");
  up = true; assert.equal(await be.ping(), 7); up = false; t = 20_000;
  await assert.rejects(() => be.ping(), { code: "timeout" }, "past the grace the first miss is final");
});

/** A fake peer session: call goes to `serve` on the other side after a tick; closed ends it. */
function fakeSession(serve) { const s = { closed: false, onclose: () => {}, call: async (tool, input) => { if (s.closed) throw Object.assign(new Error("closed"), { code: "unreachable" }); return JSON.parse(JSON.stringify(await serve(tool, JSON.parse(JSON.stringify(input))))); }, close(why) { if (!s.closed) { s.closed = true; s.onclose(why || "closed"); } } }; return s; }

test("the home calls down the connection the device holds open: the newest open session wins, a drop waits for the reconnect, and none says unreachable", async () => {
  const w = world(); await pair(w);
  const device = bridgeServe({ endpoint: w.endpoint, drive: () => { throw new Error("no"); }, home: () => "dev_home" });
  const holds = createHolds({ waitMs: 200 });
  assert.equal(holds.has("device:dev_mini"), false);
  await assert.rejects(() => holds.linkTo("dev_mini").call(BRIDGE_TOOL, {}), { code: "unreachable" });
  const secret = await w.homeSecrets.get(OFFER.id);
  const frame = () => { const ts = Date.now(); return { offer: OFFER.id, op: "ping", key: "", ts, sig: sign(secret, { op: "ping", key: "", ts }) }; };
  const s1 = fakeSession(device); holds.onSession("device:dev_mini", s1);
  assert.equal((await holds.linkTo("dev_mini").call(BRIDGE_TOOL, frame())).status, 200);
  s1.close("lost");
  const later = holds.linkTo("dev_mini").call(BRIDGE_TOOL, frame());           // made while the device is between connections
  setTimeout(() => holds.onSession("device:dev_mini", fakeSession(device)), 30);
  assert.equal((await later).status, 200, "the call waited for the device to come back");
  const s3 = fakeSession(device); holds.onSession("device:dev_mini", s3); s3.close();
  assert.equal(holds.has("dev_mini"), true, "an older open session still serves when the newest closed");
  await assert.rejects(() => device("wink.something.else", {}), { code: "denied" });
});

test("holdDrive connects, serves, and when the link stays down it closes it and reconnects after a wait that doubles and resets", async () => {
  const made = [], waits = []; let clock = 0;
  const mk = state => { const l = { st: state, closed: false, status: () => ({ state: l.st }), close() { l.closed = true; }, ready: async () => {} }; made.push(l); return l; };
  const states = ["connecting", "connecting", "connecting", "up"];
  const h = holdDrive({ connect: (space, o) => { assert.equal(space, "harlow"); assert.equal(typeof o.serve, "function"); return mk(states.shift()); }, serve: async () => {}, space: "harlow", stuckMs: 100, minMs: 10, maxMs: 40, checkMs: 5, now: () => clock, log: m => waits.push(m) });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 80 && made.length < 4; i++) { clock += 50; await wait(8); }
  assert.ok(made.length >= 4, "made " + made.length);
  assert.ok(made[0].closed && made[1].closed && made[2].closed, "stuck links were closed");
  assert.ok(waits.some(m => /10 ms|0\.0|0\.01/.test(m)) || waits.length >= 3);
  for (let i = 0; i < 10; i++) { clock += 50; await wait(8); }
  assert.equal(h.status().up, true); assert.equal(h.status().nextWaitMs, 10, "backoff resets once the link is up");
  h.stop(); assert.ok(made[3].closed);
});

test("the frame's nonce reaches the engine (it refuses a replayed one), and a retry makes a fresh frame so it is never a replay", async () => {
  const w = world(); await pair(w);
  const seenNonces = [];
  const real = w.engine().handle;
  w.engine().handle = async f => { seenNonces.push(f.nonce); return real(f); };
  const send = makeBridgeSend({ linkTo: () => w.callFrom("device:dev_home") })("dev_mini", OFFER);
  const secret = await w.homeSecrets.get(OFFER.id), ts = Date.now();
  await send({ op: "ping", key: "", ts, nonce: "n-abcdefgh", sig: sign(secret, { op: "ping", key: "", ts }) });
  assert.deepEqual(seenNonces, ["n-abcdefgh"]);
  let calls = 0; const sent = [];
  const be = resilientBackend({ put: async () => { calls++; const f = { nonce: `n${calls}` }; sent.push(f.nonce); if (calls < 3) throw Object.assign(new Error("bridge put 409"), {}); }, get: async () => null, del: async () => {}, ping: async () => 1 }, { sleep: async () => {} });
  await be.put("k", "v"); assert.deepEqual(sent, ["n1", "n2", "n3"], "each try is a new call, so a new frame and a new nonce");
});

// ---- Z-1: the roots check follows links (reviewer-3, 4 Oct 2026) ----
const frame = async (w, op = "ping") => { const secret = await w.devSecrets.get(OFFER.id), ts = Date.now(); return w.endpoint.handle("device:dev_home", { offer: OFFER.id, op, key: "", ts, sig: sign(secret, { op, key: "", ts }) }); };
async function offerVia(w, drive, location, kind = "usb-disk") {
  const d = { offer: OFFER.id, kind, location, capacity: 1e9 };
  const { pub } = await drive("device:dev_home", { ...d, step: "open" });
  const secret = "k".repeat(43);
  return drive("device:dev_home", { ...d, step: "seal", ...sealSecret(pub, OFFER.id, secret) });
}

test("Z-1: a link under a shared root that leaves the root is refused, and so is a root that is itself a link out; the folder served is the real one", async () => {
  const w = world();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "z1-root-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "z1-out-")));
  fs.symlinkSync(outside, path.join(root, "link"));
  const drive = acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [root] });
  await assert.rejects(() => offerVia(w, drive, { path: path.join(root, "link") }), { code: "denied" }, "root/link -> outside is not served");
  assert.equal(fs.readdirSync(outside).length, 0, "nothing was made outside the root");
  // a mount the device reports through such a link
  await assert.rejects(() => offerVia(w, drive, { mount: path.join(root, "link"), path: path.join(root, "link") }, "smb"), { code: "denied" });
  // a root that is itself a link (like macOS /Volumes/Macintosh HD -> /): the check uses its real path, so a folder outside it is refused through the link
  const rootLink = path.join(SCRATCH, `z1-rootlink-${crypto.randomBytes(3).toString("hex")}`);
  fs.symlinkSync(root, rootLink);
  const viaLinkRoot = acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [rootLink] });
  const good = path.join(root, "disk"); fs.mkdirSync(good);
  assert.equal((await offerVia(w, viaLinkRoot, { path: path.join(rootLink, "disk") })).ok, true, "a folder really under a linked root is fine");
  assert.equal(fs.realpathSync(path.join(good, `vyre-${OFFER.id}`)).startsWith(good), true);
  const escapeViaRoot = acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [rootLink] });
  await assert.rejects(() => offerVia(w, escapeViaRoot, { path: outside }), { code: "denied" });
  // a dangling link is refused too (a folder made through it would land wherever it points)
  fs.symlinkSync(path.join(outside, "not-yet"), path.join(root, "dangling"));
  await assert.rejects(() => offerVia(w, drive, { path: path.join(root, "dangling") }), { code: "denied" });
  // the offer's own folder planted as a link
  w.endpoint.stop(OFFER.id);
  const plant = path.join(root, "plant"); fs.mkdirSync(plant);
  fs.symlinkSync(outside, path.join(plant, `vyre-${OFFER.id}`));
  await assert.rejects(() => offerVia(w, drive, { path: plant }), { code: "denied" }, "vyre-<offer> as a link out is refused");
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("Z-1: a folder swapped for a link after it was opened is refused on the next operation, and a swap between the check and the open is refused", async () => {
  const w = world();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "z1-race-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "z1-raceout-")));
  const disk = path.join(root, "disk"); fs.mkdirSync(disk);
  const drive = acceptDrive({ endpoint: w.endpoint, secrets: w.devSecrets, home: () => "dev_home", roots: [root] });
  assert.equal((await offerVia(w, drive, { path: disk })).ok, true);
  assert.equal((await frame(w)).status, 200, "served while the folder is where it was");
  const mine = path.join(disk, `vyre-${OFFER.id}`);
  fs.rmSync(mine, { recursive: true }); fs.symlinkSync(outside, mine);
  await assert.rejects(() => frame(w), { code: "denied" }, "the folder became a link: refused before the engine sees the frame");
  // the same swap one level up (the disk folder itself)
  fs.unlinkSync(mine); fs.mkdirSync(mine);
  fs.renameSync(disk, path.join(root, "disk-old")); fs.symlinkSync(outside, disk);
  await assert.rejects(() => frame(w), { code: "denied" }, "a parent swapped for a link: refused");
  // a swap between the check and the open
  const w2 = world();
  const disk2 = path.join(root, "disk2"); fs.mkdirSync(disk2);
  const swapper = acceptDrive({ endpoint: w2.endpoint, secrets: w2.devSecrets, home: () => "dev_home", roots: [root],
    hooks: { afterCheck: () => { const m = path.join(disk2, `vyre-${OFFER.id}`); fs.rmSync(m, { recursive: true, force: true }); fs.symlinkSync(outside, m); } } });
  await assert.rejects(() => offerVia(w2, swapper, { path: disk2 }), { code: "denied" }, "swapped for a link between check and open");
  assert.equal(fs.readdirSync(outside).length, 0, "nothing was ever written outside the root");
});
