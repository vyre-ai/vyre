// @ts-check
// The last quarter of test/wink.test.js (the first half is wink.test.js, the next quarter wink-paired.test.js), split off to stay under the 300 s per-file limit; the helpers are the same.
// Wink pairing as grants (core/wink): a typed code, two-sided, ends in one grant and a few events; an invitation becomes a membership;
// sharing a computer is a node.host grant; removal takes the grant and the device with it. A real vyred, the Node relay, a real typing
// device (relay/client/join.js). 127.0.0.1 only. Run on a runner or the test server (daemon tests never run on the person's Mac).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
// This file has 33 cases of 5 to 20 s that can outrun the 300 s per-file limit on a loaded machine. The cases are dealt out to 3 files (wink-paired-2.test.js and its -b.. siblings, which set VYRE_WINK_PAIRED2_SHARD and import this module), each well inside the per-file limit even on a loaded machine.
const SHARDS = 3;
const SHARD = Number(process.env.VYRE_WINK_PAIRED2_SHARD ?? 0);
let dealt = 0;
const shardTest = (/** @type {any[]} */ ...a) => (dealt++ % SHARDS === SHARD ? /** @type {any} */ (test)(...a) : undefined);
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start, callerFacts } from "../core/daemon/index.js";
import { seams } from "../core/relay/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { joinWithCode } from "../relay/client/join.js";
import { pairTicket, resolveTicket, connect, openChannel, deviceKey as clientDeviceKey } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import { ackCode } from "../relay/client/code.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";
import { card, removal, FORBIDDEN } from "../core/wink/cards.js";
import { peerDoor, composeWinkHome } from "../core/wink/index.js";
import { parseServerQr, parsePhoneQr } from "../core/wink/pairing.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../relay/client/pairwords.js";
import { pairServer, parseServerPayload } from "../relay/client/serverpair.js";
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
  const d = await start({ ...(opt.realPresence ? {} : { presence: lenient }), root, log: m => { logs.push(String(m)); if (process.env.WLOG) console.error(m); }, coreKeys: macCore(), ...(opt.kernel ? { kernel: true } : {}), ...(opt.kernelSealer ? { kernelSealer: opt.kernelSealer } : {}) });
  t.after(() => d.stop());
  const events = [];
  d.events.on("*", e => events.push([e.type, e.payload]));
  const call = (tool, input = {}, caller = SCREEN, meta = A) => d.registry.call(tool, input, caller, meta);
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








async function pairDevice(t, w) {
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found" && e[1].offer === open.data.offer));
  await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code });
  return (await done).paired.device;
}
/** The app's side of a fresh server ask (commit, hear nb, reveal): the words, and a call that completes the adopt. `seed` is the QR's secret, or none for a typed code. */
async function askServer(w, id, seed, owner) {
  const na = newNonce(), commit = await nonceCommit(na), ticket = seed ? Buffer.from(seed).toString("base64url") : "";
  const base = { commit, ...(seed ? { tag: await ticketTag(ticket) } : {}) };
  const mk = more => w.call("wink.server.adopt", { owner, identity: owner.id, pairing: { ...base, ...more } }, `device:${id}`, {});
  const r1 = (await mk({})).data;
  const r2 = (await mk({ reveal: na })).data;
  return { na, nb: r1.nb, ticket, first: r1, words: r2.words, until: r2.until, again: () => mk({ reveal: na }) };
}
/** The phone's side of a fresh phone ask over wink.phone.wait: commit (with its name), hear nb, reveal. */
async function askPhone(w, id, seed, name) {
  const na = newNonce(), commit = await nonceCommit(na), ticket = Buffer.from(seed).toString("base64url");
  const as = `device:${id}`;
  // the box holds a waiting phone when the relay says so (an event), a moment after the redemption
  const r1 = await until(async () => (await w.call("wink.phone.wait", { commit, tag: await ticketTag(ticket), ...(name ? { name } : {}) }, as, {})).data);
  const r2 = (await w.call("wink.phone.wait", { commit, reveal: na }, as, {})).data;
  return { na, nb: r1.nb, ticket, first: r1, words: r2.words };
}
const relayHas = async (w, id) => (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.some(d => d.id === id);









/** Pairs one computer the typed-code way and returns its device id. */
async function pairComputer(t, w) {
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code })).data?.ok, true);
  const r = await done;
  assert.equal(r.ok, true);
  return r.paired.device;
}








// ---- X-1 (ruling, 4 Oct 2026): nothing exists for a redeemer until the confirm ----

/** A call over a redeemer's own channel to the box, as the relay hands it: { status, body } (status 0 when it never answered). */
async function over(c, tool, input = {}) {
  try {
    const r = await Promise.race([c.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), new Promise((_, rej) => setTimeout(() => rej(new Error("no answer")), 5000))]);
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: String(/** @type {any} */ (e).message) }; }
}
/** A redeemer: it redeems a ticket from its own key file, offering a presence key, and can open its own channel to the box afterwards. */
async function redeem(t, w, seed, name = "Redeemer", extra = {}) {
  const ks = keystore(t);
  const presenceKey = { public_key: crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 };
  const paired = await pairTicket(seed, { relay: w.status.url, name, crypto: nodeCrypto(), keyStore: ks, presenceKey, ...extra });
  const open = () => { const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name, crypto: nodeCrypto(), keyStore: ks }); t.after(() => c.close()); return c; };
  return { paired, ks, open };
}
const deviceRow = async (w, id) => (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(d => d.id === id);
/** Every tool the review probed, plus the ones a waiting pairing must never see, whatever kind of ticket it came from. */
const PROBED = ["relay.devices.list", "wink.access", "relay.status", "system.info", "wink.pair.targets", "threads.list", "term.list", "vault.list", "presence.person.start", "presence.enroll", "relay.devices.remove", "relay.devices.drop", "relay.pair.pending.confirm",
  "relay.pair.ticket", "relay.pair.window.open", "wink.phone.pair.answer", "wink.phone.pairing", "wink.phone.open", "wink.server.pair.answer", "wink.server.pairing", "wink.server.code", "wink.server.reset", "wink.server.release", "wink.server.retarget", "wink.remove",
  "wink.offer.set", "wink.pair.server", "wink.storage.remove", "wink.device.key", "wink.relay.apply", "about.text", "identity.sign"];


/** What the home itself says about a device that redeemed a ticket: its own relay row (the PH-1 input) and the person facts the daemon would build for a call that device makes. */
async function homeSaysAbout(w, id) {
  const row = (await w.d.registry.call("relay.device.info", { id }, "module:vyred")).data || null;
  const facts = callerFacts(`device:${id}`, { caller: `device:${id}` }, null, { id: { owner: "per_owner" } }, false, row);
  return { row, facts };
}

for (const withQr of [false, true]) {
  test(`R-2, real daemon and relay: a plain ring ticket (relay.pair.ticket) is a waiting pairing ${withQr ? "while a QR is open" : "on its own"}: no row of any kind, no presence key, no person chain, one tool; the pick makes the row`, async t => {
    const w = await world(t, { pendingMs: 3000 });
    const enrolled = lenient.enrolled.length;
    const qr = withQr ? (await w.call("wink.phone.open", {})).data : null;
    const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
    assert.ok(minted.data?.ticket, JSON.stringify(minted.error));
    assert.equal((await w.d.registry.call("relay.pair.gate", {}, "module:wink")).error?.code, "no_such_tool", "no module has to tell the relay to gate: the gate is not a switch");
    const r = await redeem(t, w, fromBase64url(minted.data.ticket), "Ring interloper");
    assert.equal(r.paired.pending, true, "the redemption made a waiting pairing, not a device");
    assert.equal(await relayHas(w, r.paired.device), false, "no relay device row");
    assert.equal(await deviceRow(w, r.paired.device), undefined);
    const home = await homeSaysAbout(w, r.paired.device);
    assert.equal(home.row, null, "the home holds no row, so no kind app for it");
    assert.equal(home.facts, null, "callerFacts gives the redeemer no person chain");
    assert.equal(lenient.enrolled.length, enrolled, "no presence key was enrolled");
    const c = r.open();
    assert.equal((await over(c, "wink.phone.wait", { name: "Ring interloper" })).status, 200, "its own pairing wait is the one thing it reaches");
    for (const tool of PROBED) { const o = await over(c, tool, {}); assert.ok(o.status === 404 || o.status === 403 || o.status === 0, `${tool} is not reachable by a waiting ring pairing (got ${o.status})`); }
    assert.equal((await over(c, "wink.server.adopt", {})).status, 404);
    assert.equal(lenient.enrolled.length, enrolled, "still no presence key after the probes");
    assert.equal((await w.call("wink.access")).data.devices.length, 0);
    // the person at the computer picks the right words: only then is there a row, of kind app, and only then does the home treat it as the owner's
    const mine = await askPhone(w, r.paired.device, new Uint8Array(0), "Ring interloper");
    const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
    assert.equal((await w.call("wink.phone.pair.answer", { yes: true })).error?.code, "words_needed", "a bare yes confirms nothing");
    assert.equal(await relayHas(w, r.paired.device), false);
    assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 })).data.yes, true);
    await until(async () => relayHas(w, r.paired.device));
    assert.equal((await homeSaysAbout(w, r.paired.device)).row?.kind, "app");
    if (qr) assert.ok(qr.qr, "the QR was open the whole time");
  });
}




/** A paired phone with a live person session on the real kernel, and the call a daemon makes for it. */
async function pairedOnKernel(t, { confirmWithRealKey = false } = {}, shared = null) {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const w = shared || await world(t, { kernel: true });
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware", signer: "secure_enclave" };
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey });
  const mine = await askPhone(w, paired.device, new Uint8Array(0), "Alex's iPhone");
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  // The owner's confirming key: the stub's fixed "k1", or (confirmWithRealKey) a key really enrolled in presence_keys, so removing it can end the session bound to it.
  let ownerKey = null;
  if (confirmWithRealKey) {
    const ok = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    ownerKey = (await w.d.registry.call("presence.enroll", { kind: "device", name: "Alex's Mac", public_key: ok.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 }, "cli", PROOF)).data.id;
    assert.ok(ownerKey, "an owner key is enrolled");
  }
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(mine.words) + 1 }, SCREEN, ownerKey ? { ...A, proof: { method: "passkey", key: ownerKey } } : A)).data.yes, true);
  await until(async () => relayHas(w, paired.device));
  const c = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = (await over(c, "presence.person.pair-challenge", {})).body.data.challenge;
  const sig = crypto.sign("sha256", Buffer.from(`paired-start\n${paired.device}\n${ch}`), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const started = await over(c, "presence.person.start-paired", { sig });
  assert.equal(started.status, 200, JSON.stringify(started));
  const sessionId = started.body.data.id, label = `device:${paired.device}`;
  const read = async (via = { person: { id: sessionId } }) => {
    const info = await w.d.registry.call("relay.device.info", { id: paired.device }, "module:vyred");
    const rec = await w.d.registry.call("wink.device.record", { id: paired.device }, "module:vyred");
    const facts = callerFacts(label, { caller: label }, via, w.d.kernel, false, info.data ? { ...info.data, person: rec.data ? rec.data.owner : null } : null);
    return w.d.registry.call("memory.graph", {}, label, { ...via, ...(facts ? { kernelFacts: facts } : {}) });
  };
  assert.ok(!(await read()).error, "the paired session reads memory with no prompt");
  const live = async () => { const x = (await w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data; return (x.sessions || x).some(y => y.id === sessionId); };
  assert.equal(await live(), true);
  return { w, paired, sessionId, read, live, ownerKey };
}














// ---- device-first pairing leaves the device usable (wink-2, 4 Oct): session, peer, kernel ----


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
  /** An identity claimed as a Windows PC does (the app's claimIdentity, a key a page script can reach: its entry is `held: "web"`), in the same directory. @param {string} name */
  const anotherHeld = async name => {
    const { claimIdentity } = await import("../apps/app/src/identity/claim.js");
    const dir2 = idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen });
    const made = await claimIdentity({ name, code: (await dir2.reserve(name)).code, password: "four plain words here", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (fetchDir), now: () => clock.t, params: { memoryKiB: 64, passes: 1 }, held: true, forceSoftware: true });
    return { id: made.id, eid: made.eid, key: made.key };
  };
  /** An identity whose first device is a passkey (a browser's, or a Windows PC's Windows Hello), in the same directory. @param {string} name @param {any} webauthn */
  const anotherPasskey = async (name, webauthn, rp = undefined) => {
    const { claimIdentityWithPasskey } = await import("../apps/app/src/identity/claim.js");
    const dir2 = idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen });
    const made = await claimIdentityWithPasskey({ name, code: (await dir2.reserve(name)).code, password: "four plain words here", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (fetchDir), now: () => clock.t, params: { memoryKiB: 64, passes: 1 }, webauthn, ...(rp ? { rp } : {}) });
    return { id: made.id, eid: made.eid, key: made.key, pin: made.pin };
  };
  /** Another identity in the same directory (a second person), made by the app libraries as a box-less device makes it. @param {string} name */
  const another = async name => {
    const st = fileIdentityStore(path.join(tempHome(t), "spaces"));
    const dir2 = idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen });
    const ops2 = createIdentityOps({ store: st, dir: dir2, seen, now: () => clock.t, emit() {}, stretch: { memoryKiB: 64, passes: 1 } });
    await ops2.create({ name, password: "four plain words here", deviceLabel: `${name}'s phone`, code: (await dir2.reserve(name)).code });
    return { id: /** @type {string} */ (st.status().id), eid: /** @type {string} */ (st.status().eid), store: st };
  };
  return { id: store.status().id, state, store, ops: () => store.ops(), clock, fetch: fetchDir, another, anotherHeld, anotherPasskey,
    sign: async m => ({ eid: store.status().eid, sig: Buffer.from(await store.sign(Buffer.from(m))).toString("base64url") }) };
}

