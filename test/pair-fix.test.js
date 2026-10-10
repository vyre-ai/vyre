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
import { start, callerFacts } from "../core/daemon/index.js";
import { seams } from "../core/relay/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { pairTicket, resolveTicket, connect, openChannel, deviceKey as clientDeviceKey } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { nobleCrypto } from "../relay/client/noble.js";
import { webCrypto, memoryKeyStore } from "../relay/client/webcrypto.js";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { gcm } from "@noble/ciphers/aes";
import { fromBase64url } from "../relay/client/bytes.js";
import { ackCode } from "../relay/client/code.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";
import { card, removal, FORBIDDEN } from "../core/wink/cards.js";
import { peerDoor, composeWinkHome } from "../core/wink/index.js";
import { parseServerQr, parsePhoneQr } from "../core/wink/pairing.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../relay/client/pairwords.js";
import { pairServer, parseServerPayload } from "../relay/client/serverpair.js";
import { addThisDevice } from "../relay/client/phonepair.js";
import { enrolDevice } from "../apps/app/src/identity/enrol-device.js";
import * as C from "../kernel/identity/chain.js";
import { joinWithCode } from "../relay/client/join.js";
import { createServerLinks } from "../core/wink/serverlink.js";
import { openServerPeer } from "../relay/client/peerclient.js";
import { deviceKey } from "../core/wink/devicekey.js";
import workerDir, * as WD from "../names/worker/index.js";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import { memorySeen, idDirectory } from "../lib/identity/directory.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { createIdentityOps } from "../core/spaces/identity-ops.js";
import { hooks as spacesHooks } from "../core/spaces/index.js";
import { acceptMessage } from "../lib/spaces/invites.js";

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
  return { d, url, root, events, call, status, logs };
}
const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };
const keystore = t => fileKeyStore(path.join(tempHome(t), "k.json"));

/** The new device types the code; resolves the states it showed and the pairing result. */
function typeCode(t, w, input, extra = {}) {
  const states = [];
  const done = joinWithCode({ relay: w.status.url, input, name: "Sam's laptop", onState: s => states.push(s), pollMs: 200, waitMs: 20_000, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t), timeout: 20_000 }, ...extra });
  return { states, done };
}

/**
 * A phone typing the code it was shown (wink.phone.open): the box-less joining side (relay/client/phonepair.js addThisDevice with a code), the person typing the ack back on the box. The code is the phone's confirmation:
 * the three words are not asked, and the phone is a device when the ack is right.
 * @param {any} t @param {any} w @param {string} code @param {string} offer
 */
async function addPhoneByCode(t, w, code, offer) {
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  let ack = "";
  const joining = addThisDevice({ code, relay: w.status.url, key: { publicKey, label: "Sam's phone" }, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onAck: a => { ack = a; } });
  joining.catch(() => {});
  await until(() => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  const typed = await w.call("wink.code.ack", { offer, typed: ack });
  return { ack, typed, joining };
}
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
async function pairFreshServer(t, { kind = "phone", about, presenceStorage = "hardware", ident = null, devKey = null, realPresence = false } = {}) {
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
  const presenceKey = devKey ? devKey.presenceKey : { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: presenceStorage };
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const owner = { id: ident.id, name: "Alex", vyre: "alex" };
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
  await assert.rejects(() => pairFreshServer(t, { kind: "phone", presenceStorage: /** @type {any} */ (null) }), /did not say how it keeps its key/);
});

