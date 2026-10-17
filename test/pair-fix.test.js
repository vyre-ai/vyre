// @ts-check
// Wink pairing as grants (core/wink): a typed code, two-sided, ends in one grant and a few events; an invitation becomes a membership;
// sharing a computer is a node.host grant; removal takes the grant and the device with it. A real vyred, the Node relay, a real typing
// device (relay/client/join.js). 127.0.0.1 only. Run on a runner or the test server (daemon tests never run on the person's Mac).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../core/daemon/index.js";
import { seams } from "../core/relay/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { FrameParser } from "../lib/ws.js";
import { resolveTicket, connect } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";
import { pairServer, parseServerPayload } from "../relay/client/serverpair.js";
import workerDir, * as WD from "../names/worker/index.js";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import { memorySeen, idDirectory } from "../lib/identity/directory.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { createIdentityOps } from "../core/spaces/identity-ops.js";
import { hooks as spacesHooks } from "../core/spaces/index.js";

// The short typed code is off in a release build; these tests exercise it, so they turn the development flag on (the daemon reads it at call time).
process.env.VYRE_WINK_TYPED_CODE = "1";
// A ring ticket is gated once the Wink module is up (X-1); the shared test helpers switch that off for tests of the relay's own pairing, and this file is the one that tests it.
delete process.env.VYRE_TEST_UNGATED_RING;
// The older tests pair with the three words alone; owning a server needs the identity proof in a real build (the proof tests below turn this off).
process.env.VYRE_TEST_PAIR_NO_PROOF = "1";

/** Takes any presence proof: refusals below are about who calls and what the module decides. */
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: proof.key || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const SCREEN = "device:abcdefghijklmnop";
const A = { ...PROOF, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };

async function world(t, opt = {}) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  // What the relay can read: the request line, headers and body of every plain request, and every WebSocket message from a device or a box after it has been unmasked (the relay's own view, as it forwards). A test reads it to prove what the relay never sees.
  /** @type {Buffer[]} */ const sniff = [];
  relay.server.prependListener("request", (/** @type {any} */ req) => { sniff.push(Buffer.from(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}`)); req.on("data", (/** @type {Buffer} */ c) => sniff.push(Buffer.from(c))); });
  relay.server.prependListener("upgrade", (/** @type {any} */ req, /** @type {any} */ socket, /** @type {Buffer} */ head) => {
    sniff.push(Buffer.from(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}`));
    const parser = new FrameParser();
    const feed = (/** @type {Buffer} */ c) => { try { for (const f of parser.push(c)) if ("message" in f) sniff.push(Buffer.from(/** @type {any} */ (f).message)); } catch { /* not a frame */ } };
    if (head && head.length) feed(head);
    socket.on("data", feed);
  });
  const logs = [];
  const root = tempHome(t);
  if (opt.seam) { seams.set(root, { ...(seams.get(root) || {}), ...opt.seam }); t.after(() => seams.delete(root)); }
  if (opt.pendingMs || opt.abandonMs) { seams.set(root, { ...(opt.pendingMs ? { pendingMs: opt.pendingMs } : {}), ...(opt.abandonMs ? { abandonMs: opt.abandonMs } : {}) }); t.after(() => seams.delete(root)); }
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ ...(opt.realPresence ? {} : { presence: lenient }), root, log: m => { logs.push(String(m)); if (process.env.WLOG) console.error(m); }, coreKeys: macCore(), kernelPresence: { check: async () => null }, ...(opt.kernel ? { kernel: true } : {}) });
  t.after(() => d.stop());
  const events = [];
  d.events.on("*", e => events.push([e.type, e.payload]));
  // With the kernel on, the owner's device is the facts the listener proves (a paired app row and a person session), never the label SCREEN stands for.
  let screenRow = false; // the screen's own paired row is made the first time it calls, so a test that never uses it sees none
  const screenFacts = { kind: "device", device_key_id: SCREEN.slice(7), person: d.kernel.id.owner, path: "relay", session: "ps1" };
  const call = (tool, input = {}, caller = SCREEN, meta = A) => (caller === SCREEN && meta && meta.person && !screenRow && (screenRow = true, d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'screen', 'p', 1, 'app', 0, NULL)").run(SCREEN.slice(7)), true), d.registry.call(tool, input, caller, caller === SCREEN && meta && meta.person && !meta.kernelFacts ? { ...meta, kernelFacts: screenFacts, kernel_proof: { op: "stand-in", fields: {}, n: 1 } } : meta));
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  return { d, url, root, events, call, status, logs, sniff };
}
const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };
const keystore = t => fileKeyStore(path.join(tempHome(t), "k.json"));