/** A box-less device pairs a fresh server and picks the words; resolves what the device then holds. */
async function pairFreshServer(t, { kind = "phone", about, presenceStorage = "hardware", ident = null, devKey = null, realPresence = false, kernelSealer = null } = {}) {
  ident = ident || await standinIdentity(t);
  // the real rule: a server is owned only with the identity proof, checked against the directory
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF;
  delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  t.after(() => { if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; });
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true, realPresence, kernelSealer });
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = devKey ? devKey.presenceKey : { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: presenceStorage, ...(presenceStorage === "hardware" ? { signer: "secure_enclave" } : {}) };
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
const linksFor = (t, f) => {
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's iPhone", sign: f.sign,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  return links;
};










// ---- the identity proof in the FIRST adopt call, checked against the names directory (lead ruling, 4 Oct) ----

/** One pairing attempt against a fresh real server; resolves the outcome and the server's world. */
async function attemptPairing(t, ident, { sign = ident.sign, owner = { id: ident.id, name: "Alex", vyre: "alex" }, answer = true } = {}) {
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF;
  delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  t.after(() => { if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; });
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true });
  const code = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  let shown = "";
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware", signer: "secure_enclave" };
  const pairing = pairServer({ payload: code.qr, owner, deviceKind: "phone", presenceKey, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 100, ...(sign ? { signIdentity: sign } : {}), onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; }, 3000).catch(() => null);
  if (q && answer) { await until(async () => shown); await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF); }
  return { w, asked: Boolean(q), result: await pairing.then(r => ({ ok: r }), e => ({ err: e })) };
}











shardTest("a box-less client makes its first space on a paired server: the server hosts it, the device signs the space's chain and record, and the directory resolves it with the home's route", async t => {
  const { claimServerSpace } = await import("../apps/app/src/identity/claim-space.js");
  const { idDirectory: mkDir, memorySeen: memSeen } = await import("../lib/identity/directory.js");
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  const st = f.ident.store;
  const identity = { id: f.ident.id, name: "alex", eid: st.status().eid, ops: st.ops(), key: { sign: async m => new Uint8Array(await st.sign(Buffer.from(m))) } };
  const ROUTE = { relay: f.w.status.url, route: f.done.route, box: f.done.box };
  const made = await claimServerSpace({ identity, name: "harlow", displayName: "Harlow Legal", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, route: ROUTE,
    host: a => session.call("spaces.host-here", { ...a, proof: { key: "k1" } }) });
  assert.ok(f.w.d.kernel.spaces.hosts(made.space), "the SERVER's kernel hosts the space the device claimed");
  const dir = mkDir({ base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, seen: memSeen() });
  const r = await dir.resolve("harlow", { resolve: async id => (id === f.ident.id ? st.ops() : null) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.kind, r.payload.id, r.payload.ownerName, r.payload.home.kind], ["space", made.space, "alex", "server"]);
  assert.deepEqual(r.payload.route, ROUTE);
  assert.equal(r.payload.rootPublic, made.rootPublic, "the record carries the server's key");
  assert.ok(fs.existsSync(path.join(f.w.d.paths.root, "spaces", made.space, "root.key")), "the server holds the key, not the device");
  // the server proves it: it signs a nonce with that key (spaces.attest, answered inside the invite preview)
  const att = (await f.w.d.registry.call("spaces.attest", { space: made.space, nonce: "n".repeat(22) }, "module:vyred")).data;
  assert.equal(att.pub, made.rootPublic);
  assert.equal(crypto.verify(null, Buffer.from(`vyre-space-attest-v1\n${made.space}\n${"n".repeat(22)}`), crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(att.pub, "base64url")]), format: "der", type: "spki" }), Buffer.from(att.sig, "base64url")), true);
  assert.equal((await f.w.d.registry.call("spaces.attest", { space: made.space, nonce: "n".repeat(22) }, "cli")).error?.code !== undefined, true, "a person or a model cannot ask a server to sign for a space");
  // NO authority derives from this key: a token the key signed for an invite the kernel never issued is refused by the server's redeem, and the kernel itself has no such invite
  const { privateKeyOf } = await import("../core/spaces/identity.js");
  const serverKey = privateKeyOf(fs.readFileSync(path.join(f.w.d.paths.root, "spaces", made.space, "root.key"), "utf8").trim());
  const payload = Buffer.from(JSON.stringify({ id: "inv_" + "0".repeat(32), space: "harlow.vyre.run", sid: made.space, role: "owner" })).toString("base64url");
  const forged = `${payload}.${crypto.sign(null, Buffer.from(payload), serverKey).toString("base64url")}`;
  // the person's side is well formed (a real key, a real signature over the accept message), so the refusal can only come from the token: the key's signature makes no invite
  const joiner = crypto.generateKeyPairSync("ed25519");
  const joinerPub = joiner.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const joinerId = "per_" + "z".repeat(26);
  const joinProof = crypto.sign(null, acceptMessage("inv_" + "0".repeat(32), "harlow.vyre.run", joinerId), joiner.privateKey).toString("base64url");
  const redeemed = await f.w.d.registry.call("spaces.invites.redeem", { token: forged, person: { id: joinerId, publicKey: joinerPub }, proof: joinProof }, "tailnet");
  assert.ok(redeemed.error, "a token signed by the space's server key is not an invite");
  assert.ok(!["bad_proof", "bad_input"].includes(redeemed.error.code), `the refusal is about the token, not the person's proof: ${JSON.stringify(redeemed.error)}`);
  const hosted = f.w.d.kernel.spaces.hosted(made.space);
  await assert.rejects(() => hosted.gateway.grants.invites.get(hosted.kernel.chains.fromFacts({ kind: "invitee", person: "per_" + "z".repeat(26), vouched: true }), "inv_" + "0".repeat(32)), e => e.code === "not_found");
  // a refused host call claims nothing in the directory
  await assert.rejects(() => claimServerSpace({ identity, name: "nopeproof", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, host: async () => { throw Object.assign(new Error("the server refused"), { code: "denied" }); } }), e => e.code === "denied"); // (spaces.host-here itself needs no presence since 11391dc9d: the owner check is its gate, so the refusal is stood in)
  assert.equal((await dir.check("nopeproof")).status, "ok");
});

shardTest("host-here on a server that cannot run Twenty refuses in the kernel's words and hosts nothing", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  const sp = f.w.d.kernel.spaces;
  spacesHooks.storePlan = async () => ({ store: "none", confirm: { text: "This server cannot run the record store (Twenty), so the space was not made here.", choices: ["server", "cancel"] } });
  t.after(() => { spacesHooks.storePlan = null; });
  const before = sp.list().length;
  await assert.rejects(() => session.call("spaces.host-here", { name: "smallroom", proof: { key: "k1" } }), e => e.code === "store_unavailable" && /cannot run the record store/.test(e.message));
  assert.equal(sp.list().length, before, "nothing was hosted before the owner agreed");
});

shardTest("the invitee door, real daemon and relay: a stranger's channel with the invitee hello makes no device and has one door; everything else is refused, and a bad hello gets a stream that refuses every call", async t => {
  const sealWas = process.env.VYRE_SEAL_DEV;
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (sealWas === undefined) delete process.env.VYRE_SEAL_DEV; else process.env.VYRE_SEAL_DEV = sealWas; });
  const w = await world(t, { kernel: true });
  const crypt = nodeCrypto();
  const ks = keystore(t);
  const keys = await clientDeviceKey({ keyStore: ks, crypto: crypt });
  // where the box is: from a ticket's offer (the same route and box key every pairing starts from)
  const offer = (await resolveTicket(fromBase64url((await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data.ticket), { relay: w.status.url, crypto: crypt })).offer;
  const route = offer.route, box = Buffer.from(offer.box);
  const { channel, reply } = await openChannel({ relay: w.status.url, route, box, keys, hello: { v: 1, invitee: true }, crypto: crypt, WebSocket: globalThis.WebSocket });
  t.after(() => channel.close(1000, "done"));
  assert.ok(reply.invitee, "the box admits the channel as an invitee");
  assert.equal(reply.device, undefined);
  assert.equal(((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []).length, 0, "no device row, no presence key");
  const head = h => new Promise(res => { const s = channel.open(h); s.onhead = x => res({ status: x && x.status, s }); s.onreset = () => res({ status: 0, s }); });
  // no ordinary request, tool or event stream reaches anything
  for (const h of [{ method: "GET", path: "/v1/tools" }, { method: "POST", path: "/v1/tools/system.info", headers: {} }, { method: "GET", path: "/v1/events" }, { ws: "/v1/streams/glass/screen" }]) {
    const r = await head(h);
    assert.ok(r.status === 403 || r.status === 400 || r.status === 0, `${JSON.stringify(h).slice(0, 40)} is refused (${r.status})`);
  }
  // the only door is the peer stream with an invitee hello; a plain peer stream and an extra field are refused
  assert.equal((await head({ peer: "wink", space: "home" })).status, 400, "a plain peer stream has no invitee hello");
  assert.equal((await head({ peer: "wink", space: "home", invitee: {}, extra: 1 })).status, 400);
  // a hello that is malformed gets the stream (the door opens it) and then every call is refused and the stream closes: the door never answers a tool
  const bad = await head({ peer: "wink", space: "home", invitee: { space: "spc_" + "a".repeat(12), invite: "inv_" + "b".repeat(32), identity: "per_" + "c".repeat(26), entry: "d".repeat(26), ts: Date.now(), nonce: "n".repeat(20), sig: "s".repeat(86) } });
  assert.equal(bad.status, 200);
  const { peerSession, streamPipe } = await import("../core/wink/node/peer-wire.js");
  const session = peerSession(streamPipe(bad.s), { first: 1 });
  await assert.rejects(() => session.call("system.info", {}, { timeoutMs: 3000 }), e => e.code === "denied");
  await assert.rejects(() => session.call("kernel.call", { v: 1, space: "spc_" + "a".repeat(12), id: "x", ts: Date.now(), call: "grants.invites.get", args: ["inv_" + "b".repeat(32)] }, { timeoutMs: 3000 }), e => e.code === "denied");
});

shardTest("a key that is a waiting or paired device here is not admitted as an invitee", async t => {
  const w = await world(t);
  const crypt = nodeCrypto();
  // a key that is already a paired device here is not admitted by the invitee hello (it must come as that device)
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const ks = keystore(t);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's phone", crypto: crypt, keyStore: ks });
  const keys = await clientDeviceKey({ keyStore: ks, crypto: crypt });
  const box = Buffer.from(paired.box, "base64url");
  const r = await openChannel({ relay: w.status.url, route: paired.route, box, keys, hello: { v: 1, invitee: true }, crypto: crypt, WebSocket: globalThis.WebSocket });
  t.after(() => r.channel.close(1000, "done"));
  assert.ok(r.reply, "the channel opened (the box is reachable)");
  assert.ok(!r.reply.invitee, "a waiting pairing's key is not an invitee");
});

shardTest("a software device key's presence proof is refused by the server without the dev switch, whatever the client signs: \"approve this in Vyre on your phone\"", async t => {
  const savedSw = process.env.VYRE_SEAL_SOFTWARE;
  delete process.env.VYRE_SEAL_SOFTWARE;
  t.after(() => { if (savedSw !== undefined) process.env.VYRE_SEAL_SOFTWARE = savedSw; });
  const devKey = deviceKey(path.join(tempHome(t), "dev.json"));
  const f = await pairFreshServer(t, { kind: "computer", presenceStorage: "software", devKey, realPresence: true });
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's Mac", sign: m => devKey.sign(m), proveTool: devKey.proveTool, autoPresence: true,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  await assert.rejects(() => links.sessionFor("srv").call("vault.reveal", { name: "juniper" }), e => /software|phone/i.test(e.message)); // a vault moment (a reveal); vault.put is not one since step B: the person alone saves an item, nothing is shown
});


shardTest("a paired device opens a chat's stream over the peer wire: frames for its person in order, a message by call, a dropped peer stream resumes from the last frame, an ended session gets nothing more", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const k = f.w.d.kernel;
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const chat = await k.gateway.grants.chats.create(oc, { people: [] });
  const mkPeer = async () => openServerPeer(connect({ relay: f.w.status.url, route: f.done.route, box: f.done.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: f.ks }));
  let peer = await mkPeer();
  const frames = [], ended = [];
  const open = async from => peer.openStream("stream.open-peer", { chat: chat.id, ...(from ? { from } : {}) }, { onframe: d => frames.push(d), onend: w => ended.push(w) });
  const s = await open();
  assert.match(s.id, /^st_/);
  // a message by call on the same wire (the person is this device's own, from the server's chain)
  await peer.call("stream.send", { chat: chat.id, text: "hello from the phone" });
  await until(async () => frames.some(d => JSON.stringify(d).includes("hello from the phone")), 8000);
  const seen = frames.length;
  // another viewer's session id is refused: a thread this person is not in gives no stream
  await assert.rejects(() => peer.call("stream.open-peer", { chat: "t_not_mine_at_all" }), e => /not_found|no such session/i.test(`${e.code} ${e.message}`));
  // the peer stream drops: the app is told, reopens and resumes from the last cursor it saw
  const cursor = Math.max(0, ...frames.map(d => Number(d && (d.cursor ?? d.seq ?? d.n)) || 0));
  peer.close();
  await new Promise(r => setTimeout(r, 100));
  assert.ok(ended.includes("closed"), "the dropped peer stream ended the stream on the device");
  peer = await mkPeer();
  const again = [];
  await peer.openStream("stream.open-peer", { chat: chat.id, from: cursor }, { onframe: d => again.push(d), onend: () => {} });
  await peer.call("stream.send", { chat: chat.id, text: "after the resume" });
  await until(async () => again.some(d => JSON.stringify(d).includes("after the resume")), 8000);
  assert.ok(seen > 0);
  // the paired session ends: nothing more is sent
  const before = again.length;
  await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink");
  await new Promise(r => setTimeout(r, 800));
  await peer.call("stream.send", { chat: chat.id, text: "too late" }).catch(() => null);
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!again.slice(before).some(d => JSON.stringify(d).includes("too late")), "no frame after the session ended");
  peer.close();
});