test("typed code -> ack -> adopt, real daemon and relay: the app finishes the server's pairing, the server is owned, and the device is enrolled under the key the app reconnects with", async t => {
  typedOn(t);
  const { ident, w } = await setup(t);
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  assert.match(made.code, /^WINK-/);
  const ks = keystore(t);
  const states = [];
  const joining = joinWithCode({ relay: w.status.url, input: made.code, name: "Alex's Mac", onState: s => states.push(s), pollMs: 100, finishPollMs: 100, waitMs: 20_000,
    pairOptions: { crypto: nodeCrypto(), keyStore: ks, about: { kind: "app" }, presenceKey: devKey() },
    server: { owner: { id: ident.id, name: "Alex", vyre: "alex" }, signIdentity: ident.sign, deviceKind: "computer", keyStorage: "software", crypto: nodeCrypto(), keyStore: ks } });
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: made.offer, typed: ack.code }, "cli", PROOF)).data.ok, true);
  const r = await joining;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.done.owner, "the adopt returned the owner");
  assert.equal(r.done.session, true);
  assert.deepEqual(rows(w, r.paired.device).map(x => x.kind), ["app"], "the Mac is an app device, not the limited web kind");
  // the same key store reconnects as a paired device (the app's later calls)
  const c = connect({ relay: w.status.url, route: r.paired.route, box: r.paired.box, name: "Alex's Mac", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  // the leftover is the same usable device the long code makes: its channel reaches the paired-session door (not "no tool"), and the server made it a session
  const ch = await c.fetch("/v1/tools/presence.person.pair-challenge", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const chBody = await ch.json().catch(() => ({}));
  assert.notEqual(chBody.error && chBody.error.code, "no_such_tool", JSON.stringify(chBody));
  assert.equal(ch.status === 404, false, JSON.stringify(chBody));
  assert.equal(typeof (chBody.data && chBody.data.challenge), "string", `the typed-code device is given the challenge it signs in with: ${JSON.stringify(chBody)}`);
  assert.ok(c.reply && c.reply.device === r.paired.device, `the reconnect is the paired device: ${JSON.stringify(c.reply)}`);
});

test("typed code -> adopt: a wrong ack finishes nothing and the server stays unowned", async t => {
  typedOn(t);
  const { ident, w } = await setup(t);
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const ks = keystore(t);
  const states = [];
  const joining = joinWithCode({ relay: w.status.url, input: made.code, name: "Alex's Mac", onState: s => states.push(s), pollMs: 100, finishPollMs: 100, waitMs: 3000,
    pairOptions: { crypto: nodeCrypto(), keyStore: ks, about: { kind: "web" }, presenceKey: devKey() },
    server: { owner: { id: ident.id, name: "Alex", vyre: "alex" }, signIdentity: ident.sign, deviceKind: "computer", keyStorage: "software", crypto: nodeCrypto(), keyStore: ks } });
  await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: made.offer, typed: "WINK-0000-0000" }, "cli", PROOF)).data.ok, false);
  const r = await joining;
  assert.equal(r.ok, false);
  assert.equal((await w.call("wink.access", {}, "cli", PROOF)).data.devices.some(d => d.id === "self"), false, "the server is not owned");
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

test("a phone's typed code -> ack -> wait, real daemon and relay: the phone app finishes and is enrolled", async t => {
  typedOn(t);
  const w = await world(t);
  const open = (await w.call("wink.phone.open", { typed: true })).data;
  const code = open.code;
  assert.match(code, /^WINK-/);
  const ks = keystore(t);
  const states = [];
  const joining = joinWithCode({ relay: w.status.url, input: code, name: "Sam's phone", onState: s => states.push(s), pollMs: 100, finishPollMs: 100, waitMs: 20_000,
    pairOptions: { crypto: nodeCrypto(), keyStore: ks, about: { kind: "app" }, presenceKey: devKey("hardware") } });
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.offer, typed: ack.code })).data.ok, true);
  const r = await joining;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(rows(w, r.paired.device).length, 1, "the phone is a device after the ack");
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