/** The names directory stand-in (the real Worker on the fake runtime) and a device that really claimed `alex` there: the identity a server's owner proof is checked against. */
async function standinIdentity(t) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const rt = createRuntime({ worker: workerDir, Class: WD.Directory, classes: { DIRECTORY: WD.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async () => [] } });
  let n = 0;
  const state = { down: false };
  const fetchDir = async (url, init) => { if (state.down) throw new Error("unreachable"); return workerDir.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": `198.51.${(n >> 8) & 255}.${n++ & 255}` } }), rt.env); };
  const seen = memorySeen();
  const store = fileIdentityStore(path.join(tempHome(t), "spaces"));
  const idDir = idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen });
  const ops = createIdentityOps({ store, dir: idDir, seen, now: () => clock.t, emit() {}, stretch: { memoryKiB: 64, passes: 1 } });
  await ops.create({ name: "alex", password: "four plain words here", deviceLabel: "Alex's phone", code: (await idDir.reserve("alex")).code });
  spacesHooks.fetch = /** @type {any} */ (fetchDir);
  spacesHooks.now = () => clock.t;
  t.after(async () => { spacesHooks.fetch = null; spacesHooks.now = null; await rt.settle(); });
  return { id: store.status().id, state, store, ops: () => store.ops(), clock, fetch: fetchDir,
    sign: async m => ({ eid: store.status().eid, sig: Buffer.from(await store.sign(Buffer.from(m))).toString("base64url") }) };
}

/** A box-less device pairs a fresh server and picks the words; resolves what the device then holds. */
async function pairFreshServer(t, { kind = "phone", about, presenceStorage = "hardware", ident = null, devKey = null, realPresence = false, ownerName = "Alex" } = {}) {
  ident = ident || await standinIdentity(t);
  // the real rule: a server is owned only with the identity proof, checked against the directory
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF;
  delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  t.after(() => { if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; });
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true, realPresence });
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = devKey ? devKey.presenceKey : { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: presenceStorage, ...(presenceStorage === "hardware" ? { signer: "secure_enclave" } : {}) };
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const owner = { id: ident.id, name: ownerName, vyre: "alex" };
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner, signIdentity: ident.sign, deviceKind: kind, keyStorage: presenceStorage, ...(about ? { about } : {}), name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey, pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
  await until(async () => shown);
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF)).data.yes, true);
  const done = await pairing;
  return { w, dk, ks, ident, owner, done, made, sign: m => crypto.sign("sha256", Buffer.from(m), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}


// ---- gated pairings finish: the typed code, the QR, a --pair-to server and a phone (the Mac and Windows apps, the iPhone and Android app all use these client calls) ----

/** The release defaults: the typed code is on. */
const typedOn = t => { const saved = process.env.VYRE_WINK_TYPED_CODE; process.env.VYRE_WINK_TYPED_CODE = "1"; t.after(() => { if (saved === undefined) delete process.env.VYRE_WINK_TYPED_CODE; else process.env.VYRE_WINK_TYPED_CODE = saved; }); };
const devKey = (storage = "software") => { const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); return { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage }; };
const setup = async (t, kernel = true) => {
  const ident = await standinIdentity(t);
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF;
  delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  t.after(() => { if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; });
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  return { ident, w: await world(t, { kernel }) };
};
const rows = (w, device) => w.d.registry.deps.db.prepare("SELECT id, kind FROM relay_devices WHERE id = ? AND removed_at IS NULL").all(device);

test("a phone that offers a key and does not say how it keeps it is refused out loud, with the reason, and nothing is paired", { timeout: 120_000 }, async t => {
  await assert.rejects(() => pairFreshServer(t, { kind: "phone", presenceStorage: /** @type {any} */ (null) }), /did not say how it keeps its key.*Update the Vyre app on this device, then pair again\./);
});

test("--pair-to server: the long code finishes at once with the identity's proof, and a wrong identity is refused", async t => {
  const { ident, w } = await setup(t);
  const made = (await w.call("wink.server.code", { qr: true, pairTo: ident.id }, "cli", PROOF)).data;
  const ks = keystore(t);
  const r = await pairServer({ payload: made.qr, owner: { id: ident.id, name: "Alex", vyre: "alex" }, signIdentity: ident.sign, deviceKind: "computer", keyStorage: "software", about: { kind: "web" }, name: "Alex's Mac",
    crypto: nodeCrypto(), keyStore: ks, presenceKey: devKey(), pollMs: 100 });
  assert.ok(r.paired && r.owner);
  assert.equal(rows(w, r.device).length, 1);
});