shardTest("PS-A, real daemon: a web device with a software session may open a chat's stream, but a call that needs presence is refused over the same wire", async t => {
  const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software", realPresence: true });
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const k = f.w.d.kernel;
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const chat = await k.gateway.grants.chats.create(oc, { people: [] });
  const peer = await openServerPeer(connect({ relay: f.w.status.url, route: f.done.route, box: f.done.box, name: "Alex's browser", crypto: nodeCrypto(), keyStore: f.ks }));
  t.after(() => peer.close());
  const frames = [];
  const s = await peer.openStream("stream.open-peer", { chat: chat.id }, { onframe: d => frames.push(d), onend: () => {} });
  assert.match(s.id, /^st_/, "a software-strength session opens a chat's stream");
  await peer.call("stream.send", { chat: chat.id, text: "from the browser" });
  await until(async () => frames.some(d => JSON.stringify(d).includes("from the browser")), 8000);
  // a call that needs the person's presence: no proof, and a made-up one, are both refused (the session alone never counts)
  const code = e => String(e && e.code);
  await assert.rejects(() => peer.call("vault.reveal", { name: "northwind-mail" }), e => /presence_required|presence|denied/.test(code(e)), "no proof: refused");
  await assert.rejects(() => peer.call("vault.reveal", { name: "northwind-mail", proof: { method: "passkey", id: "made-up" } }), e => /presence|denied|bad_proof|invalid/.test(`${code(e)} ${e.message}`), "a made-up proof: refused");
});

shardTest("PS-A, real daemon: the ninth stream.open-peer on one device is refused, and closing one makes room", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const k = f.w.d.kernel;
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const chat = await k.gateway.grants.chats.create(oc, { people: [] });
  const peer = await openServerPeer(connect({ relay: f.w.status.url, route: f.done.route, box: f.done.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: f.ks }));
  t.after(() => peer.close());
  const opened = [];
  for (let i = 0; i < 8; i++) opened.push(await peer.openStream("stream.open-peer", { chat: chat.id }, { onframe: () => {}, onend: () => {} }));
  await assert.rejects(() => peer.openStream("stream.open-peer", { chat: chat.id }, { onframe: () => {}, onend: () => {} }), e => /rate_limited|too many/.test(`${e.code} ${e.message}`), "the ninth is refused");
  opened[0].close();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(await peer.openStream("stream.open-peer", { chat: chat.id }, { onframe: () => {}, onend: () => {} }), "closing one makes room");
});

shardTest("renewal lock survives a restart: three wrong answers, the daemon restarts on the same home, and the device is still locked: no fresh tries, until the owner lifts it", async t => {
  const f = await pairFreshServer(t);
  const id = f.done.device, as = `device:${id}`, peer = { peer: { kind: "device", stableId: id, node: id } };
  const call = (d, tool, input) => d.registry.call(tool, input, as, peer);
  for (let i = 0; i < 3; i++) { await call(f.w.d, "presence.person.pair-challenge", {}); await call(f.w.d, "presence.person.start-paired", { sig: "AAAA" }); }
  assert.ok((await f.w.d.registry.call("presence.person.locked", {}, "cli", PROOF)).data.locked.some(l => l.device === id), "locked before the restart");
  // restart on the same home
  await f.w.d.stop();
  const d2 = await start({ presence: lenient, root: f.w.root, log: () => {}, coreKeys: macCore(), kernel: true });
  t.after(() => d2.stop());
  assert.ok((await d2.registry.call("presence.person.locked", {}, "cli", PROOF)).data.locked.some(l => l.device === id), "still locked after the restart");
  const ch = (await call(d2, "presence.person.pair-challenge", {})).data.challenge;
  const started = await call(d2, "presence.person.start-paired", { sig: f.sign(`paired-start\n${id}\n${ch}`) });
  assert.ok(started.error, "a right answer is still no session while locked: the restart gave no fresh tries");
  // the owner lifts it from their own device
  assert.equal((await d2.registry.call("presence.person.renew-allow", { device: id }, "cli", PROOF)).data.allowed, id);
  const ch2 = (await call(d2, "presence.person.pair-challenge", {})).data.challenge;
  assert.ok((await call(d2, "presence.person.start-paired", { sig: f.sign(`paired-start\n${id}\n${ch2}`) })).data, "after renew-allow the device renews with its key");
});

shardTest("the three-strikes count is in the store too: two wrong answers, a restart, one wrong answer, and the device is locked", async t => {
  const f = await pairFreshServer(t);
  const id = f.done.device, as = `device:${id}`, peer = { peer: { kind: "device", stableId: id, node: id } };
  const call = (d, tool, input) => d.registry.call(tool, input, as, peer);
  for (let i = 0; i < 2; i++) { await call(f.w.d, "presence.person.pair-challenge", {}); await call(f.w.d, "presence.person.start-paired", { sig: "AAAA" }); }
  assert.equal((await f.w.d.registry.call("presence.person.locked", {}, "cli", PROOF)).data.locked.length, 0, "two wrong answers do not lock");
  await f.w.d.stop();
  const d2 = await start({ presence: lenient, root: f.w.root, log: () => {}, coreKeys: macCore(), kernel: true });
  t.after(() => d2.stop());
  await call(d2, "presence.person.pair-challenge", {});
  await call(d2, "presence.person.start-paired", { sig: "AAAA" });
  assert.ok((await d2.registry.call("presence.person.locked", {}, "cli", PROOF)).data.locked.some(l => l.device === id), "the count survived the restart: the third wrong answer locks");
});

// ---- Add this device from another device: the joining side (relay/client/phonepair.js), a box-less device with its own identity key ----
shardTest("add this device from another device, real daemon: a box-less device redeems the code, the words match, the person says yes, and the identity's list takes the device's key", async t => {
  const { addThisDevice, parsePhonePayload } = await import("../relay/client/phonepair.js");
  await standinIdentity(t); // the shared fake names directory (the module's fetch)
  spacesHooks.stretch = { memoryKiB: 64, passes: 1 };
  t.after(() => { spacesHooks.stretch = null; });
  const savedTyped = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (savedTyped !== undefined) process.env.VYRE_WINK_TYPED_CODE = savedTyped; });
  const w = await world(t);
  const me = (await w.call("spaces.identity.create", { name: "kit", password: "four plain words here", deviceLabel: "Kit's laptop" })).data;
  assert.match(String(me && me.id), /^per_/);
  const open = (await w.call("wink.phone.open", {})).data;
  assert.ok(parsePhonePayload(open.qr), "the code reads as a device-adding code");
  assert.equal(parsePhonePayload(open.qr.replace("&k=phone", "")), null, "and a server's code does not");
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const before = (await w.call("spaces.identity.entries")).data;
  /** @type {string} */ let shown = "";
  const joining = addThisDevice({ payload: open.qr, key: { publicKey, label: "Kit's phone" }, name: "Kit's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onWords: x => { shown = x; } });
  joining.catch(() => {});
  const asked = await until(async () => { const q = (await w.call("wink.phone.pairing")).data; return q && q.asking ? q : null; });
  await until(async () => shown);
  assert.equal(asked.name, "Kit's phone");
  assert.ok(asked.choices.includes(shown), "the computer's choices hold the words this device shows");
  assert.equal((await w.call("spaces.identity.entries")).data.length ?? (await w.call("spaces.identity.entries")).data.entries?.length, before.length ?? before.entries?.length, "nothing is on the list before the yes");
  const yes = (await w.call("wink.phone.pair.answer", { yes: true, pick: asked.choices.indexOf(shown) + 1 })).data;
  assert.equal(yes.yes, true, JSON.stringify(yes));
  assert.equal(yes.enrolled, true);
  const done = await joining;
  assert.equal(done.paired, true);
  assert.equal(done.enrolled, true);
  const after = (await w.call("spaces.identity.entries")).data;
  const list = after.entries || after;
  assert.ok(list.some(e => e.kind === "device" && e.label === "Kit's phone"), JSON.stringify(list));
});
shardTest("add this device by a typed code, real daemon: a box-less device types the WINK code, the person types its ack back on the computer, and the identity's list takes the device's key with no words to pick", async t => {
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  await standinIdentity(t);
  spacesHooks.stretch = { memoryKiB: 64, passes: 1 };
  t.after(() => { spacesHooks.stretch = null; });
  const savedTyped = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE; // the release default: the typed code is on
  t.after(() => { if (savedTyped !== undefined) process.env.VYRE_WINK_TYPED_CODE = savedTyped; });
  const w = await world(t);
  assert.match(String((await w.call("spaces.identity.create", { name: "kit", password: "four plain words here", deviceLabel: "Kit's laptop" })).data?.id), /^per_/);
  const open = (await w.call("wink.phone.open", {})).data;
  assert.match(open.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  /** @type {string} */ let ack = "";
  const joining = addThisDevice({ code: open.code.toLowerCase(), relay: w.status.url, key: { publicKey, label: "Kit's phone" }, name: "Kit's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onAck: a => { ack = a; } });
  joining.catch(() => {});
  await until(async () => ack);
  assert.match(ack, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, "the phone shows a code to type back");
  assert.equal((await w.call("wink.phone.pairing")).data.asking, false, "nothing is asked before the ack");
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.code_offer, typed: ack })).data.ok, true);
  const done = await joining;
  assert.equal(done.paired, true);
  assert.equal(done.enrolled, true, JSON.stringify(done));
  assert.match(String(done.identity?.id), /^per_/, "the answer names the identity the device joined, for reading its list");
  const after = (await w.call("spaces.identity.entries")).data;
  assert.ok((after.entries || after).some(e => e.kind === "device" && e.label === "Kit's phone"), JSON.stringify(after));
  // a wrong code does not pair anything
  await assert.rejects(() => addThisDevice({ code: "WINK-ZZZZ-ZZZZ", relay: w.status.url, key: { publicKey }, name: "x", crypto: nodeCrypto(), keyStore: keystore(t), timeoutMs: 800, pollMs: 50 }), e => ["taken", "unreachable", "bad_code"].includes(e.code));
});