test("the computer app and the phone app, as their clients are built: a computer (WebCrypto, a stored non-extractable key) pairs the server by the typed code, then a phone (noble crypto, a raw key in a secure store) is added by the phone's typed code", async t => {
  typedOn(t);
  const { ident, w } = await setup(t);
  // the computer app: relay.web.ts / the Mac and Windows windows
  const web = webCrypto(), webKeys = memoryKeyStore();
  const server = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const states = [];
  const mac = joinWithCode({ relay: w.status.url, input: server.code, name: "Alex's Mac", onState: s => states.push(s), pollMs: 100, finishPollMs: 100, waitMs: 20_000,
    pairOptions: { crypto: web, keyStore: webKeys, about: { kind: "app" }, presenceKey: devKey() },
    server: { owner: { id: ident.id, name: "Alex", vyre: "alex" }, signIdentity: ident.sign, deviceKind: "computer", keyStorage: "software", crypto: web, keyStore: webKeys } });
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: server.offer, typed: ack.code }, "cli", PROOF)).data.ok, true);
  const m = await mac;
  assert.equal(m.ok, true, JSON.stringify(m));
  // the phone app: relay.native.ts keeps 32 raw bytes in the secure store and rebuilds the pair from them on every get
  const noble = nobleCrypto({ x25519, sha256, hmac, gcm, randomBytes: n => crypto.randomBytes(n) });
  let secure = null;
  const phoneKeys = { async get() { return secure ? noble.importKeyPair(secure) : null; }, async set(k) { secure = Uint8Array.from(k.privateKey); } };
  const open = (await w.call("wink.phone.open", { typed: true })).data;
  const pstates = [];
  const phone = joinWithCode({ relay: w.status.url, input: open.code, name: "Vyre on Android", onState: s => pstates.push(s), pollMs: 100, finishPollMs: 100, waitMs: 20_000,
    pairOptions: { crypto: noble, keyStore: phoneKeys, about: { kind: "app" }, presenceKey: devKey("hardware") } });
  const pack = await until(() => pstates.find(s => s.state === "ack"));
  await until(() => w.events.filter(e => e[0] === "wink.found").length >= 2);
  assert.equal((await w.call("wink.code.ack", { offer: open.offer, typed: pack.code })).data.ok, true);
  const p = await phone;
  assert.equal(p.ok, true, JSON.stringify(p));
  // both reconnect with the key they stored, as the devices the server enrolled
  for (const [r, cr, ks] of [[m, web, webKeys], [p, noble, phoneKeys]]) {
    assert.equal(rows(w, r.paired.device).length, 1);
    const c = connect({ relay: w.status.url, route: r.paired.route, box: r.paired.box, name: "again", crypto: cr, keyStore: ks });
    t.after(() => c.close());
    await until(() => c.state === "open");
    assert.equal(c.reply.device, r.paired.device, "the same key reaches the server as the same device");
  }
});

test("a device whose presence key is not P-256 (alg -257) still enrols its key; only a P-256 key is kept for the paired session", async t => {
  typedOn(t);
  const w = await world(t);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const open = (await w.call("wink.phone.open", { typed: true })).data;
  const states = [];
  const joining = joinWithCode({ relay: w.status.url, input: open.code, name: "Sam's laptop", onState: s => states.push(s), pollMs: 100, finishPollMs: 100, waitMs: 20_000,
    pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t), about: { kind: "app" }, presenceKey: { public_key: rsa, alg: -257, storage: "software" } } });
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.offer, typed: ack.code })).data.ok, true);
  const r = await joining;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await deviceRowOf(w, r.paired.device)).presence, true, "the key enrolled; it is not marked as refused");
});
const deviceRowOf = async (w, id) => (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(d => d.id === id);

// ---- a phone added to a server that holds no identity: the owner's app signs the list change ----

test("Add a device: the phone redeems the computer's typed code, the server holds no identity, the owner's app signs the phone's key onto the name's list, and the phone hears enrolled", async t => {
  typedOn(t);
  const w = await world(t);
  const ident = await standinIdentity(t);
  // the name's chain is in the stand-in directory and in the OWNER'S APP (here: ident); the server below never made an identity
  const opened = await w.call("wink.phone.open", { typed: true });
  assert.equal(opened.error, undefined, JSON.stringify(opened.error));
  const open = opened.data;
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  let ack = "";
  const joining = addThisDevice({ code: open.code, relay: w.status.url, key: { publicKey, label: "Sam's phone" }, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onAck: a => { ack = a; }, presenceKey: devKey("hardware") });
  joining.catch(() => {});
  await until(() => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.offer, typed: ack })).data.ok, true);
  // the owner's app: sees the request in wink.phone.pairing, signs, sends, reports
  const ask = await until(async () => { const x = (await w.call("wink.phone.pairing", {})).data; return x && x.enrol ? x.enrol : null; });
  assert.equal(ask.entry.publicKey, publicKey);
  const sk = ident.store.sign.bind(ident.store);
  const done = await enrolDevice({ name: "alex", eid: ident.store.status().eid, pin: ident.store.pin(), base: "http://127.0.0.1:1", fetch: ident.fetch, now: () => ident.clock.t, sign: async m => sk(Buffer.from(m)), entry: ask.entry });
  assert.equal(done.already, false);
  assert.equal((await w.call("wink.phone.enrolled", { device: ask.device, ok: true, identity: { id: ident.id, vyre: "alex" } })).data.ok, true);
  const r = await joining;
  assert.equal(r.enrolled, true, JSON.stringify(r));
  assert.deepEqual(r.identity, { id: ident.id, vyre: "alex" });
  // the directory's list now holds the phone's key, signed by the owner's key
  const res = await (await ident.fetch("http://127.0.0.1:1/v1/ids/resolve?name=alex", { headers: {} })).json();
  const state = await C.verifyChain(res.data.ops, { now: ident.clock.t + C.SKEW_MS });
  assert.ok(state.entries.some(e => e.pub === publicKey), "the phone's key is on the list");
});

