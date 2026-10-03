// @ts-check
// The Wink side of a bridged drive, with fakes: a fake engine (frames signed with HMAC-SHA256 as the pool engine does), a fake Wink link, a fake vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createBridgeSecrets, createBridgeEndpoint, makeBridgeSend, bridgeMakeBackend, pairFromHome, acceptDrive, localDriveDir, BRIDGE_TOOL, DRIVE_TOOL } from "./bridge.js";
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
  const callFrom = caller => ({ call: async (tool, input) => { wire.push({ tool, input: JSON.parse(JSON.stringify(input)) }); if (tool === BRIDGE_TOOL) return JSON.parse(JSON.stringify(await endpoint.handle(caller, input))); if (tool === DRIVE_TOOL) return drive(caller, input); throw new Error("no tool " + tool); } });
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
  const crossing = w.wire.filter(x => JSON.stringify(x).includes(secret));
  assert.deepEqual(crossing.map(x => x.tool), [DRIVE_TOOL], "the secret crosses once, in the hand-over, and in no bridge frame");
  const dump = JSON.stringify({ wire: w.wire.filter(x => x.tool !== DRIVE_TOOL), card, logs: [...w.logs, ...seen], sync, nodes: nodes.map(n => ({ ...n, backend: Object.keys(n.backend) })) });
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