shardTest("add this device from another device: a no, a wrong pick, a used code and a server's code each add nothing", async t => {
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  await standinIdentity(t);
  spacesHooks.stretch = { memoryKiB: 64, passes: 1 };
  t.after(() => { spacesHooks.stretch = null; });
  const savedTyped = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (savedTyped !== undefined) process.env.VYRE_WINK_TYPED_CODE = savedTyped; });
  const w = await world(t);
  await w.call("spaces.identity.create", { name: "kit", password: "four plain words here", deviceLabel: "Kit's laptop" });
  const publicKey = () => crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const count = async () => { const d = (await w.call("spaces.identity.entries")).data; return (d.entries || d).length; };
  const n0 = await count();
  for (const answer of [{ yes: false }, { yes: true, words: "wrong wrong wrong" }]) {
    const open = (await w.call("wink.phone.open", {})).data;
    const p = addThisDevice({ payload: open.qr, key: { publicKey: publicKey() }, name: "Sam's phone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50 });
    p.catch(() => {});
    await until(async () => { const q = (await w.call("wink.phone.pairing")).data; return q && q.asking; });
    assert.equal((await w.call("wink.phone.pair.answer", answer)).data.yes, false);
    await assert.rejects(() => p, e => e.code === "denied");
    assert.equal(await count(), n0, "nothing was added");
  }
  const open = (await w.call("wink.phone.open", {})).data;
  const used = await pairTicket(parsePhoneQr(open.qr).seed, { relay: w.status.url, name: "first", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.ok(used.pending);
  await assert.rejects(() => addThisDevice({ payload: open.qr, key: { publicKey: publicKey() }, name: "second", crypto: nodeCrypto(), keyStore: keystore(t) }), e => e.code === "taken");
  await assert.rejects(() => addThisDevice({ payload: "vyre://wink/2?t=AAAAAAAAAAAAAAAAAAAAAA&r=ws%3A%2F%2Fx", key: { publicKey: publicKey() } }), e => e.code === "bad_code");
  await assert.rejects(() => addThisDevice({ payload: open.qr, key: { publicKey: "short" } }), e => e.code === "bad_code");
  assert.equal(await count(), n0);
});

// ---- a recovered phone (tailnet, 4 Oct): its key is on the identity's list by recovery and was never paired with this server ----
shardTest("a recovered phone's key, on the identity's list but never paired here, is not admitted: no device channel, no peer stream, no session; its way in is a pairing (the owner's yes, or its identity proof on a pair-to server)", async t => {
  const sealWas = process.env.VYRE_SEAL_DEV;
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (sealWas === undefined) delete process.env.VYRE_SEAL_DEV; else process.env.VYRE_SEAL_DEV = sealWas; });
  const w = await world(t, { kernel: true });
  const crypt = nodeCrypto();
  const keys = await clientDeviceKey({ keyStore: keystore(t), crypto: crypt });
  const offer = (await resolveTicket(fromBase64url((await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data.ticket), { relay: w.status.url, crypto: crypt })).offer;
  const route = offer.route, box = Buffer.from(offer.box);
  // as an ordinary device (no pairing secret, no invitee hello): the box does not know the key, and the channel never opens
  await assert.rejects(() => openChannel({ relay: w.status.url, route, box, keys, hello: { v: 1 }, crypto: crypt, WebSocket: globalThis.WebSocket }), /not a paired device|closed|refused/i);
  // a hello that names a pairing it does not hold is the same
  await assert.rejects(() => openChannel({ relay: w.status.url, route, box, keys, hello: { v: 1, pair: "x".repeat(22) }, crypto: crypt, WebSocket: globalThis.WebSocket }), /expired|already used|closed|refused/i);
  assert.equal(((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []).length, 0, "and no device row was made");
  // as an invitee (the only unpaired door): a channel with no row, whose one stream is the invitee stream; it gets no session, no tool and no kernel call without an invite
  const r = await openChannel({ relay: w.status.url, route, box, keys, hello: { v: 1, invitee: true }, crypto: crypt, WebSocket: globalThis.WebSocket });
  t.after(() => r.channel.close(1000, "done"));
  assert.ok(r.reply.invitee && !r.reply.device);
  const head = h => new Promise(res => { const s = r.channel.open(h); s.onhead = x => res({ status: x && x.status, s }); s.onreset = () => res({ status: 0, s }); });
  assert.equal((await head({ peer: "wink", space: "home" })).status, 400, "no peer stream without an invite hello");
  const { peerSession, streamPipe } = await import("../core/wink/node/peer-wire.js");
  const bad = await head({ peer: "wink", space: "home", invitee: { space: "spc_" + "a".repeat(12), invite: "inv_" + "b".repeat(32), identity: "per_" + "c".repeat(26), entry: "d".repeat(26), ts: Date.now(), nonce: "n".repeat(20), channel: r.reply.invitee, sig: "s".repeat(86) } });
  const session = peerSession(streamPipe(bad.s), { first: 1 });
  for (const [tool, input] of [["system.info", {}], ["records.me", {}], ["presence.person.start-paired", { sig: "AAAA" }], ["wink.server.pairing", {}]]) {
    await assert.rejects(() => session.call(tool, input, { timeoutMs: 3000 }), e => e.code === "denied", tool);
  }
  assert.equal(((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []).length, 0, "an invitee channel made no device row either");
});

shardTest("an invitee link pointed at a box whose key is not the record's route.box sends no hello and answers with a plain refusal", async t => {
  const f = await pairFreshServer(t);
  const ch = { relay: f.w.status.url, route: f.done.route, box: Buffer.alloc(32, 5).toString("base64url") };
  const hello = { space: "spc_" + "a".repeat(12), invite: "inv_" + "b".repeat(32), identity: "per_" + "c".repeat(26), entry: "d".repeat(26), ts: Date.now(), nonce: "n".repeat(22), sig: "s".repeat(86) };
  const heads = [];
  const spy = o => { const c = connect(o); const ready = c.ready.bind(c); c.ready = async () => { const chan = await ready(); const open = chan.open.bind(chan); chan.open = h => { heads.push(h); return open(h); }; return chan; }; return c; };
  const links = createServerLinks({ connect: spy, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Kit's phone", openMs: 4000, channelOf: () => null });
  t.after(() => links.close());
  await assert.rejects(() => links.inviteeSessionFor(ch, hello).call("grants.invites.get", {}), e => e.code === "unreachable");
  assert.deepEqual(heads, [], "no stream head, so no hello, reached a box with the wrong key");
  // control: the same link to the box key the record names does open a channel and sends the head (this build's door then refuses it, which is not the point here)
  const links2 = createServerLinks({ connect: spy, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Kit's phone", openMs: 4000, channelOf: () => null });
  t.after(() => links2.close());
  await assert.rejects(() => links2.inviteeSessionFor({ ...ch, box: f.done.box }, hello).call("grants.invites.get", {}));
  assert.equal(heads.length, 1, "the right box key opens the channel and the head goes");
  assert.deepEqual(heads[0].invitee, hello);
});

// ---- step 13 (walker): a removed server's route is refused ----
shardTest("after the adopter lets a server go, its device is dropped at the relay: the relay refuses the old key and the peer door has no row for it", async t => {
  const f = await pairFreshServer(t);
  const id = f.done.device;
  const row = async () => (await f.w.d.registry.call("relay.device.info", { id }, "module:vyred")).data;
  assert.equal((await row()).removed, false);
  const rel = await f.w.d.registry.call("wink.server.release", {}, `device:${id}`, {});
  assert.equal(rel.data && rel.data.released, true, JSON.stringify(rel));
  await until(async () => (await row()).removed === true, 6000);
  const crypt = nodeCrypto();
  const keys = await clientDeviceKey({ keyStore: f.ks, crypto: crypt });
  await assert.rejects(() => openChannel({ relay: f.w.status.url, route: f.done.route, box: Buffer.from(f.done.box, "base64url"), keys, hello: { v: 1 }, crypto: crypt, WebSocket: globalThis.WebSocket }), /removed|not a paired|closed|refused/i, "the old key reaches nothing");
});


// ---- IV-5 (reviewer-3): invitee channels have a pool and a life of their own ----
shardTest("invitee channels: 40 strangers holding channels never take the slots the owner's paired phone needs, and an idle invitee channel is closed", async t => {
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const w = await world(t, { kernel: true, seam: { inviteeIdleMs: 600 } });
  const crypt = nodeCrypto();
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const ksPhone = keystore(t);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's phone", crypto: crypt, keyStore: ksPhone });
  const offer = (await resolveTicket(fromBase64url((await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF)).data.ticket), { relay: w.status.url, crypto: crypt })).offer;
  const route = offer.route, box = Buffer.from(offer.box);
  const held = [];
  let refused = 0, admitted = 0;
  for (let i = 0; i < 40; i++) {
    const keys = await clientDeviceKey({ keyStore: keystore(t), crypto: crypt });
    try {
      const r = await openChannel({ relay: w.status.url, route, box, keys, hello: { v: 1, invitee: true }, crypto: crypt, WebSocket: globalThis.WebSocket });
      held.push(r.channel); admitted++;
    } catch { refused++; }
  }
  t.after(() => { for (const c of held) { try { c.close(1000, "done"); } catch { /* closed */ } } });
  await new Promise(r => setTimeout(r, 300));
  const stillOpen = held.filter(c => c.closed !== true).length;
  assert.ok(stillOpen <= 8, `the invitee pool is 8 (${stillOpen} of ${admitted} held open)`);
  void refused;
  // the owner's paired phone still connects while all of them are held
  const conn = connect({ relay: w.status.url, route: paired.route, box: paired.box, name: "Alex's phone", crypto: crypt, keyStore: ksPhone, WebSocket: globalThis.WebSocket });
  t.after(() => conn.close());
  await Promise.race([conn.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error("the paired phone could not connect")), 8000))]);
  // idle ones are closed by the box (no stream opened inside the idle window)
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(held.every(c => c.closed === true), "every idle invitee channel was closed");
  // a channel whose stream ends (a refused hello ends it) is closed at once too
  const keys = await clientDeviceKey({ keyStore: keystore(t), crypto: crypt });
  const r = await openChannel({ relay: w.status.url, route, box, keys, hello: { v: 1, invitee: true }, crypto: crypt, WebSocket: globalThis.WebSocket });
  const st = r.channel.open({ peer: "wink", space: "home", invitee: { space: "spc_" + "a".repeat(12), invite: "inv_" + "b".repeat(32), identity: "per_" + "c".repeat(26), entry: "d".repeat(26), ts: Date.now(), nonce: "n".repeat(20), channel: r.reply.invitee, sig: "s".repeat(86) } });
  await new Promise(res => { st.onhead = () => res(undefined); st.onreset = () => res(undefined); });
  const { peerSession, streamPipe } = await import("../core/wink/node/peer-wire.js");
  await assert.rejects(() => peerSession(streamPipe(st), { first: 1 }).call("kernel.call", { v: 1, space: "spc_" + "a".repeat(12), id: "x", ts: Date.now(), call: "grants.invites.get", args: ["inv_" + "b".repeat(32)] }, { timeoutMs: 3000 }), e => e.code === "denied");
  await until(async () => r.channel.closed === true, 4000);
});

/** After a refused pairing: the app\'s relay device goes (the drop follows the answer), and no device has a record of being the owner\'s. */
const noOwnerDevices = async w => {
  await until(async () => ((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []).filter(d => d.kind === "app" && !d.removed).length === 0 || null, 8000);
  for (const d of (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []) assert.equal((await w.d.registry.call("wink.device.record", { id: d.id }, "module:presence")).data, null, "no owner device record");
};

// ---- first owner wins: a home whose kernel already has a claimed owner is not paired by a different identity ----
shardTest("a home that already has a claimed owner is not paired by a different identity: refused before the ask, nothing recorded, no session, the kernel owner unchanged", async t => {
  const ident = await standinIdentity(t);
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF; delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  const saved = process.env.VYRE_WINK_TYPED_CODE; delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true });
  const claim = await w.d.registry.call("spaces.identity.create", { name: "srvowner", password: "four plain words here", deviceLabel: "server screen" }, "cli", PROOF);
  assert.ok(!claim.error, JSON.stringify(claim.error));
  const ownerAfterClaim = w.d.kernel.id.owner;
  assert.notEqual(ownerAfterClaim, ident.id);
  const code = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware", signer: "secure_enclave" };
  const ks = keystore(t);
  const pairing = pairServer({ payload: code.qr, owner: { id: ident.id, name: "Carol", vyre: "alex" }, deviceKind: "phone", presenceKey, name: "Carol's iPhone", crypto: nodeCrypto(), keyStore: ks, pollMs: 100, signIdentity: ident.sign, onWords: () => {} });
  await assert.rejects(() => pairing, e => e.code === "owned_by_other" && /^This server belongs to .*Ask them to add you to a space, or reset the server to start over/.test(e.message), "refused with its own words");
  assert.equal(((await w.call("wink.server.pairing", {}, "cli", PROOF)).data || {}).asking || false, false, "the person at the server is never asked");
  const st = (await w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.released, true, "the pairing record names no owner: the status is the kernel's owner, released from any app");
  assert.equal(w.d.kernel.id.owner, ownerAfterClaim, "the kernel owner is unchanged");
  await noOwnerDevices(w);
});

shardTest("a kernel that refuses the owner fails the pairing: the owner record is taken back, the device has no row and no session", async t => {
  const ident = await standinIdentity(t);
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF; delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  const saved = process.env.VYRE_WINK_TYPED_CODE; delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true });
  // the kernel adopts another identity between the early check and the pick (a claim at the server's own screen while the pairing waits)
  const code = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware", signer: "secure_enclave" };
  const ks = keystore(t);
  let shown = "";
  const pairing = pairServer({ payload: code.qr, owner: { id: ident.id, name: "Carol", vyre: "alex" }, deviceKind: "phone", presenceKey, name: "Carol's iPhone", crypto: nodeCrypto(), keyStore: ks, pollMs: 100, signIdentity: ident.sign, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
  await until(async () => shown);
  const claim = await w.d.registry.call("spaces.identity.create", { name: "srvowner", password: "four plain words here", deviceLabel: "server screen" }, "cli", PROOF);
  assert.ok(!claim.error, JSON.stringify(claim.error));
  const ownerAfterClaim = w.d.kernel.id.owner;
  await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF);
  await assert.rejects(() => pairing, e => e.code === "owned_by_other");
  assert.equal((await w.call("wink.server.status", {}, "cli", PROOF)).data.released, true, "the pairing's owner record was taken back (the status is only the kernel's owner)");
  assert.equal(w.d.kernel.id.owner, ownerAfterClaim);
  await noOwnerDevices(w);
});

shardTest("a device is the owner's person only as the person its row names: a row naming another person, or nobody, gets no person facts", () => {
  const k = { id: { owner: "per_" + "a".repeat(26), space: "spc_x" }, grants: { adopted: () => ({ from: "per_first", to: "per_" + "a".repeat(26) }) } };
  const row = person => ({ kind: "app", removed: false, ...(person !== undefined ? { person } : {}) });
  const facts = r => callerFacts("device:abcdefghijklmnop", { caller: "device:abcdefghijklmnop", peer: { kind: "device", stableId: "abcdefghijklmnop" } }, null, k, false, r);
  assert.equal(facts(row(k.id.owner)).person, k.id.owner);
  assert.equal(facts(row("per_" + "b".repeat(26))), null, "another person");
  assert.equal(facts(row(null)), null, "nobody");
  assert.equal(facts(row()), null, "a row with no person");
});

/** One more pairing of an already-paired fresh server from the same identity (a person's second device), the way pairFreshServer does the first. */
async function pairSecondDevice(t, f, { kind = "computer", name = "Alex's Mac" } = {}) {
  const made = (await f.w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ks = keystore(t);
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner: { id: f.ident.id, name: "Alex", vyre: "alex" }, signIdentity: f.ident.sign, deviceKind: kind, keyStorage: "software", name, crypto: nodeCrypto(), keyStore: ks, presenceKey, pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  return { pairing, answer: async () => {
    const q = await until(async () => { const x = (await f.w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
    await until(async () => shown);
    return (await f.w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF)).data;
  } };
}

shardTest("the owner's second device (a computer after a phone) pairs: the same identity, its proof checked, the person at the server picks the words, and the owner does not change", async t => {
  const f = await pairFreshServer(t);
  const ownerBefore = f.w.d.kernel.id.owner;
  assert.equal(ownerBefore, f.ident.id);
  const s = await pairSecondDevice(t, f);
  assert.equal((await s.answer()).yes, true);
  const done = await s.pairing;
  assert.equal(done.session, true, "the second device has its paired session");
  assert.notEqual(done.device, f.done.device);
  assert.equal(f.w.d.kernel.id.owner, ownerBefore, "the kernel owner is the same");
  const rec = (await f.w.d.registry.call("wink.device.record", { id: done.device }, "module:presence")).data;
  assert.deepEqual([rec.kind, rec.owner], ["computer", f.ident.id]);
  const st = (await f.w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.owned, true);
  // the first device is still the adopter: nothing it holds moved
  assert.equal((await f.w.d.registry.call("wink.device.record", { id: f.done.device }, "module:presence")).data.owner, f.ident.id);
});

shardTest("FO-1: adopt never changes the owner of an owned server: the adopter naming another identity, with presence, is refused owned_by_other and nothing moves", async t => {
  const f = await pairFreshServer(t);
  const other = { kind: "identity", id: "per_" + "z".repeat(26), name: "Mallory" };
  const as = `device:${f.done.device}`;
  const r = await f.w.d.registry.call("wink.server.adopt", { owner: other, identity: other.id }, as, { ...PROOF, peer: { kind: "device", stableId: f.done.device, node: f.done.device } });
  assert.ok(r.error && r.error.code === "owned_by_other", JSON.stringify(r.error || r.data));
  const st = (await f.w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.owned, true);
  assert.equal(f.w.d.kernel.id.owner, f.ident.id, "the kernel owner is unchanged");
  assert.equal((await f.w.d.registry.call("wink.server.owner", {}, "module:spaces")).data.identity, f.ident.id, "and so is the pairing record");
});

// ---- the join, end to end (tailnet, 4 Oct; the invitee's first key from the accept itself, vault): two real daemons, a space hosted on the server, an invite, a second person's device that is not a member ----
shardTest("join end to end: a second identity's device previews and accepts an invite through the invitee door of a real server, on the real kernel; each refusal is the kernel's or the door's", { timeout: 180_000 }, async t => {
  const { claimServerSpace } = await import("../apps/app/src/identity/claim-space.js");
  const { startSealer } = await import("../kernel/seal/client.js");
  const { signer: sealSigner, enrolDevice, tmp } = await import("../kernel/seal/testing.js");
  const { proofRequest } = await import("../kernel/remote/proof.js");
  const ident = await standinIdentity(t);
  // the names directory and the module's clock run on real time here: the door checks a hello's time against the daemon's own clock
  Object.defineProperty(ident.clock, "t", { get: () => Date.now(), set() {}, configurable: true });
  // the server's kernel runs on a sealing process that takes one unattested software key (the owner's presence key for this test, enrolled the way the kernel suite does it)
  const sealDir = tmp("join-e2e-seal");
  const sealer = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close().catch(() => {}); fs.rmSync(sealDir, { recursive: true, force: true }); });
  const ownerSigner = sealSigner(ident.id);
  await enrolDevice(sealer, ownerSigner);
  const f = await pairFreshServer(t, { ident, kernelSealer: sealer });
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  const st = f.ident.store;
  const identity = { id: f.ident.id, name: "alex", eid: st.status().eid, ops: st.ops(), key: { sign: async m => new Uint8Array(await st.sign(Buffer.from(m))) } };
  const ROUTE = { relay: f.w.status.url, route: f.done.route, box: f.done.box };
  const made = await claimServerSpace({ identity, name: "harlow", displayName: "Harlow Legal", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, route: ROUTE,
    host: a => session.call("spaces.host-here", { ...a, proof: { key: "k1" } }) });
  assert.ok(f.w.d.kernel.spaces.hosts(made.space));
  // kit: a second real daemon with its own identity, in the same names directory (the module's fetch is the shared fake)
  spacesHooks.stretch = { memoryKiB: 64, passes: 1 };
  t.after(() => { spacesHooks.stretch = null; });
  const k = await world(t, { kernel: true });
  const kit = (await k.call("spaces.identity.create", { name: "kit", password: "four plain words here", deviceLabel: "Kit's laptop" })).data;
  assert.match(String(kit && kit.id), /^per_/);
  // alex's side: the invite is the hosted kernel's, made as the owner (the owner's own device and presence are the walk's step; the door is what is under test here)
  const hosted = f.w.d.kernel.spaces.hosted(made.space);
  const ownerChain = hosted.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-walk", person: f.owner.id, path: "direct" });
  const rkFp = crypto.createHash("sha256").update(`vyre-space-fingerprint-v1\n${made.pin.id}\n${made.rootPublic}`).digest("hex").slice(0, 32);
  const linkFor = async (to, extra = {}) => {
    const inv = await (async () => { const body = { role: "member", invitee: to, ...extra }; const req = proofRequest(made.space, "inviteCreate", body); return hosted.gateway.grants.invites.create(ownerChain, body, { presence: ownerSigner.proof(ownerChain, req.op, req.fields) }); })();
    return { id: inv.id, link: `https://harlow.vyre.run/join/${inv.id}.${Buffer.from(JSON.stringify({ chain: made.pin, rk: rkFp })).toString("base64url")}` };
  };
  const mine = await linkFor(kit.id);
  const preview = await k.call("spaces.invites.preview", { link: mine.link });
  assert.ok(!preview.error, JSON.stringify(preview.error));
  assert.deepEqual([preview.data.role, preview.data.status], ["member", "pending"]);
  // accept: the first call says what to sign; kit's own presence key (enrolled in the server's sealing process) signs it
  const kitSigner = sealSigner(kit.id);
  const first = await k.call("spaces.invites.accept", { link: mine.link });
  assert.equal(first.data && first.data.needs_proof, true, JSON.stringify(first.error || first.data));
  const inviteeChain = hosted.kernel.chains.fromFacts({ kind: "invitee", person: kit.id, vouched: true });
  // a presence key the server's sealing process has never enrolled for this person proves nothing: the invitee's first proof to a server it never touched has no path yet (reported to windows and vault)
  const unenrolled = await k.call("spaces.invites.accept", { link: mine.link }, SCREEN, { ...A, kernel_proof: kitSigner.proof(inviteeChain, first.data.request.op, first.data.request.fields) });
  if (process.env.WLOG) console.error("DBG unenrolled", JSON.stringify(unenrolled).slice(0, 400));
  assert.ok(unenrolled.error, "a key the server was never told of proves nothing");
  assert.equal(await sealer.health().then(h => h.needs_recovery.includes(kit.id)), false);
  // all or nothing: an accept that does not finish (a damaged presence proof) leaves no key behind, so the sealing process still knows nothing of kit
  const damaged = await k.call("spaces.invites.accept", { link: mine.link, presence_key: kitSigner.enrolment }, SCREEN, { ...A, kernel_proof: kitSigner.proof(inviteeChain, first.data.request.op, first.data.request.fields, { tamper: true }) });
  assert.ok(damaged.error, "a damaged proof does not join");
  assert.equal(await sealer.presenceCheck({ chain: inviteeChain, op: first.data.request.op, fields: first.data.request.fields, proof: kitSigner.proof(inviteeChain, first.data.request.op, first.data.request.fields) }), "unknown_key", "the key the failed accept enrolled was taken back");
  // the invitee's first key on this server comes from the accept itself (RC1): the app names the presence key, kit's identity device signs over this invite, Space and key, the server reads kit's list from the
  // directory, and its sealing process enrols the key inside the same accept. No fixture enrols anything.
  const joined = await k.call("spaces.invites.accept", { link: mine.link, presence_key: kitSigner.enrolment }, SCREEN, { ...A, kernel_proof: kitSigner.proof(inviteeChain, first.data.request.op, first.data.request.fields) });
  assert.ok(!joined.error, JSON.stringify(joined.error));
  assert.equal(joined.data.joined, true);
  // the server's kernel now has kit as a member, with the role the card showed
  const member = await hosted.gateway.grants.members.get(ownerChain, kit.id);
  assert.deepEqual([member.person, member.role], [kit.id, "member"]);
  // ... and the invite is spent: the same link opens nothing, and the home's kernel says so (the door closes the stream; the card cannot be read)
  const again = await k.call("spaces.invites.preview", { link: mine.link });
  assert.ok(again.error, `a spent invite shows no card: ${JSON.stringify(again.data)}`);
  // refusals with the kernel's own answers: an invite meant for someone else, and one that ran out
  const other = await linkFor("per_" + "x".repeat(26));
  assert.ok((await k.call("spaces.invites.preview", { link: other.link })).error, "an invite addressed to another person shows kit nothing");
  const brief = await linkFor(kit.id, { valid_ms: 40 });
  await new Promise(r => setTimeout(r, 120));
  assert.ok((await k.call("spaces.invites.preview", { link: brief.link })).error, "an expired invite shows nothing");
  // refusals at the door, from a raw invitee channel with a hello that is not kit's: nothing reaches the kernel but the preview of an invite the door never admits
  const fresh = await linkFor(kit.id);
  const crypt = nodeCrypto();
  const open = async hello => {
    const ks = keystore(t);
    const keys = await clientDeviceKey({ keyStore: ks, crypto: crypt });
    const r = await openChannel({ relay: f.w.status.url, route: f.done.route, box: Buffer.from(f.done.box, "base64url"), keys, hello: { v: 1, invitee: true }, crypto: crypt, WebSocket: globalThis.WebSocket });
    t.after(() => r.channel.close(1000, "done"));
    const head = await new Promise(res => { const st = r.channel.open({ peer: "wink", space: "home", invitee: { channel: r.reply.invitee, ...hello(r.reply.invitee) } }); st.onhead = x => res({ status: x && x.status, st }); st.onreset = () => res({ status: 0, st }); });
    const { peerSession, streamPipe } = await import("../core/wink/node/peer-wire.js");
    const sess = peerSession(streamPipe(head.st), { first: 1 });
    const call = () => sess.call("kernel.call", { v: 1, space: made.space, id: "x", ts: Date.now(), call: "grants.invites.get", args: [fresh.id] }, { timeoutMs: 4000 });
    return { status: head.status, call };
  };
  const base = { space: made.space, invite: fresh.id, identity: kit.id, entry: "a".repeat(26), ts: Date.now(), nonce: crypto.randomBytes(12).toString("base64url"), sig: "A".repeat(86) };
  for (const [why, hello] of Object.entries({
    "a signature that is not the identity's": () => base,
    "an identity the directory has never heard of": () => ({ ...base, identity: "per_" + "z".repeat(26) }),
    "a stale hello": () => ({ ...base, ts: Date.now() - 10 * 60_000 }),
    "an entry that is not on the identity's list": () => ({ ...base, entry: "b".repeat(26) }),
  })) {
    const r = await open(id => ({ ...hello(), channel: id }));
    assert.equal(r.status, 200, `${why}: the door opens the stream and refuses every call`);
    await assert.rejects(() => r.call(), e => e.code === "denied", why);
  }
  const hosted2 = f.w.d.kernel.spaces.hosted(made.space);
  assert.equal((await hosted2.gateway.grants.invites.get(ownerChain, fresh.id)).status, "pending", "no refusal touched the invite");
  assert.ok(f.w.logs.filter(l => /invitee .* refused \((bad_proof|unknown_identity|stale)\)/.test(l)).length >= 3, "the server logged why each hello was refused");
});

shardTest("an invitee on a development build joins in one accept: its own software key signs the accept and is enrolled on the server by the accept itself", { timeout: 180_000 }, async t => {
  const { claimServerSpace } = await import("../apps/app/src/identity/claim-space.js");
  const { startSealer } = await import("../kernel/seal/client.js");
  const { signer: sealSigner, enrolDevice, tmp } = await import("../kernel/seal/testing.js");
  const { proofRequest } = await import("../kernel/remote/proof.js");
  const ident = await standinIdentity(t);
  // the names directory and the module's clock run on real time here: the door checks a hello's time against the daemon's own clock
  Object.defineProperty(ident.clock, "t", { get: () => Date.now(), set() {}, configurable: true });
  // the server's kernel runs on a sealing process that takes one unattested software key (the owner's presence key for this test, enrolled the way the kernel suite does it)
  const sealDir = tmp("join-e2e-seal");
  const sealer = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true, software: true });
  t.after(async () => { await sealer.close().catch(() => {}); fs.rmSync(sealDir, { recursive: true, force: true }); });
  const ownerSigner = sealSigner(ident.id);
  await enrolDevice(sealer, ownerSigner);
  const f = await pairFreshServer(t, { ident, kernelSealer: sealer });
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  const st = f.ident.store;
  const identity = { id: f.ident.id, name: "alex", eid: st.status().eid, ops: st.ops(), key: { sign: async m => new Uint8Array(await st.sign(Buffer.from(m))) } };
  const ROUTE = { relay: f.w.status.url, route: f.done.route, box: f.done.box };
  const made = await claimServerSpace({ identity, name: "harlow", displayName: "Harlow Legal", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, route: ROUTE,
    host: a => session.call("spaces.host-here", { ...a, proof: { key: "k1" } }) });
  assert.ok(f.w.d.kernel.spaces.hosts(made.space));
  // kit: a second real daemon with its own identity, in the same names directory (the module's fetch is the shared fake)
  spacesHooks.stretch = { memoryKiB: 64, passes: 1 };
  t.after(() => { spacesHooks.stretch = null; });
  const k = await world(t, { kernel: true });
  const kit = (await k.call("spaces.identity.create", { name: "kit", password: "four plain words here", deviceLabel: "Kit's laptop" })).data;
  assert.match(String(kit && kit.id), /^per_/);
  // alex's side: the invite is the hosted kernel's, made as the owner (the owner's own device and presence are the walk's step; the door is what is under test here)
  const hosted = f.w.d.kernel.spaces.hosted(made.space);
  const ownerChain = hosted.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-walk", person: f.owner.id, path: "direct" });
  const rkFp = crypto.createHash("sha256").update(`vyre-space-fingerprint-v1\n${made.pin.id}\n${made.rootPublic}`).digest("hex").slice(0, 32);
  const linkFor = async (to, extra = {}) => {
    const inv = await (async () => { const body = { role: "member", invitee: to, ...extra }; const req = proofRequest(made.space, "inviteCreate", body); return hosted.gateway.grants.invites.create(ownerChain, body, { presence: ownerSigner.proof(ownerChain, req.op, req.fields) }); })();
    return { id: inv.id, link: `https://harlow.vyre.run/join/${inv.id}.${Buffer.from(JSON.stringify({ chain: made.pin, rk: rkFp })).toString("base64url")}` };
  };
  const mine = await linkFor(kit.id);
  const softSaved = process.env.VYRE_SEAL_SOFTWARE;
  process.env.VYRE_SEAL_SOFTWARE = "1";
  t.after(() => { if (softSaved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = softSaved; });
  const joined = await k.call("spaces.invites.accept", { link: mine.link });
  assert.ok(!joined.error && joined.data.joined === true, JSON.stringify(joined.error || joined.data).slice(0, 400));
  const member = await hosted.gateway.grants.members.get(ownerChain, kit.id);
  assert.deepEqual([member.person, member.role], [kit.id, "member"]);
  // the joined space is kit's now: it is listed, and its records are reached through a member stream to the home (no invite, no pairing)
  const listed = await k.call("spaces.list");
  assert.ok(!listed.error && listed.data.some((/** @type {any} */ x) => x.id === made.space && x.member === true), JSON.stringify(listed).slice(0, 300));
  // the home ends an invitee channel after its life (5 minutes in production; 1.2 s here): a member's next call reconnects with no error
  seams.set(f.w.root, { ...(seams.get(f.w.root) || {}), inviteeTotalMs: 1200 });
  t.after(() => { seams.delete(f.w.root); });
  const asKit = (/** @type {string} */ tool, /** @type {any} */ input) => import("../core/daemon/client.js").then(m => m.call(tool, input, { root: k.root, caller: "cli" }));
  const types = await asKit("records.types", { space: made.space });
  assert.ok(!types.error, JSON.stringify(types.error || types.data).slice(0, 400));
  assert.equal(types.data.acted_in.id, made.space);
  assert.equal(f.w.logs.filter(l => /peer door: member .* refused/.test(l)).length, 0, "the member was admitted");
  const opened = () => f.w.logs.filter(l => /peer door: invitee .* opened a stream/.test(l)).length;
  const before = opened();
  await new Promise(r => setTimeout(r, 1800));
  const later = await asKit("records.types", { space: made.space });
  assert.ok(opened() > before, "the lapsed channel was really replaced by a new stream");
  assert.ok(!later.error, `after the channel's life the next call reconnects: ${JSON.stringify(later.error)}`);
  await new Promise(r => setTimeout(r, 1800));
  const [x, y] = await Promise.all([asKit("records.types", { space: made.space }), asKit("records.types", { space: made.space })]);
  assert.ok(!x.error && !y.error, `two calls at once after a lapse: ${JSON.stringify(x.error || y.error)}`);
  // a person who is NOT a member gets nothing from the member door, even holding a row that says otherwise: the home's kernel answers for membership
  const z = await world(t, { kernel: true });
  const zed = (await z.call("spaces.identity.create", { name: "zed", password: "four plain words here", deviceLabel: "Zed's laptop" })).data;
  assert.match(String(zed && zed.id), /^per_/);
  z.d.registry.deps.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`member-of/${made.space}`, JSON.stringify({ channel: ROUTE, name: "harlow.vyre.run", role: "member", at: 1 }));
  const nope = await import("../core/daemon/client.js").then(m => m.call("records.types", { space: made.space }, { root: z.root, caller: "cli" }));
  assert.ok(nope.error, "a non-member reads nothing through the member door");
  await until(async () => f.w.logs.some(l => /peer door: member .* refused \(not_a_member/.test(l)));
});

shardTest("one permission rule: a paired device is you: an admin act passes with no session, before and after its sessions end; a vault reveal without a yes is refused", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const rk = links.remoteKernel("srv", f.w.d.kernel.id.space);
  // no startPaired at all: the device was paired with the owner's yes, so it is the owner
  assert.equal(await rk.gateway.records.define(null, { add_types: [CONTACT] }).then(() => "ok", e => String(e.code || e.message)), "ok", "an admin act from a paired device needs no session");
  await links.startPaired("srv");
  await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink");
  assert.equal(await rk.gateway.records.define(null, { add_types: [{ name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] }] }).then(() => "ok", e => String(e.code || e.message)), "ok", "and after its sessions ended");
  // the three moments still want a yes: a vault secret is not revealed for a paired device's say-so
  await links.startPaired("srv");
  await assert.rejects(() => links.sessionFor("srv").call("vault.reveal", { name: "northwind-mail" }), e => /presence|denied/.test(`${e.code} ${e.message}`), "a vault reveal without a yes is refused");
});