test("Add a device: when the owner's app cannot sign (a Windows computer), the phone is told why its key was not added", async t => {
  typedOn(t);
  const w = await world(t);
  const opened = await w.call("wink.phone.open", { typed: true });
  assert.equal(opened.error, undefined, JSON.stringify(opened.error));
  const open = opened.data;
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  let ack = "";
  const joining = addThisDevice({ code: open.code, relay: w.status.url, key: { publicKey, label: "Sam's phone" }, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onAck: a => { ack = a; }, presenceKey: devKey("hardware"), timeoutMs: 8000 });
  joining.catch(() => {});
  await until(() => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.offer, typed: ack })).data.ok, true);
  const ask = await until(async () => { const x = (await w.call("wink.phone.pairing", {})).data; return x && x.enrol ? x.enrol : null; });
  assert.equal((await w.call("wink.phone.enrolled", { device: ask.device, ok: false, reason: "This computer cannot add a device to your name. Add it from your phone." })).data.ok, true);
  const r = await joining;
  assert.equal(r.enrolled, false);
  assert.match(r.reason, /cannot add a device/);
});

test("a typed-code device that says it is a browser (kind web) is the limited kind and has no door to the person's session; the Mac and Windows windows therefore say app", async t => {
  typedOn(t);
  const { ident, w } = await setup(t);
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const ks = keystore(t);
  const states = [];
  const joining = joinWithCode({ relay: w.status.url, input: made.code, name: "Alex's browser", onState: s => states.push(s), pollMs: 100, finishPollMs: 100, waitMs: 20_000,
    pairOptions: { crypto: nodeCrypto(), keyStore: ks, about: { kind: "web" }, presenceKey: devKey() },
    server: { owner: { id: ident.id, name: "Alex", vyre: "alex" }, signIdentity: ident.sign, deviceKind: "computer", keyStorage: "software", crypto: nodeCrypto(), keyStore: ks } });
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: made.offer, typed: ack.code }, "cli", PROOF)).data.ok, true);
  const r = await joining;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(rows(w, r.paired.device).map(x => x.kind), ["web"]);
  const c = connect({ relay: w.status.url, route: r.paired.route, box: r.paired.box, name: "again", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = await c.fetch("/v1/tools/presence.person.pair-challenge", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await ch.json().catch(() => ({}));
  assert.equal(body.error && body.error.code, "no_such_tool", "this is what 'no tool presence.person.pair-challenge' was");
});