test("a device the box does not know is refused with words a client can tell from an unreachable box (the app lets a stale saved pairing go on them)", async t => {
  const w = await world(t);
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const seed = parseServerPayload(made.qr).seed;
  const { offer } = await resolveTicket(seed, { relay: w.status.url });
  const c = connect({ relay: w.status.url, route: offer.route, box: offer.box, name: "stale", crypto: nodeCrypto(), keyStore: keystore(t), backoff: { min: 50, max: 100 } });
  t.after(() => c.close());
  await until(() => c.lastError);
  assert.match(String(c.lastError.message), /not a paired device|closed|refus/i);
});

test("long code -> words -> adopt, real daemon and relay, typed code on (the release default): the app's pairServer finishes and the same key store reconnects as the paired device", async t => {
  typedOn(t);
  const { ident, w } = await setup(t);
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const ks = keystore(t);
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner: { id: ident.id, name: "Alex", vyre: "alex" }, signIdentity: ident.sign, deviceKind: "computer", keyStorage: "software", about: { kind: "web" }, name: "Alex's Mac",
    crypto: nodeCrypto(), keyStore: ks, presenceKey: devKey(), pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
  await until(async () => shown);
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF)).data.yes, true);
  const r = await pairing;
  assert.ok(r.paired && r.owner && r.session);
  const c = connect({ relay: w.status.url, route: r.route, box: r.box, name: "Alex's Mac", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  await until(() => c.state === "open");
  assert.equal(c.reply.device, r.device);
});

// ---- a phone added to a server that holds no identity: the owner's app signs the list change ----


// ---- the relay never sees the adopt call: both routes ----
// The adopt call (the owner, its proof, the device's key class, the passkey's rp) goes over the device-to-box Noise channel, and the relay only forwards ciphertext. The redeem step before it IS visible to the relay by
// design (the route, the device's name, the key it offers), so the test looks for what only the adopt call carries: a marker in the owner's name, the owner's identity id, and the field names of the call.
const NEEDLES = (/** @type {string} */ marker, /** @type {string} */ identityId) => [marker, identityId, '"keySigner"', '"keyRp"', '"peerSecret"', '"owner":{', '"proof":{'];
/** Does the marker appear anywhere the box kept (any table of its database), its events or its log? The control that the adopt call really carried it. */
const boxHas = (/** @type {any} */ w, /** @type {string} */ marker) => {
  if (JSON.stringify(w.events).includes(marker) || w.logs.join("\n").includes(marker)) return true;
  const db = w.d.registry.deps.db;
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) { try { if (JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).includes(marker)) return true; } catch { /* a virtual table */ } }
  return false;
};
const relaySaw = (/** @type {Buffer[]} */ sniff, /** @type {string[]} */ needles) => { const seen = Buffer.concat(sniff).toString("latin1"); return needles.filter(n => seen.includes(n)); };

test("the sniffer can see: a relay-visible message with the markers in it is caught, and one without is not", () => {
  const needles = NEEDLES("SNIFF-OWNER-1", "per_x");
  assert.deepEqual(relaySaw([Buffer.from('{"owner":{"name":"SNIFF-OWNER-1"},"keySigner":"tpm"}')], needles), ["SNIFF-OWNER-1", '"keySigner"', '"owner":{']);
  assert.deepEqual(relaySaw([Buffer.from("GET /v1/device?route=abc")], needles), []);
});

test("the relay never sees the adopt call on the QR / long-code route: the owner, its identity and the call's fields are not in anything the relay read", { timeout: 180_000 }, async t => {
  const marker = "SNIFF-OWNER-7f3a91c2";
  const r = await pairFreshServer(t, { kind: "phone", ownerName: marker });
  const saw = r.w.sniff;
  assert.ok(Buffer.concat(saw).length > 200, "the sniffer saw the relay's traffic");
  assert.ok(Buffer.concat(saw).toString("latin1").includes(r.done.route), "and it saw the redeem step, which is public to the relay by design (the control)");
  assert.ok(boxHas(r.w, marker) || JSON.stringify(r.done).includes(marker), "the adopt did carry the marker, and the box got it (the control)");
  assert.deepEqual(relaySaw(saw, NEEDLES(marker, r.ident.id)), [], "nothing that only the adopt call carries was readable by the relay");
});