shardTest("the session strength is proven at each sign-in (the identity entry's enclave key over the challenge); a card for the owner's phone carries a browser's yes back once and upgrades nothing", async t => {
  const strengthsOf = async f => { const m = (await f.w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data; return (m.sessions || m).map(x => x.strength); };
  // a device key alone, and an enclave signature by another key: software; and the enclave key must still stand on the directory list
  { const f = await pairFreshServer(t, { presenceStorage: "hardware" });
    const enc = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }), other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = enc.publicKey.export({ format: "jwk" });
    f.w.d.registry.deps.db.prepare("UPDATE wink_devices SET enclave_key = ? WHERE id = ?").run(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"), f.done.device);
    const signWith = k => m => crypto.sign("sha256", Buffer.from(m), { key: k.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const linksWith = signEnclave => { const l = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's iPhone", sign: f.sign, ...(signEnclave ? { signEnclave } : {}), channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) }); t.after(() => l.close()); return l; };
    await linksWith(null).startPaired("srv");
    assert.deepEqual(await strengthsOf(f), ["software"], "the device key alone");
    await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink");
    await linksWith(signWith(other)).startPaired("srv");
    assert.deepEqual(await strengthsOf(f), ["software"], "a signature by a key that is not the identity entry's enclave key proves nothing");
    await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink");
    await linksWith(signWith(enc)).startPaired("srv");
    assert.deepEqual(await strengthsOf(f), ["software"], "an enclave key that no directory entry holds is software (the live positive case is in core/wink/pairing.test.js and core/presence/presence.test.js)"); }
  // a browser asks the owner's phone for a yes through the approvals queue: only for the three moments, one card, the phone's signed yes is verified and spent when it answers, and the browser's session is not upgraded
  { const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software" }); const links = linksFor(t, f); await links.startPaired("srv");
    const { payloadHash } = await import("../kernel/seal/wire.js");
    const asOwner = (tool, input, proof) => f.w.d.registry.call(tool, input, "cli", { person: { id: "ps1" }, ...(proof ? { kernel_proof: proof } : {}) });
    await assert.rejects(() => links.askApproval("srv", { moment: "admin", request: { op: "x.y", fields: {} } }), e => /bad_input|moment|enum/i.test(`${e.code} ${e.message}`) || assert.fail(`unexpected refusal: ${e.code} ${e.message}`), "a card is for one of the three moments");
    const request = { op: "vault.reveal", fields: { name: "northwind-mail" } };
    // the request must fit the moment and be plain data
    await assert.rejects(() => links.askApproval("srv", { moment: "vault", request: { op: "email.send", fields: {} } }), e => /bad_input/.test(String(e.code)), "a vault card asks for a vault op");
    await assert.rejects(() => links.askApproval("srv", { moment: "outward", request: { op: "vault.reveal", fields: { name: "x" } } }), e => /bad_input/.test(String(e.code)));
    // MO-1: each moment covers an explicit list of tools; a destructive tool whose name merely begins the same way is refused at ask
    for (const [moment, op] of [["pair", "wink.remove"], ["pair", "wink.server.reset"], ["vault", "vault.export"], ["vault", "vault.put"], ["vault", "vault.move"]]) await assert.rejects(() => links.askApproval("srv", { moment, request: { op, fields: {} } }), e => /bad_input/.test(String(e.code)), `${moment}: ${op} is not a card`);
    // and at the floor: an approval never counts for such a tool
    const del = await links.sessionFor("srv").call("vault.delete", { name: "northwind-mail", approval: "ap_notacardatall1" }).then(() => null, e => e);
    assert.ok(del && /presence|denied/.test(`${del.code} ${del.message}`) && true, "vault.delete is not a moment: the old floor");
    await assert.rejects(() => links.askApproval("srv", { moment: "vault", request: { op: "vault.reveal", fields: { name: { nested: true } } } }), e => /bad_input/.test(String(e.code)), "plain field values only");
    const ask = await links.askApproval("srv", { moment: "vault", request });
    assert.equal(ask.line, "Alexs iPhone wants to show \"northwind-mail\" from your vault", "a line the server wrote, with its own name for the device");
    assert.equal((await links.approvalStatus("srv", ask.id)).state, "waiting");
    // the same card again is the same card; a different one while it waits is refused naming the open one
    assert.equal((await links.askApproval("srv", { moment: "vault", request })).id, ask.id);
    await assert.rejects(() => links.askApproval("srv", { moment: "vault", request: { op: "vault.reveal", fields: { name: "another-secret" } } }), e => /conflict/.test(String(e.code)), "a second, different card does not get the first one's id");
    // the phone lists the card with exactly what its key signs
    const pending = (await asOwner("approvals.pending", {})).data.approvals;
    assert.deepEqual(pending.map(a => [a.id, a.moment, a.request.op]), [[ask.id, "vault", "vault.reveal"]], "the owner's phone lists the card");
    assert.deepEqual(pending[0].sign.op, "task.vault_use");
    assert.equal(pending[0].sign.space, f.w.d.kernel.id.space, "the home's space");
    assert.deepEqual(pending[0].sign.fields, { what: "vault.reveal", fields: { name: "northwind-mail" } }, "fixed keys, the request nested: no field can override the op");
    const card = pending[0], hash = payloadHash(card.sign.op, card.sign.space, card.sign.fields);
    assert.equal(card.payload_hash, hash);
    // the answer counts only when it carries a yes signed by a real key over the card (yes(): here a stand-in verifier that knows the two kinds of key); it is checked and spent when given
    const { configureYes } = await import("../core/presence/index.js");
    configureYes({ verify: async ({ proof }) => (proof && proof.signer === "secure_enclave" ? { ok: true, strength: "real" } : proof && proof.signer === "software" ? { ok: true, strength: "software" } : "unknown_key"), softwareOk: () => false });
    t.after(() => configureYes({ verify: null }));
    const soft = await asOwner("approvals.answer", { id: ask.id, approve: true }, { signer: "software", payload_hash: hash });
    assert.equal(soft.error && soft.error.code, "software_key", "a software key's answer is refused on a release build");
    const junk = await asOwner("approvals.answer", { id: ask.id, approve: true }, { junk: 1, payload_hash: hash });
    assert.equal(junk.error && junk.error.code, "unknown_key", "any object is not a yes: refused with the yes() reason");
    const wrongHash = await asOwner("approvals.answer", { id: ask.id, approve: true }, { signer: "secure_enclave", payload_hash: "x".repeat(43) });
    assert.ok(wrongHash.error, "a yes over another request does not stand");
    assert.equal((await links.approvalStatus("srv", ask.id)).state, "waiting", "no refused answer approved the card");
    const selfAnswer = await f.w.d.registry.call("approvals.answer", { id: ask.id, approve: true }, `device:${f.done.device}`, { peer: { kind: "device", stableId: f.done.device, node: f.done.device }, kernel_proof: { signer: "secure_enclave", payload_hash: hash } });
    assert.ok(selfAnswer.error, "a device cannot answer its own card");
    assert.equal((await asOwner("approvals.answer", { id: ask.id, approve: true }, { signer: "secure_enclave", payload_hash: hash })).data.answered, "approved");
    const first = await links.approvalStatus("srv", ask.id);
    assert.deepEqual([first.state, first.approval, first.proof], ["approved", ask.id, undefined], "the browser learns it is approved and gets the approval's id, never the phone's proof");
    // the approval is spent ONCE by the asking device's act (the phone's proof was spent when it answered, so it is never replayed at the moment)
    const { yes: yesAt } = await import("../core/presence/index.js");
    const act = { op: "vault.reveal", fields: { name: "northwind-mail" }, device: f.done.device };
    assert.deepEqual(await yesAt("vault", { op: "vault.reveal", fields: { name: "another-secret" }, device: f.done.device }, { card: ask.id }), { ok: false, reason: "wrong_request" }, "an approval is for exactly the request on it");
    assert.deepEqual(await yesAt("vault", { ...act, device: "someotherdevice" }, { card: ask.id }), { ok: false, reason: "wrong_request" }, "and for the device that asked");
    assert.deepEqual(await yesAt("outward", act, { card: ask.id }), { ok: false, reason: "wrong_request" }, "and for its moment");
    const { device: _omit, ...noDevice } = act;
    assert.deepEqual(await yesAt("vault", noDevice, { card: ask.id }), { ok: false, reason: "no_proof" }, "a redeem that names no device spends nothing (CI-1)");
    // the vault tool itself: the browser calls it with the approval beside the call; the old presence floor does not stop it, and the approval is spent
    const via = () => links.sessionFor("srv").call("vault.reveal", { name: "northwind-mail", approval: ask.id }).then(() => null, e => e);
    const used = await via();
    assert.ok(!used || !/presence/i.test(`${used.code} ${used.message}`), `an approved vault call passes the floor (what the vault says next is its own: ${used && used.code})`);
    const again = await via();
    assert.ok(again && /presence/i.test(`${again.code} ${again.message}`), "the approval was spent: the same call is stopped by the floor again");
    // a vault call with neither a proof nor an approval is stopped by the ordinary floor (presence_required): that is the app's trigger to ask for a card
    assert.deepEqual(await yesAt("vault", act, { card: ask.id }), { ok: false, reason: "replayed" }, "once");
    assert.deepEqual(await yesAt("vault", act, { card: "ap_unknown" }), { ok: false, reason: "no_proof" });
    assert.deepEqual(await strengthsOf(f), ["software"], "nothing about the browser's own session changed"); }
  // a refused card holds the device for 10 minutes
  { const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software" }); const links = linksFor(t, f); await links.startPaired("srv");
    const outward = { moment: "outward", request: { op: "mail.send", fields: { to: "jane@example.com" } } };
    const ask = await links.askApproval("srv", outward);
    // a software browser's no is ignored (it could stall the owner); the owner's own screen on the server can say no
    const softNo = await f.w.d.registry.call("approvals.answer", { id: ask.id, approve: false }, "device:zzzzzzzzzzzzzzzz", { peer: { kind: "device", stableId: "zzzzzzzzzzzzzzzz", node: "zzzzzzzzzzzzzzzz" }, person: { id: "ps-none" } });
    assert.ok(softNo.error || (softNo.data && softNo.data.answered === "ignored"), "a software device's no does not count");
    assert.equal((await links.approvalStatus("srv", ask.id)).state, "waiting", "the card is still waiting");
    assert.equal((await f.w.d.registry.call("approvals.answer", { id: ask.id, approve: false }, "cli", { person: { id: "ps1" } })).data.answered, "refused");
    assert.equal((await links.approvalStatus("srv", ask.id)).state, "refused");
    await assert.rejects(() => links.askApproval("srv", outward), e => /rate_limited/.test(String(e.code)), "no new card right after a no"); }
});

shardTest("the daemon wires yes() to the kernel's own verifier: a real-key yes stands once, and a replay, another request and an unknown key are refused", async t => {
  const { startSealer } = await import("../kernel/seal/client.js");
  const { signer: sealSigner, enrolDevice, tmp } = await import("../kernel/seal/testing.js");
  const ident = await standinIdentity(t);
  const sealDir = tmp("yes-wired-seal");
  const sealer = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close().catch(() => {}); fs.rmSync(sealDir, { recursive: true, force: true }); });
  const f = await pairFreshServer(t, { ident, kernelSealer: sealer });
  const owner = sealSigner(ident.id);
  await enrolDevice(sealer, owner);
  const chain = f.w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-yes", person: ident.id, path: "direct" });
  const { yes, signOf } = await import("../core/presence/index.js");
  const req = { op: "vault.reveal", fields: { name: "northwind-mail" } };
  const sg = signOf("vault", req);
  const proof = owner.proof(chain, sg.op, sg.fields);
  assert.deepEqual(await yes("vault", { chain, ...req }, proof), { ok: true }, "the owner's real key says yes");
  assert.deepEqual(await yes("vault", { chain, ...req }, proof), { ok: false, reason: "replayed" }, "the same proof twice");
  const other = owner.proof(chain, sg.op, { ...sg.fields, what: "vault.copy" });
  assert.equal((await yes("vault", { chain, ...req }, other)).ok, false, "a proof over another request does not stand");
  const stranger = sealSigner(ident.id);
  assert.deepEqual(await yes("vault", { chain, ...req }, stranger.proof(chain, sg.op, sg.fields)), { ok: false, reason: "unknown_key" }, "a key the server never enrolled");
  assert.deepEqual(await yes("admin", { chain, ...req }, proof), { ok: false, reason: "wrong_request" }, "only the three moments");
  // each moment end to end on the real sealer (CS-3): the act words the sealing process takes, the card's op and fields inside
  for (const [moment, r] of [["pair", { op: "wink.phone.pair.answer", fields: { name: "Alex's phone" } }], ["outward", { op: "mail.send", fields: { to: "jane@example.com" } }]]) {
    const g = signOf(moment, r), p = owner.proof(chain, g.op, g.fields);
    assert.deepEqual(await yes(moment, { chain, ...r }, p), { ok: true }, `${moment}: the real key says yes`);
    assert.deepEqual(await yes(moment, { chain, ...r }, p), { ok: false, reason: "replayed" }, `${moment}: once`);
  }
  // CI-2: no field of any request can override the op in the signed bytes; two different requests never sign the same bytes
  const a = signOf("outward", { op: "slack.post", fields: { x: 1 } }), b = signOf("outward", { op: "mail.send", fields: { what: "slack.post", x: 1 } });
  assert.notDeepEqual(a.fields, b.fields);
  assert.notEqual(JSON.stringify(signOf("outward", { op: "mail.send", fields: { what: "A" } }).fields), JSON.stringify(signOf("outward", { op: "mail.send", fields: { what: "B" } }).fields), "even a field called what is signed, not dropped");
});


/** A real paired server with a team space "harlow" hosted on it by alex, whose name and key live in the (stand-in) app: the rig of the team tests below. */
async function teamRig(t, { release = false } = {}) {
  const { claimServerSpace } = await import("../apps/app/src/identity/claim-space.js");
  const { startSealer } = await import("../kernel/seal/client.js");
  const { signer: sealSigner, enrolDevice, tmp } = await import("../kernel/seal/testing.js");
  const { proofRequest } = await import("../kernel/remote/proof.js");
  const ident = await standinIdentity(t);
  Object.defineProperty(ident.clock, "t", { get: () => Date.now(), set() {}, configurable: true });
  const sealDir = tmp("join-team-seal");
  const sealer = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: !release });
  t.after(async () => { await sealer.close().catch(() => {}); fs.rmSync(sealDir, { recursive: true, force: true }); });
  const ownerSigner = sealSigner(ident.id);
  await enrolDevice(sealer, ownerSigner);
  const f = await pairFreshServer(t, { ident, kernelSealer: sealer });
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  const st = f.ident.store;
  const identity = { id: f.ident.id, name: "alex", eid: st.status().eid, ops: st.ops(), key: { sign: async m => new Uint8Array(await st.sign(Buffer.from(m))) } };
  const ROUTE = { relay: f.w.status.url, route: f.done.route, box: f.done.box };
  const made = await claimServerSpace({ identity, name: "harlow", displayName: "Harlow Legal", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, route: ROUTE,
    host: a => session.call("spaces.host-here", { ...a, proof: { key: "k1" } }) });
  assert.ok(f.w.d.kernel.spaces.hosts(made.space));
  const hosted = f.w.d.kernel.spaces.hosted(made.space);
  const ownerChain = hosted.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-walk", person: f.owner.id, path: "direct" });
  const rkFp = crypto.createHash("sha256").update(`vyre-space-fingerprint-v1\n${made.pin.id}\n${made.rootPublic}`).digest("hex").slice(0, 32);
  const linkFor = async (to, extra = {}) => {
    const body = { role: "member", invitee: to, ...extra };
    const req = proofRequest(made.space, "inviteCreate", body);
    const inv = await hosted.gateway.grants.invites.create(ownerChain, body, { presence: ownerSigner.proof(ownerChain, req.op, req.fields) });
    return { id: inv.id, link: `https://harlow.vyre.run/join/${inv.id}.${Buffer.from(JSON.stringify({ chain: made.pin, rk: rkFp })).toString("base64url")}` };
  };
  return { ident, f, links, session, made, hosted, ownerChain, rkFp, linkFor, sealer, ownerSigner, sealSigner, ROUTE };
}

shardTest("join a team with no server, end to end: a second identity that has only a name opens the invite, is admitted as a member through the invitee door of the real server, enrols its key there, and reaches the space with a member call", { timeout: 180_000 }, async t => {
  const { openInvite, callTeam } = await import("../apps/app/src/real/join-team.js");
  const { WORDS } = await import("../relay/client/words.js");
  const { ident, f, made, hosted, ownerChain, linkFor, sealer, sealSigner, ROUTE } = await teamRig(t);
  // kit has a name in the same directory and NO server: no daemon is started for kit, only the app's libraries
  const kit = await ident.another("kit");
  const mine = await linkFor(kit.id);
  const kitSigner = sealSigner(kit.id);
  const inviteeChain = hosted.kernel.chains.fromFacts({ kind: "invitee", person: kit.id, vouched: true });
  const rows = new Map();
  const deps = {
    who: { id: kit.id, name: "kit", eid: kit.eid, sign: async m => new Uint8Array(await kit.store.sign(Buffer.from(m))) },
    fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1", connect, openServerPeer, crypto: nodeCrypto(), words: WORDS,
    signPresence: async req => kitSigner.proof(inviteeChain, req.op, req.fields),
    presenceKey: async () => kitSigner.enrolment,
    store: { get: async k => rows.get(k), put: async (k, v) => { rows.set(k, v); } },
  };
  // the card, read through the home's kernel, with the home proving it holds the space
  const inv = await openInvite(deps, mine.link);
  t.after(() => inv.close());
  assert.deepEqual([inv.card.role, inv.card.status, inv.card.invitee], ["member", "pending", kit.id]);
  assert.equal(inv.card.space, "harlow.vyre.run");
  assert.match(inv.card.fingerprint_words, /^\w+ \w+ \w+ \w+$/);
  assert.deepEqual(inv.channel, ROUTE, "the route came from the space's directory record, not from the link");
  // not a member yet
  await assert.rejects(() => callTeam(deps, made.space, "grants.members.list", []), e => e.code === "not_a_member");
  // the yes: kit's presence key signs the card, kit's identity key vouches for that key, the server enrols it inside the accept
  const joined = await inv.accept();
  assert.equal(joined.joined, true);
  assert.equal(joined.membership.role, "member");
  const member = await hosted.gateway.grants.members.get(ownerChain, kit.id);
  assert.deepEqual([member.person, member.role], [kit.id, "member"]);
  assert.deepEqual(rows.get(`member-of/${made.space}`).channel, ROUTE, "the device keeps where the team's home is");
  // the app reaches the team's space as a member and calls a tool; the server's sealing process has this device's key now
  const list = await callTeam(deps, made.space, "grants.members.list", []);
  const people = (Array.isArray(list) ? list : list.members || []).map(m => m.person);
  assert.deepEqual(people, [kit.id], "a member sees their own membership through the member door");
  assert.equal(await sealer.presenceCheck({ chain: hosted.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-kit", person: kit.id, path: "direct" }), op: "grant.accept", fields: { x: 1 }, proof: kitSigner.proof(inviteeChain, "grant.accept", { x: 1 }) }) !== "unknown_key", true, "this device's presence key is enrolled on the server");
  // the invite is spent; an invite meant for someone else, a forged fingerprint and a space nobody hosts show kit nothing
  await assert.rejects(() => openInvite(deps, mine.link), e => e.code === "not_for_you");
  const other = await linkFor("per_" + "x".repeat(26));
  await assert.rejects(() => openInvite(deps, other.link), e => e.code === "not_for_you");
  const fresh = await linkFor(kit.id);
  const [id0, blob] = fresh.link.split("/join/")[1].split(".");
  const bad = JSON.parse(Buffer.from(blob, "base64url").toString()); bad.rk = "0".repeat(32);
  await assert.rejects(() => openInvite(deps, `https://harlow.vyre.run/join/${id0}.${Buffer.from(JSON.stringify(bad)).toString("base64url")}`), e => e.code === "forged");
  await assert.rejects(() => openInvite(deps, "https://harlow.example.com/join/" + id0 + "." + blob), e => e.code === "bad_input");
  assert.equal(f.w.logs.filter(l => /peer door: member .* refused/.test(l)).length, 0, "the member was admitted by the door");
});

shardTest("a team invite made by the owner's app and joined by the invitee's app, on a real server: the server holds no identity, the home's kernel asks the owner's key for its yes on the invite, the link carries the pinned list, and kit joins with it", { timeout: 180_000 }, async t => {
  const { openInvite, callTeam } = await import("../apps/app/src/real/join-team.js");
  const { kernelWire } = await import("../apps/app/src/real/kernel-wire.js");
  const { createTeamInvite, listTeamInvites, revokeTeamInvite } = await import("../apps/app/src/real/team-invite.js");
  const { WORDS } = await import("../relay/client/words.js");
  const { ident, f, session, made, hosted, ownerChain, sealSigner, ownerSigner, ROUTE } = await teamRig(t);
  const kit = await ident.another("kit");
  const kitSigner = sealSigner(kit.id);
  const inviteeChain = hosted.kernel.chains.fromFacts({ kind: "invitee", person: kit.id, vouched: true });
  // the owner's app: its paired session to the server, and its key answering the home's challenge (the proof names the home and the challenge)
  const asked = [];
  const wire = kernelWire(session, made.space, { person: ident.id, signPresence: async card => { asked.push(card); return ownerSigner.proof(ownerChain, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }); } });
  const dir = { wire, fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1" };
  const mine = await createTeamInvite(dir, { space: made.space, name: "harlow", role: "member", to: kit.id });
  assert.match(mine.link, /^https:\/\/harlow\.vyre\.run\/join\/inv_[0-9a-f]{32}\./);
  assert.equal(mine.needs_confirm, false);
  assert.deepEqual(asked.map(c => c.op), ["grant.invite"], "the owner's key was asked once, for this invite");
  assert.match(asked[0].home, /\S/);
  // the link carries the pin and the fingerprint the joiner checks against the record
  const blob = JSON.parse(Buffer.from(mine.token.split(".")[1], "base64url").toString());
  assert.deepEqual(blob.chain, made.pin);
  assert.equal(blob.rk, crypto.createHash("sha256").update(`vyre-space-fingerprint-v1\n${made.pin.id}\n${made.rootPublic}`).digest("hex").slice(0, 32));
  const rows = await listTeamInvites(dir);
  assert.deepEqual(rows.map(r => [r.id, r.status, r.role]), [[mine.id, "pending", "member"]]);
  // kit joins with it (the joiner's app, no server)
  const store = new Map();
  const deps = {
    who: { id: kit.id, name: "kit", eid: kit.eid, sign: async m => new Uint8Array(await kit.store.sign(Buffer.from(m))) },
    fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1", connect, openServerPeer, crypto: nodeCrypto(), words: WORDS,
    signPresence: async req => kitSigner.proof(inviteeChain, req.op, req.fields),
    presenceKey: async () => kitSigner.enrolment,
    store: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); } },
  };
  const inv = await openInvite(deps, mine.link);
  t.after(() => inv.close());
  assert.equal(inv.card.role, "member");
  const joined = await inv.accept();
  assert.equal(joined.joined, true);
  assert.deepEqual((await listTeamInvites(dir)).map(r => r.status), ["used"]);
  assert.equal((await hosted.gateway.grants.members.get(ownerChain, kit.id)).role, "member");
  // a cancelled invite shows the invitee nothing
  const second = await createTeamInvite(dir, { space: made.space, name: "harlow", role: "member", to: kit.id });
  await revokeTeamInvite(dir, second.id);
  assert.deepEqual(asked.map(c => c.op), ["grant.invite", "grant.invite", "grant.invite"], "creating asked once; cancelling asked once more");
  await assert.rejects(() => openInvite({ ...deps, store: { get: async () => undefined, put: async () => {} } }, second.link), e => e.code === "not_for_you");
  // an invite for a name nobody has, and a challenge the home did not make for this call, make nothing
  await assert.rejects(() => createTeamInvite(dir, { space: made.space, name: "harlow", role: "member", to: "nobody-has-this-name" }), e => e.code === "not_found");
  const lying = kernelWire({ call: async (tool, req) => ({ v: 1, id: req.id, ok: false, error: { code: "presence_required", message: "x", challenge: { call: req.call, space: req.space, home: "h", nonce: "n".repeat(16), args_hash: "wrong", op: "grant.invite", fields: {}, payload_hash: "z" } } }) }, made.space, { person: ident.id, signPresence: async () => { throw new Error("must not sign"); } });
  await assert.rejects(() => lying.call("grants.invites.create", [{ role: "member" }]), e => e.code === "presence_required");
  assert.equal(f.w.logs.filter(l => /kernel remote: grants.invites.create .* refused as (bad_binding|bad_challenge)/.test(l)).length, 0);
});


shardTest("join on a release server (the sealing process takes no unattested-by-switch keys): a secure-chip key joins, a software key is refused and nothing is left behind", { timeout: 180_000 }, async t => {
  const { openInvite } = await import("../apps/app/src/real/join-team.js");
  const { WORDS } = await import("../relay/client/words.js");
  const { ident, f, made, hosted, ownerChain, linkFor, sealer, sealSigner } = await teamRig(t, { release: true });
  assert.equal((await sealer.health()).unattested_allowed, false, "this is the release rule");
  const mk = async (name, signerKind) => {
    const who = await ident.another(name);
    const sg = sealSigner(who.id, undefined, signerKind);
    const chain = hosted.kernel.chains.fromFacts({ kind: "invitee", person: who.id, vouched: true });
    const tokens = [];
    const deps = {
      who: { id: who.id, name, eid: who.eid, sign: async m => new Uint8Array(await who.store.sign(Buffer.from(m))) },
      fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1", connect, openServerPeer, crypto: nodeCrypto(), words: WORDS,
      signPresence: async req => sg.proof(chain, req.op, req.fields),
      presenceKey: async invite => { tokens.push(invite); return sg.enrolment; },
      store: { get: async () => undefined, put: async () => {} },
    };
    return { who, deps, tokens };
  };
  // a phone's secure-chip key: taken unattested on a release server (marked so), joined
  const kit = await mk("kit", "secure_enclave");
  const inv = await linkFor(kit.who.id);
  const open = await openInvite(kit.deps, inv.link);
  t.after(() => open.close());
  assert.equal((await open.accept()).joined, true);
  assert.deepEqual(kit.tokens, [inv.id], "the app asks for its key's enrolment with the invite id, which is what an attestation is made over");
  assert.equal((await hosted.gateway.grants.members.get(ownerChain, kit.who.id)).role, "member");
  // a software key (a browser or a page's own key) is not a key a release server takes: the accept fails whole
  const sw = await mk("sam", "software");
  const inv2 = await linkFor(sw.who.id);
  const open2 = await openInvite(sw.deps, inv2.link);
  t.after(() => open2.close());
  await assert.rejects(() => open2.accept(), e => /software_refused|bad_signer|unattested/.test(String(e.code)), "a software key is refused");
  await assert.rejects(() => hosted.gateway.grants.members.get(ownerChain, sw.who.id), e => e.code === "not_found", "no membership was made");
  assert.equal((await hosted.gateway.grants.invites.get(ownerChain, inv2.id)).status, "pending", "the invite is not spent");
});

shardTest("a Windows PC joins a team on a release server with its Windows Hello passkey as the presence key: the passkey is made for the window's site, enrolled as webauthn_platform with that rp, and its WebAuthn assertion is the yes", { timeout: 180_000 }, async t => {
  const { openInvite, callTeam } = await import("../apps/app/src/real/join-team.js");
  const { windowsPasskey } = await import("../apps/app/src/real/windows-passkey.js");
  const { authenticator } = await import("../apps/app/src/identity/soft-authenticator.js");
  const { WORDS } = await import("../relay/client/words.js");
  const { ident, made, hosted, ownerChain, linkFor, sealer } = await teamRig(t, { release: true });
  assert.equal((await sealer.health()).unattested_allowed, false);
  const kit = await ident.another("kit");
  const auth = authenticator({ rp: "kit-pc.vyre.run" });
  const kept = new Map();
  const store = { get: async k => kept.get(k), put: async (k, v) => { kept.set(k, v); } };
  // the window's own site decides the passkey's rp; a page the shell does not take makes none
  assert.equal(await windowsPasskey({ origin: "https://example.com", store, webauthn: auth }), null);
  assert.equal(auth.seen.creates, 0);
  const wp = await windowsPasskey({ origin: "https://kit-pc.vyre.run", store, webauthn: auth });
  assert.equal(wp.rp, "kit-pc.vyre.run");
  assert.equal(wp.enrolment.signer, "webauthn_platform");
  assert.equal(auth.seen.creates, 1);
  const again = await windowsPasskey({ origin: "https://kit-pc.vyre.run", store, webauthn: auth });
  assert.equal(again.enrolment.key_id, wp.enrolment.key_id, "the kept passkey is used again, none is made");
  assert.equal(auth.seen.creates, 1);
  const deps = {
    who: { id: kit.id, name: "kit", eid: kit.eid, sign: async m => new Uint8Array(await kit.store.sign(Buffer.from(m))) },
    fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1", connect, openServerPeer, crypto: nodeCrypto(), words: WORDS,
    signPresence: req => wp.signer.signPresence(req),
    presenceKey: async () => wp.enrolment,
    store: { get: async () => undefined, put: async () => {} },
  };
  const inv = await linkFor(kit.id);
  const open = await openInvite(deps, inv.link);
  t.after(() => open.close());
  const joined = await open.accept();
  assert.equal(joined.joined, true);
  assert.equal((await hosted.gateway.grants.members.get(ownerChain, kit.id)).role, "member");
  assert.ok(auth.seen.gets >= 1, "the Hello prompt (the authenticator's get) was asked for the yes");
});


shardTest("a person whose device entry is a passkey joins a team through the invitee door on a release server: the hello is a WebAuthn assertion, the held key is still refused", { timeout: 180_000 }, async t => {
  const { openInvite, callTeam } = await import("../apps/app/src/real/join-team.js");
  const { windowsPasskey } = await import("../apps/app/src/real/windows-passkey.js");
  const { authenticator } = await import("../apps/app/src/identity/soft-authenticator.js");
  const { WORDS } = await import("../relay/client/words.js");
  const { ident, made, hosted, ownerChain, linkFor, sealSigner } = await teamRig(t, { release: true });
  const mk = (who, name, sign, sg, chain, store) => ({
    who: { id: who.id, name, eid: who.eid, sign },
    fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1", connect, openServerPeer, crypto: nodeCrypto(), words: WORDS, store,
    signPresence: async r => (sg.proof ? sg.proof(chain, r.op, r.fields) : sg.signer.signPresence(r)), presenceKey: async () => sg.enrolment,
  });
  // the held key (a page script can reach it) is not a device the door takes
  const held = await ident.anotherHeld("heldpc");
  const hsg = sealSigner(held.id, undefined, "secure_enclave");
  const hchain = hosted.kernel.chains.fromFacts({ kind: "invitee", person: held.id, vouched: true });
  const hinv = await linkFor(held.id);
  await assert.rejects(() => openInvite(mk(held, "heldpc", async m => new Uint8Array(await held.key.sign(m)), hsg, hchain, { get: async () => undefined, put: async () => {} }), hinv.link), e => e.code === "not_for_you");
  // a passkey is: the identity's own device is the Hello passkey, and the hello is its assertion
  const auth = authenticator({ rp: "app.vyre.run" });
  const pk = await ident.anotherPasskey("passpc", auth);
  const pw = await windowsPasskey({ origin: "https://app.vyre.run", store: { get: async () => undefined, put: async () => {} }, webauthn: authenticator({ rp: "app.vyre.run" }) });
  const rows = new Map();
  const deps = mk(pk, "passpc", async m => pk.key.sign(m), pw, null, { get: async k => rows.get(k), put: async (k, v) => { rows.set(k, v); } });
  const inv = await linkFor(pk.id);
  const open = await openInvite(deps, inv.link);
  t.after(() => open.close());
  assert.equal((await open.accept()).joined, true);
  assert.equal((await hosted.gateway.grants.members.get(ownerChain, pk.id)).role, "member");
  // and it reaches the space as a member: a new hello, a new assertion
  const list = await callTeam(deps, made.space, "grants.members.list", []);
  assert.deepEqual((Array.isArray(list) ? list : list.members || []).map(m => m.person), [pk.id]);
});


shardTest("a Windows PC that claimed its name with Windows Hello (rp vyreapp.localhost): one passkey is the identity, the presence key and the signer of list changes; it joins a team, reaches it as a member, and adds a phone to its own name", { timeout: 180_000 }, async t => {
  const { openInvite, callTeam } = await import("../apps/app/src/real/join-team.js");
  const { windowsPasskey } = await import("../apps/app/src/real/windows-passkey.js");
  const { enrolDevice } = await import("../apps/app/src/identity/enrol-device.js");
  const { authenticator } = await import("../apps/app/src/identity/soft-authenticator.js");
  const { WORDS } = await import("../relay/client/words.js");
  const C = await import("../kernel/identity/chain.js");
  const { ident, made, hosted, ownerChain, linkFor } = await teamRig(t, { release: true });
  const auth = authenticator({ rp: "vyreapp.localhost" });
  const pc = await ident.anotherPasskey("winhello", auth, "vyreapp.localhost");
  assert.equal(auth.seen.creates, 1, "the claim made the passkey");
  const wp = await windowsPasskey({ origin: "https://vyreapp.localhost", key: pc.key, store: { get: async () => undefined, put: async () => {} }, webauthn: auth });
  assert.equal(auth.seen.creates, 1, "the same passkey is the presence key: none is made");
  assert.equal(wp.rp, "vyreapp.localhost");
  const rows = new Map();
  const deps = {
    who: { id: pc.id, name: "winhello", eid: pc.eid, sign: async m => pc.key.sign(m) },
    fetch: /** @type {any} */ (spacesHooks.fetch), base: "http://127.0.0.1:1", connect, openServerPeer, crypto: nodeCrypto(), words: WORDS,
    signPresence: req => wp.signer.signPresence(req), presenceKey: async () => wp.enrolment,
    store: { get: async k => rows.get(k), put: async (k, v) => { rows.set(k, v); } },
  };
  const inv = await linkFor(pc.id);
  const open = await openInvite(deps, inv.link);
  t.after(() => open.close());
  assert.equal((await open.accept()).joined, true);
  assert.equal((await hosted.gateway.grants.members.get(ownerChain, pc.id)).role, "member");
  const list = await callTeam(deps, made.space, "grants.members.list", []);
  assert.deepEqual((Array.isArray(list) ? list : list.members || []).map(m => m.person), [pc.id]);
  // its own name: a phone's key joins the list, the change signed by the passkey (not held, so the chain takes it)
  const phone = crypto.generateKeyPairSync("ed25519");
  const phoneKey = phone.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
  const done = await enrolDevice({ name: "winhello", eid: pc.eid, pin: pc.pin, base: "http://127.0.0.1:1", fetch: ident.fetch, now: () => ident.clock.t, sign: async m => pc.key.sign(m), entry: { publicKey: phoneKey, label: "Sam's phone" } });
  assert.equal(done.already, false);
  const res = await (await ident.fetch("http://127.0.0.1:1/v1/ids/resolve?name=winhello", { headers: {} })).json();
  const state = await C.verifyChain(res.data.ops, { now: ident.clock.t + C.SKEW_MS });
  assert.ok(state.entries.some(e => e.pub === phoneKey), "the phone is on the list");
  assert.equal(state.entries.find(e => e.eid === pc.eid).held, undefined, "the PC's entry is a full device, not held");
  assert.equal(res.data.ops.at(-1).by, pc.eid, "signed by the passkey");
});
