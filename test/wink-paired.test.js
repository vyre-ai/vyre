// @ts-check
// The second half of test/wink.test.js, split off because the file grew past the 300 s per-file limit (the first half is wink.test.js); the helpers are the same.
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
  const root = tempHome(t);
  if (opt.seam) { seams.set(root, { ...(seams.get(root) || {}), ...opt.seam }); t.after(() => seams.delete(root)); }
  if (opt.pendingMs || opt.abandonMs) { seams.set(root, { ...(opt.pendingMs ? { pendingMs: opt.pendingMs } : {}), ...(opt.abandonMs ? { abandonMs: opt.abandonMs } : {}) }); t.after(() => seams.delete(root)); }
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ ...(opt.realPresence ? {} : { presence: lenient }), root, log: m => { if (process.env.WLOG) console.error(m); }, coreKeys: macCore(), ...(opt.kernel ? { kernel: true } : {}) });
  t.after(() => d.stop());
  const events = [];
  d.events.on("*", e => events.push([e.type, e.payload]));
  const call = (tool, input = {}, caller = SCREEN, meta = A) => d.registry.call(tool, input, caller, meta);
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  return { d, url, root, events, call, status };
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
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
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











test("paired session ends, on the real kernel: removing the owner key that confirmed the pairing ends the session at once, and a key that confirmed nothing does not", async t => {
  const a = await pairedOnKernel(t, { confirmWithRealKey: true });
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const otherId = (await a.w.d.registry.call("presence.enroll", { kind: "device", name: "Spare", public_key: other.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 }, "cli", PROOF)).data.id;
  assert.equal((await a.w.d.registry.call("presence.remove", { id: otherId }, "cli", PROOF)).data.removed, otherId);
  assert.equal(await a.live(), true, "removing a key that confirmed nothing leaves the session alone");
  assert.equal((await a.w.d.registry.call("presence.remove", { id: a.ownerKey }, "cli", PROOF)).data.removed, a.ownerKey);
  assert.equal(await a.live(), false, "the session bound to the removed key is gone at once");
});

test("PS-4 and sessions scope, on the real kernel: a paired session lists only itself, a person's own surface lists every one", async t => {
  const a = await pairedOnKernel(t);
  const b = await pairedOnKernel(t, {}, a.w);
  const list = async (caller, meta) => { const x = (await a.w.d.registry.call("presence.person.sessions", {}, caller, meta)).data; return (x.sessions || x).map(y => y.id).sort(); };
  assert.deepEqual(await list("cli", PROOF), [a.sessionId, b.sessionId].sort(), "the owner's surface sees both");
  assert.deepEqual(await list("deck", { person: { id: a.sessionId } }), [a.sessionId], "a paired session sees only itself");
  assert.deepEqual(await list("deck", { person: { id: b.sessionId } }), [b.sessionId]);
});

test("a device with no box pairs a fresh server through pairServer: the claimed identity and its name become the owner, only after the right pick at the server", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  assert.deepEqual(parseServerPayload(made.qr)?.seed, parseServerQr(made.qr).seed, "the client's parser reads what the box prints");
  assert.equal(parseServerPayload("vyre://wink/2?t=AAAA"), null);
  const owner = { id: "per_" + "q".repeat(26), name: "Alex" };
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
  assert.match(q.name, /^Alex \(id q{6}\)$/, "the person at the server sees the claimed name and the start of its id");
  assert.equal((await w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false, "nobody owns the server before the yes");
  await until(async () => shown);
  assert.ok(q.choices.includes(shown), "the words the device shows are one of the server's three");
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF)).data.yes, true);
  const done = await pairing;
  assert.equal(done.paired, true);
  assert.deepEqual([done.owner.kind, done.owner.id], ["identity", owner.id]);
  const st = (await w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.owned, true);
  assert.equal(st.space, "Alex", "the owner is the claimed identity with its name, not a default space or You");
  assert.equal(st.device, "Alex's iPhone");
  // a second device scanning the used ticket is refused as taken
  await assert.rejects(pairServer({ payload: made.qr, owner, name: "Eve", crypto: nodeCrypto(), keyStore: keystore(t) }), e => e.code === "taken" || e.code === "unreachable");
});

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
  const ops = createIdentityOps({ store, dir: idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen }), seen, now: () => clock.t, emit() {}, stretch: { memoryKiB: 64, passes: 1 } });
  await ops.create({ name: "alex", password: "four plain words here", deviceLabel: "Alex's phone" });
  spacesHooks.fetch = /** @type {any} */ (fetchDir);
  spacesHooks.now = () => clock.t;
  t.after(async () => { spacesHooks.fetch = null; spacesHooks.now = null; await rt.settle(); });
  return { id: store.status().id, state, store, ops: () => store.ops(), clock,
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
  delete process.env.VYRE_WINK_TYPED_CODE;
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
const linksFor = (t, f) => {
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's iPhone", sign: f.sign,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  return links;
};

test("device-first, real daemon, relay and kernel: the pick leaves the device recorded, granted, enrolled and admitted: start-paired works, the server lists it with presence, and a call over the peer session answers the owner", async t => {
  const f = await pairFreshServer(t);
  const { w, done, owner } = f;
  // recorded as the owner's phone with its key, confirmed by the owner's pick
  const rec = (await w.d.registry.call("wink.device.record", { id: done.device }, "module:presence")).data;
  assert.deepEqual([rec.kind, rec.confirmed, rec.confirmedBy, rec.owner], ["phone", true, owner.id, owner.id]);
  assert.equal(rec.key.kty, "EC");
  assert.equal((await deviceRow(w, done.device)).presence, true, "the server lists the device with presence");
  assert.equal((await deviceRow(w, done.device)).storage, "hardware");
  assert.equal(w.d.kernel.id.owner, owner.id, "the claimed identity is the home's owner");
  const links = linksFor(t, f);
  // the device signs in: challenge, then start-paired with its own key
  const s = await links.startPaired("srv");
  assert.ok(s.id);
  const live = (await w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data;
  assert.ok((live.sessions || live).some(x => x.paired && x.id === s.id), "the server has the device's paired session");
  // the peer session carries a registry tool as this device, with the person its record says
  const session = links.sessionFor("srv");
  const me = await session.call("records.me", {});
  assert.ok(JSON.stringify(me).includes(owner.id), `records.me answers the owner: ${JSON.stringify(me).slice(0, 200)}`);
  // PD-2: the door reaches what a person's paired device may call and nothing else: tools that are for modules only are refused over the stream
  for (const tool of ["spaces.identity.state", "relay.device.info", "presence.person.end-paired", "wink.server.handover", "spaces.owner.adopt"]) {
    await assert.rejects(() => session.call(tool, { person: owner.id, id: done.device }), e => /denied|not_found|no_such_tool|not available|callers/i.test(`${e.code} ${e.message}`), `${tool} is refused over the peer door`);
  }
  // and a kernel call over the same session is the kernel's own remote path
  const rk = links.remoteKernel("srv", w.d.kernel.id.space);
  const members = await rk.gateway.grants.members.list(null);
  assert.ok(JSON.stringify(members).includes(owner.id), "grants.members.list over the remote kernel names the owner");
});

test("device-first attacks: a removed device holding a token and a stream is refused at its next call; a replayed start-paired is refused; a stranger never gets a stream", async t => {
  const f = await pairFreshServer(t);
  const { w, done } = f;
  const links = linksFor(t, f);
  const l = links.sessionFor("srv");
  await links.startPaired("srv");
  await l.call("records.me", {});
  // a replay of the start-paired the device just made is refused (the grant is one use)
  await assert.rejects(() => links.startPaired("srv"), e => e.code === "denied");
  // removing the device at the server ends its next call, session and all
  assert.equal((await w.call("wink.remove", { device: done.device }, SCREEN, A)).data.removed, done.device);
  await assert.rejects(() => l.call("records.me", {}), e => /denied|closed|removed|unreachable|paired/.test(`${e.code} ${e.message}`));
  await assert.rejects(() => links.remoteKernel("srv", w.d.kernel.id.space).gateway.grants.members.list(null), e => /denied|closed|removed|unreachable|paired|not_a_member/.test(`${e.code} ${e.message}`));
});

test("device-first: a web device is recorded as web with software storage", async t => {
  const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software" });
  const rec = (await f.w.d.registry.call("wink.device.record", { id: f.done.device }, "module:presence")).data;
  assert.equal(rec ? rec.kind : null, "web");
  assert.equal((await deviceRow(f.w, f.done.device)).storage, "software");
  // a browser that offered its key is granted its session like any owner device, and signs in with no manual step
  assert.equal(f.done.session, true, "the adopt answer says the browser has its session");
  const links = linksFor(t, f);
  assert.ok((await links.startPaired("srv")).id, "start-paired works for a browser that offered a device key");
  assert.ok(JSON.stringify(await links.sessionFor("srv").call("records.me", {})).includes(f.owner.id));
});

test("wink.server.adopt takes `proof` through the registry: a waiting redeemer's call with a proof is judged by the tool (denied, no identity port here), never refused as an unknown field", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const scan = parseServerQr(made.qr);
  const r = await redeem(t, w, scan.seed, "Alex's iPhone");
  const c = r.open();
  const owner = { kind: "identity", id: "per_" + "q".repeat(26), name: "Alex" };
  const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(Buffer.from(scan.seed).toString("base64url"));
  const res = await over(c, "wink.server.adopt", { owner, identity: owner.id, proof: { eid: "x".repeat(26), sig: "y".repeat(86) }, pairing: { commit, tag } });
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /does not take|not take|unknown (field|input)|not declared/i, text);
});

test("a box-less device pairs a fresh server, is recorded as the owner's device with its kind, and then start-paired succeeds with no second step", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  const ks = keystore(t);
  const owner = { id: "per_" + "q".repeat(26), name: "Alex" };
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks, presenceKey, deviceKind: "phone", keyStorage: "software", pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; });
  await until(async () => shown);
  assert.equal((await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF)).data.yes, true);
  const done = await pairing;
  // the server lists the device as the owner's phone, its key storage as reported
  const row = await until(() => deviceRow(w, done.device));
  assert.equal(row.presence, true);
  const listed = (await w.call("wink.access")).data.devices.find(d => d.id === done.device);
  assert.ok(listed, "recorded as a device of the owner");
  assert.equal((await w.call("wink.device.paired", { device: done.device, identity: owner.id }, "module:spaces")).data.paired, true);
  // and it opens its person session at once: challenge, sign, start-paired
  const c = connect({ relay: done.relay, route: done.route, box: done.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = await over(c, "presence.person.pair-challenge", {});
  assert.equal(ch.status, 200, JSON.stringify(ch));
  const sig = crypto.sign("sha256", Buffer.from(`paired-start\n${done.device}\n${ch.body.data.challenge}`), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const started = await over(c, "presence.person.start-paired", { sig });
  assert.equal(started.status, 200, JSON.stringify(started));
  // a session is a session and nothing more: a human-only act still wants its own fresh proof, whatever kind of device holds the session
  const label = `device:${done.device}`;
  const human = await w.d.registry.call("vault.reveal", { name: "northwind-mail" }, label, { person: { id: started.body.data.id } });
  assert.equal(human.error && human.error.code, "presence_required", `vault.reveal with a paired session and no fresh proof is stopped by the presence floor: ${JSON.stringify(human.error || human.data).slice(0, 120)}`);
  // the same device with a fresh presence proof passes the floor (the gate, not a missing tool: what it answers is the vault's own, no such item)
  const proved = await w.d.registry.call("vault.reveal", { name: "northwind-mail" }, label, { person: { id: started.body.data.id }, ...PROOF });
  assert.ok(!proved.error || !["presence_required", "denied", "person_session_required", "no_such_tool"].includes(proved.error.code), `with a fresh proof it gets past the floor: ${JSON.stringify(proved.error || proved.data).slice(0, 120)}`);
});

test("device-first, real daemon: the owner's device calls spaces.host-here on the server over the peer session; the server's kernel builds the chain from the peer and decides", async t => {
  const f = await pairFreshServer(t);
  const w = f.w;
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  // with no proof the server asks for one (the presence floor is the server's own, nothing here is trusted)
  await assert.rejects(() => session.call("spaces.host-here", { name: "harlow" }), e => e.code === "presence_required");
  // with the owner's proof in the input (the test world's presence takes any), the server's kernel hosts the space and answers its id
  const made = await session.call("spaces.host-here", { name: "harlow", proof: { key: "k1" } });
  assert.match(made.space, /^spc_[a-z2-7]{12}$/);
  assert.ok(w.d.kernel.spaces.hosts(made.space), "the space is hosted by the SERVER's kernel");
});

test("guard: a daemon with the kernel mounts the relay peer door (a merge once dropped the line and every peer stream was refused)", async t => {
  const w = await world(t, { kernel: true });
  const door = /** @type {any} */ (w.d.registry.deps).peerDoor && /** @type {any} */ (w.d.registry.deps).peerDoor();
  assert.ok(door && door.space === "home" && typeof door.accept === "function" && typeof door.allow === "function", "registry.deps.peerDoor() answers the door");
  assert.equal(door.allow("abcdefghijklmnop"), true);
  assert.equal(door.allow("../etc"), false);
});

test("pairServer maps a refused owner to bad_owner, not a network error, and nothing is owned", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  await assert.rejects(pairServer({ payload: made.qr, owner: { id: "per_a", name: "Alex" }, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t) }), e => e.code === "bad_owner");
  assert.equal((await w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false);
});

test("a pairing whose app closed before the yes does not leave the server busy: the ask is dropped and the next scanner is asked", async t => {
  const w = await world(t, { abandonMs: 150 });
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const first = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const owner = { kind: "identity", id: "per_" + "q".repeat(26), name: "Alex" };
  // the first app redeems, commits, hears the server's nonce, and is still connected
  const scan = parseServerQr(first.qr);
  const r = await redeem(t, w, scan.seed, "Alex's browser");
  const c = r.open();
  const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(Buffer.from(scan.seed).toString("base64url"));
  assert.equal((await over(c, "wink.server.adopt", { owner, identity: owner.id, pairing: { commit, tag } })).status, 200);
  // while it is still there a second scanner is told busy (no clock involved: the first channel is open)
  const early = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  await assert.rejects(pairServer({ payload: early.qr, owner, name: "Eve", crypto: nodeCrypto(), keyStore: keystore(t) }), e => e.code === "busy");
  // the app goes away; wait for the relay's own event that it did not come back, not for a sleep
  c.close();
  await until(async () => w.events.some(([type]) => type === "pairing.abandoned"), 20_000);
  const second = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const pairing = pairServer({ payload: second.qr, owner, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 100, onWords: () => {} });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; }, 20_000);
  assert.ok(q.asking, "the second scanner is asked once the abandoned one is gone");
  await w.call("wink.server.pair.answer", { yes: false }, "cli", PROOF);
  await pairing.catch(() => null);
});

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
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
  const pairing = pairServer({ payload: code.qr, owner, deviceKind: "phone", presenceKey, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 100, ...(sign ? { signIdentity: sign } : {}), onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; }, 3000).catch(() => null);
  if (q && answer) { await until(async () => shown); await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF); }
  return { w, asked: Boolean(q), result: await pairing.then(r => ({ ok: r }), e => ({ err: e })) };
}

test("owning a server needs the identity proof checked against the directory: the right proof owns and the device has its session; no proof, another identity's, and an unreachable directory each refuse in their own words and own nothing", async t => {
  const ident = await standinIdentity(t);
  const ok = await attemptPairing(t, ident);
  assert.equal(ok.result.ok && ok.result.ok.paired, true, String(ok.result.err && ok.result.err.message));
  assert.equal(ok.result.ok.session, true, "the adopt answer says the device has its session");
  assert.equal(ok.w.d.kernel.id.owner, ident.id, "the proven identity is the home's owner");
  assert.equal((await ok.w.call("wink.server.status", {}, "cli", PROOF)).data.owner_proof, "software", "a development build takes a software key and says so");
  // no proof at all: refused, and a server installed with no pair-to is not waiting for anyone
  const none = await attemptPairing(t, ident, { sign: null });
  assert.equal(none.result.err && none.result.err.code, "denied_no_proof");
  assert.match(String(none.result.err && none.result.err.message), /did not prove which Vyre identity/);
  assert.doesNotMatch(String(none.result.err && none.result.err.message), /waiting to pair/);
  assert.equal((await none.w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false);
  // another identity's key on the claimed identity's name: not them
  const rogue = crypto.generateKeyPairSync("ed25519");
  const bad = await attemptPairing(t, ident, { sign: async m => ({ eid: "e".repeat(26), sig: crypto.sign(null, Buffer.from(m), rogue.privateKey).toString("base64url") }) });
  assert.equal(bad.result.err && bad.result.err.code, "denied_wrong_proof");
  assert.match(String(bad.result.err && bad.result.err.message), /did not prove it/);
  assert.equal((await bad.w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false);
  // the directory out of reach: said plainly, nothing paired
  ident.state.down = true;
  const away = await attemptPairing(t, ident);
  assert.match(String(away.result.err && away.result.err.message), /cannot check who is asking right now/);
  assert.equal((await away.w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false);
  ident.state.down = false;
});

test("an owned server: a second device with no owner presence is granted nothing, and pair.answer from a paired device is refused", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  // the owner's own paired device may not answer the server's question: only the box's own CLI can
  const asDevice = await f.w.d.registry.call("wink.server.pair.answer", { yes: true, pick: 1 }, `device:${f.done.device}`, {});
  assert.ok(asDevice.error, "a paired device cannot answer the pairing question");
  // a second device scanning an owned server's code reaches nothing
  const second = await f.w.d.registry.call("wink.server.adopt", { owner: { kind: "identity", id: f.owner.id }, identity: f.owner.id, deviceKind: "phone" }, "device:zzzzzzzzzzzzzzzz", {});
  assert.ok(second.error, "an owned server takes no second adoption without the owner's presence");
  assert.equal((await f.w.d.registry.call("wink.device.record", { id: "zzzzzzzzzzzzzzzz" }, "module:presence")).data, null);
});

test("sessionFor signs the device in by itself when a call needs the person (no manual start-paired); a lapsed session is renewed with the device's own key; a removed device is refused", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  const session = links.sessionFor("srv");
  assert.ok(JSON.stringify(await session.call("records.me", {})).includes(f.owner.id), "the first call needed the person: the device signed in and the call went through");
  // RENEWED, not re-paired (lead, 4 Oct): the server ends the device's session (it lapsed); the device still holds its key and signs in again by itself
  assert.ok((await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink")).data.ended >= 1);
  assert.ok(JSON.stringify(await session.call("records.me", {})).includes(f.owner.id), "the lapsed session is renewed with the device's key, no owner step");
  // a removed device has no key on its record: there is nothing to renew, and re-pairing is for it alone
  assert.equal((await f.w.call("wink.remove", { device: f.done.device }, SCREEN, A)).data.removed, f.done.device);
  await assert.rejects(() => session.call("records.me", {}), e => /denied|closed|removed|unreachable|sign in|paired/i.test(`${e.code} ${e.message}`));
});


test("a computer's own device key makes the owner's proof for an act that needs presence over the peer wire: REAL presence on the server checks the key it enrolled at pairing", async t => {
  // the server takes a software key as presence only on a development build behind this switch; this test sets it itself (and puts it back) so it does not depend on the shell or on test order
  const softSaved = process.env.VYRE_SEAL_SOFTWARE;
  process.env.VYRE_SEAL_SOFTWARE = "1";
  t.after(() => { if (softSaved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = softSaved; });
  const devKey = deviceKey(path.join(tempHome(t), "dev.json"));
  const f = await pairFreshServer(t, { kind: "computer", presenceStorage: "software", devKey, realPresence: true });
  assert.equal(f.done.session, true, "a first pairing on a real presence module still grants the session");
  assert.equal((await deviceRow(f.w, f.done.device)).presence, true, "the server enrolled the computer's key as its presence key");
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's Mac", sign: m => devKey.sign(m), proveTool: devKey.proveTool, autoPresence: true,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  const made = await links.sessionFor("srv").call("spaces.host-here", { name: "harlow" });
  assert.match(made.space, /^spc_[a-z2-7]{12}$/, "host-here answered after the device signed the server's presence_required");
  assert.ok(f.w.d.kernel.spaces.hosts(made.space), "the space is hosted by the server's kernel");
  // PW-1: with the dev switch off (a computer's own software key), nothing signs a presence challenge by itself
  const quiet = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "q", sign: m => devKey.sign(m), proveTool: devKey.proveTool,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => quiet.close());
  await assert.rejects(() => quiet.sessionFor("srv").call("spaces.host-here", { name: "nope" }), e => e.code === "presence_required");
  // a key the server never enrolled proves nothing
  const stranger = deviceKey(path.join(tempHome(t), "stranger.json"));
  const bad = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "x", sign: m => devKey.sign(m), proveTool: stranger.proveTool, autoPresence: true,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => bad.close());
  await assert.rejects(() => bad.sessionFor("srv").call("spaces.host-here", { name: "other" }), e => e.code === "presence_required");
});


test("renewal lock: three wrong sign-in answers lock the device for fifteen minutes; only the owner's own device lifts it", async t => {
  const f = await pairFreshServer(t);
  const id = f.done.device, as = `device:${id}`, peer = { peer: { kind: "device", stableId: id, node: id } };
  const call = (tool, input) => f.w.d.registry.call(tool, input, as, peer);
  // the pairing's own grant is still unused: three wrong answers delete it and lock the device
  for (let i = 0; i < 3; i++) { const ch = (await call("presence.person.pair-challenge", {})).data.challenge; assert.ok(ch); await call("presence.person.start-paired", { sig: "AAAA" }); }
  const ch1 = (await call("presence.person.pair-challenge", {})).data.challenge;
  const started = await call("presence.person.start-paired", { sig: f.sign(`paired-start\n${id}\n${ch1}`) });
  assert.ok(started.error, "locked: a right answer to a random challenge is no session");
  // the owner lifts it from their own device (with their presence)
  assert.equal((await f.w.d.registry.call("presence.person.renew-allow", { device: id }, "cli", PROOF)).data.allowed, id);
  const ch2 = (await call("presence.person.pair-challenge", {})).data.challenge;
  const ok = await call("presence.person.start-paired", { sig: f.sign(`paired-start\n${id}\n${ch2}`) });
  assert.ok(ok.data && ok.data.token, "after the owner lifted the lock the device renews with its key");
});

test("SERVER-HOSTED SPACE end to end: a device daemon with a spaces module asks the paired server over the peer session; the SERVER's kernel hosts the space, the device keeps only a row and reaches it through the remote kernel", async t => {
  const f = await pairFreshServer(t);
  const server = f.w.d;
  const links = linksFor(t, f);
  await links.startPaired("srv");
  // the DEVICE: its own vyred with the spaces module, an identity, and the open peer session to the server as its way out
  const names = await (async () => { const { spawn } = await import("node:child_process"); const port = 33000 + Math.floor(Math.random() * 2000); const child = spawn(process.execPath, [path.resolve("scripts/standin-directory.mjs"), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] }); t.after(() => { child.kill("SIGTERM"); }); await new Promise(res => child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); })); return port; })();
  const droot = tempHome(t);
  fs.writeFileSync(path.join(droot, "config.json"), JSON.stringify({ name: "device-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${names}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  let silent = false; // a server that stops answering (down, rebuilt)
  // the names directory the device's spaces module talks to can be made unreachable for one attempt (read when the module starts)
  const { hooks: dirHooks } = await import("../core/spaces/index.js");
  let dirDown = false;
  const innerFetch = dirHooks.fetch || globalThis.fetch; // whatever directory the earlier tests left wired (in-memory or real)
  dirHooks.fetch = (/** @type {any} */ u, /** @type {any} */ o) => (dirDown ? Promise.reject(new Error("the directory is down")) : innerFetch(u, o));
  t.after(() => { dirHooks.fetch = /** @type {any} */ (innerFetch === globalThis.fetch ? null : innerFetch); });
  const device = await start({ root: droot, kernel: true, presence: lenient, sessionFor: async () => (silent ? { call: () => new Promise(() => {}) } : links.sessionFor("srv")), log: () => {} });
  const { hooks: spacesHooks } = await import("../core/spaces/index.js");
  spacesHooks.sessionFor = async () => links.sessionFor("srv");
  t.after(() => { spacesHooks.sessionFor = null; });
  t.after(() => device.stop());
  const dcall = (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {any} */ headers = {}) => import("../core/daemon/client.js").then(m => m.call(tool, input, { root: droot, caller: "cli", headers }));
  const proofHeader = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ key: "k1" })).toString("base64url"), "x-vyre-presence": "passkey id=x" };
  const meR = await dcall("spaces.identity.create", { name: "devalex" }); const me = meR.data;
  assert.ok(me && me.id, JSON.stringify(meR).slice(0, 300));
  // the device knows the server as its paired server (its own record of it)
  device.registry.deps.db.prepare("INSERT INTO wink_devices (id, identity, kind, name, owner_kind, owner_id, created) VALUES (?, ?, 'server', 'srv', 'identity', ?, 1)").run("srv", me.id, me.id);
  const made = await dcall("spaces.create", { name: "harlowsrv", displayName: "Harlow Legal", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.equal(made.data.status, "done", JSON.stringify(made.data));
  const id = made.data.space;
  assert.equal(server.kernel.spaces.hosts(id), true, "the SERVER's kernel hosts it");
  assert.equal(device.kernel.spaces.hosts(id), false, "the device hosts nothing for it");
  assert.ok(fs.existsSync(path.join(server.paths.root, "kernel", "spaces", id, "space.json")), "its files are on the server");
  assert.ok(!fs.existsSync(path.join(droot, "kernel", "spaces", id)), "and not on the device");
  assert.ok((await dcall("spaces.list")).data.some((/** @type {any} */ x) => x.id === id && x.hostedHere === undefined));
  // the device reaches it through the kernel's remote client over the same peer session: members, then a type and a record
  const rk = device.kernel.spaces.for(id);
  assert.equal(rk.hosted, false);
  const owners = await rk.gateway.grants.members.list(null);
  assert.ok(Array.isArray(owners) && owners.length === 1 && owners[0].role === "owner", JSON.stringify(owners));
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  // changing the types is an admin act with the person's presence at the SERVER: defined there (the development stand-in), and the device then writes a record through the remote kernel.
  // (Defining over the wire needs the paired session's presence to count at the server: wink-2's open question, see CHAT.)
  fs.writeFileSync(path.join(server.paths.root, "dev-presence-stand-in"), "");
  const sOwner = server.kernel.spaces.hosted(id);
  await sOwner.gateway.records.define(sOwner.kernel.chains.fromFacts({ kind: "device", device_key_id: "x0", person: server.kernel.id.owner, path: "direct", session: "s" }), { add_types: [CONTACT] }, { presence: { method: "stand-in" } });
  const rec = await rk.gateway.records.create(null, "contact", { name: "Jane", age: 40 });
  assert.equal(rec.data.name, "Jane");
  const rows = await rk.gateway.records.query(null, "contact", { page: { limit: 50 } });
  assert.ok(JSON.stringify(rows).includes("Jane"));
  // the device's own records tools reach the server-hosted space through the same remote kernel (lib/gateway-door), and refuse a caller that is not a signed-in person
  const viaTool = await dcall("records.list", { space: id, type: "contact" });
  assert.ok(!viaTool.error, JSON.stringify(viaTool.error));
  assert.ok(JSON.stringify(viaTool.data).includes("Jane"), "records.list on the device reads the record that lives on the server");
  // the type list reads through the remote kernel too (the remote gateway has `definitions`), and a change of types from the device needs the person's proof: without it the home refuses, with it carried over the door it applies
  const typesVia = await dcall("records.types", { space: id });
  assert.ok(!typesVia.error && JSON.stringify(typesVia.data).includes("contact"), JSON.stringify(typesVia).slice(0, 200));
  assert.equal(typesVia.data.acted_in.id, id);
  const NOTE = { name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] };
  const standInFile = path.join(server.paths.root, "dev-presence-stand-in");
  fs.rmSync(standInFile); // the development stand-in off: only a real proof counts at the home
  const noProof = await dcall("records.define", { space: id, diff: { add_types: [NOTE] } });
  assert.equal(noProof.error && noProof.error.code, "needs_presence", "a change of types with no proof is refused by the home");
  fs.writeFileSync(standInFile, "");
  const withProofHdr = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") };
  const defined = await dcall("records.define", { space: id, diff: { add_types: [NOTE] } }, withProofHdr);
  assert.ok(!defined.error, JSON.stringify(defined).slice(0, 300));
  assert.ok(JSON.stringify((await dcall("records.types", { space: id })).data).includes("note"), "the type the device defined is on the server");
  const stranger = await import("../core/daemon/client.js").then(m => m.call("records.list", { space: id, type: "contact" }, { root: droot, caller: "tailnet-guest:mallory@example.com" }));
  assert.ok(stranger.error, "a caller that is not the signed-in person is refused");
  // and the record is on the SERVER, not on the device
  const onServer = server.kernel.spaces.hosted(id);
  assert.ok(JSON.stringify(await onServer.gateway.records.query(onServer.kernel.chains.fromFacts({ kind: "device", device_key_id: "x1", person: server.kernel.id.owner, path: "direct", session: "s" }), "contact", { page: { limit: 50 } })).includes("Jane"), "the record lives in the server's store");
  // a person who named a server that is not paired to them never gets a local space instead: the create refuses and makes nothing
  const listed = (await dcall("spaces.list")).data.length;
  const unpaired = await dcall("spaces.create", { name: "nolocal", home: { kind: "server", device: { id: "srv_notpaired0001", name: "someone else's", alwaysOn: true }, confirmed: true } }, proofHeader);
  assert.equal(unpaired.error && unpaired.error.code, "server_not_paired", JSON.stringify(unpaired).slice(0, 200));
  assert.equal((await dcall("spaces.list")).data.length, listed, "nothing was made on this computer");
  // a paired server that cannot be reached: the same refusal with a plain reason, nothing made here
  { const keep = spacesHooks.sessionFor; spacesHooks.sessionFor = async () => { throw new Error("down"); };
    const down = await dcall("spaces.create", { name: "nolocal2", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
    spacesHooks.sessionFor = keep;
    assert.equal(down.error && down.error.code, "server_unreachable", JSON.stringify(down).slice(0, 200));
    assert.equal((await dcall("spaces.list")).data.length, listed, "nothing was made on this computer when the server was down"); }
  // a server that stops answering must not hold up the lists and the pairing that ask who belongs where: the read gives up and the creator is still the owner
  silent = true;
  spacesHooks.remoteMs = 400;
  t.after(() => { spacesHooks.remoteMs = null; });
  const t0 = Date.now();
  const adm = await device.registry.call("spaces.admin-list", { person: me.id }, "module:wink");
  assert.ok(!adm.error, JSON.stringify(adm.error));
  assert.ok(Date.now() - t0 < 8000, `admin-list answered in ${Date.now() - t0} ms with the server silent`);
  assert.ok(adm.data.spaces.some((/** @type {any} */ x) => x.space === id && x.role === "owner"), "the space this device made stays listed as its own");
  silent = false;
  // a create that fails after the server hosted the space gives it back ON THE SERVER (the name is taken, so the claim step refuses): the server hosts no extra space and the device lists none
  const before = server.kernel.spaces.list().length;
  const dup = await dcall("spaces.create", { name: "harlowsrv", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
  assert.ok(dup.error || (dup.data && dup.data.status !== "done"), `the second create of the same name does not finish: ${JSON.stringify(dup).slice(0, 160)}`);
  assert.equal(server.kernel.spaces.list().length, before, "the failed create was retired on the server");
  assert.equal((await dcall("spaces.list")).data.filter((/** @type {any} */ x) => x.name === "harlowsrv.vyre.run").length, 1, "the device lists the one space");
  // a create that is refused part way retires what the server started and frees the name; the same person asking again for it resumes the pending attempt and finishes
  const base = server.kernel.spaces.list().length;
  dirDown = true;
  const refused = await dcall("spaces.create", { name: "retryname", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
  dirDown = false;
  assert.ok(refused.error || (refused.data && refused.data.status !== "done"), `the attempt with the directory down does not finish: ${JSON.stringify(refused).slice(0, 200)}`);
  assert.equal(server.kernel.spaces.list().length, base, "what the server started was given back, so the name is free there");
  const retried = await dcall("spaces.create", { name: "retryname", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
  assert.ok(!retried.error && retried.data.status === "done", `the retry finishes: ${JSON.stringify(retried).slice(0, 300)}`);
  assert.equal(server.kernel.spaces.list().length, base + 1, "the server hosts the one space");
  assert.equal((await dcall("spaces.list")).data.filter((/** @type {any} */ x) => x.name === "retryname.vyre.run").length, 1, "the device lists one space for the name, not two");
});

test("the pairing path adopts for real: after the pick the SERVER's home owner is the identity its own pairing record names (spaces.owner.adopt from module:wink); another identity, an added module and a second adoption change nothing", async t => {
  const f = await pairFreshServer(t);
  const { w, owner } = f;
  const reg = w.d.registry;
  assert.equal(w.d.kernel.id.owner, owner.id, "the pairing made the claimed identity the home's owner");
  // the record the adoption was checked against is the pairing's own
  const rec = (await reg.call("wink.server.owner", {}, "module:spaces")).data;
  assert.equal(rec && rec.identity, owner.id, "wink.server.owner names the identity of the pairing");
  const stranger = "per_" + "z".repeat(26);
  assert.equal((await reg.call("spaces.owner.adopt", { person: stranger }, "module:wink")).error?.code, "forbidden", "an identity the pairing does not name is refused even from the Wink module");
  assert.ok((await reg.call("spaces.owner.adopt", { person: stranger }, "module:evil")).error, "an added module is refused");
  assert.ok((await reg.call("wink.server.owner", {}, "module:evil")).error, "and cannot read the pairing's record either");
  const again = await reg.call("spaces.owner.adopt", { person: owner.id }, "module:wink");
  assert.ok(!again.error && again.data.changed === false, `adopting the same identity again changes nothing: ${JSON.stringify(again)}`);
  assert.equal(w.d.kernel.id.owner, owner.id, "still the identity");
});

test("an invitee's session opens the stream with the signed hello in its head and only for that route; a new hello replaces the old link", async t => {
  const heads = [], closed = [];
  const connect = o => ({ ready: async () => ({ open: head => { heads.push({ route: o.route, invitee: o.invitee === true, head }); return { reset() {}, set onhead(f) { f({ status: 403 }); } }; } }), close: () => closed.push(o.route), reply: {} });
  const links = createServerLinks({ connect, options: {}, name: "Kit's phone", channelOf: () => null });
  t.after(() => links.close());
  const ch = { relay: "https://relay.example", route: "rt-harlow", box: "bx-harlow" };
  const hello = { space: "spc_aaaaaaaaaaaa", invite: "inv_" + "a".repeat(32), identity: "per_kit", entry: "e1", ts: 1, nonce: "n1", sig: "s1" };
  await assert.rejects(() => links.inviteeSessionFor(ch, hello).call("grants.invites.get", {}), e => e.code === "denied");
  assert.deepEqual(heads[0], { route: "rt-harlow", invitee: true, head: { peer: "wink", space: "home", invitee: hello } }, "the channel hello says invitee (the relay client sends { v: 1, invitee: true })");
  // a second hello for the same invite is the one the next stream opens with
  await assert.rejects(() => links.inviteeSessionFor(ch, { ...hello, nonce: "n2", sig: "s2" }).call("grants.invites.get", {}), e => e.code === "denied");
  assert.equal(heads[1].head.invitee.nonce, "n2");
  assert.deepEqual(closed, []);
  // IV-4: the channel is a throwaway key of its own, said to be an invitee's, and a hello made by a function is asked for with that key's id and made again for every stream
  const keys = [], opts = [];
  const connect2 = o => { opts.push(o); return { ready: async () => ({ open: head => { heads.push({ route: o.route, head }); return { reset() {}, set onhead(f) { f({ status: 403 }); } }; } }), close() {}, reply: {} }; };
  const links2 = createServerLinks({ connect: connect2, options: { keyStore: { get: async () => { throw new Error("the device's own key is never used for an invitee"); } } }, name: "Kit's phone", channelOf: () => null });
  t.after(() => links2.close());
  let asked = 0;
  const helloFor = id => { keys.push(id); return { ...hello, channel: id, nonce: `m${++asked}` }; };
  const n0 = heads.length;
  await assert.rejects(() => links2.inviteeSessionFor(ch, helloFor, { invite: hello.invite }).call("grants.invites.get", {}), e => e.code === "denied");
  await assert.rejects(() => links2.inviteeSessionFor(ch, helloFor, { invite: hello.invite }).call("grants.invites.get", {}), e => e.code === "denied");
  assert.equal(opts[0].invitee, true, "the channel says in its hello that it is an invitee's");
  const pub = (await opts[0].keyStore.get()).publicKey;
  const { createHash } = await import("node:crypto");
  const { base32 } = await import("../relay/client/bytes.js");
  assert.equal(keys[0], base32(createHash("sha256").update(Buffer.from(pub)).digest()).slice(0, 16), "the hello is asked for with the id the box will see for the channel");
  assert.equal(opts.length, 1, "one channel for the invite");
  assert.deepEqual(heads.slice(n0).map(h => h.head.invitee.nonce), ["m1", "m2"], "each stream is opened with a hello made at that moment");
  // no route, or no signed hello: nothing is opened
  assert.throws(() => links.inviteeSessionFor(null, hello), e => e.code === "bad_input");
  assert.throws(() => links.inviteeSessionFor(ch, {}), e => e.code === "bad_input");
  // a paired-server id never reaches an invitee link
  assert.throws(() => links.sessionFor("srv"), e => e.code === "not_found");
});

test("a box-less client makes its first space on a paired server: the server hosts it, the device signs the space's chain and record, and the directory resolves it with the home's route", async t => {
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
  await assert.rejects(() => claimServerSpace({ identity, name: "nopeproof", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (spacesHooks.fetch), now: () => f.ident.clock.t, host: a => session.call("spaces.host-here", a) }), e => e.code === "presence_required");
  assert.equal((await dir.check("nopeproof")).status, "ok");
});

test("host-here on a server too small for the larger store asks for the owner's word, in the kernel's words, and hosts only when asked again with it", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  const sp = f.w.d.kernel.spaces;
  spacesHooks.storePlan = async () => ({ store: "sqlite", confirm: { text: "This server is small: the space will use the built-in store.", choices: ["create", "cancel"] } });
  t.after(() => { spacesHooks.storePlan = null; });
  const before = sp.list().length;
  await assert.rejects(() => session.call("spaces.host-here", { name: "smallroom", proof: { key: "k1" } }), e => e.code === "needs_store_confirmation" && /built-in store/.test(e.message));
  assert.equal(sp.list().length, before, "nothing was hosted before the owner agreed");
  const made = await session.call("spaces.host-here", { name: "smallroom", acceptBuiltinStore: true, proof: { key: "k2" } });
  assert.match(made.space, /^spc_[a-z2-7]{12}$/);
  assert.ok(sp.hosts(made.space));
});

test("the invitee door, real daemon and relay: a stranger's channel with the invitee hello makes no device and has one door; everything else is refused, and a bad hello gets a stream that refuses every call", async t => {
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

test("a key that is a waiting or paired device here is not admitted as an invitee", async t => {
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

test("a software device key's presence proof is refused by the server without the dev switch, whatever the client signs: \"approve this in Vyre on your phone\"", async t => {
  const savedSw = process.env.VYRE_SEAL_SOFTWARE;
  delete process.env.VYRE_SEAL_SOFTWARE;
  t.after(() => { if (savedSw !== undefined) process.env.VYRE_SEAL_SOFTWARE = savedSw; });
  const devKey = deviceKey(path.join(tempHome(t), "dev.json"));
  const f = await pairFreshServer(t, { kind: "computer", presenceStorage: "software", devKey, realPresence: true });
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's Mac", sign: m => devKey.sign(m), proveTool: devKey.proveTool, autoPresence: true,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  await assert.rejects(() => links.sessionFor("srv").call("spaces.host-here", { name: "harlow" }), e => /software|phone/i.test(e.message));
});


test("a paired device opens a chat's stream over the peer wire: frames for its person in order, a message by call, a dropped peer stream resumes from the last frame, an ended session gets nothing more", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const k = f.w.d.kernel;
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const chat = await k.gateway.grants.chats.create(oc, { people: [] });
  const mkPeer = async () => openServerPeer(connect({ relay: f.w.status.url, route: f.done.route, box: f.done.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: f.ks }));
  let peer = await mkPeer();
  const frames = [], ended = [];
  const open = async from => peer.openStream("stream.open-peer", { session: chat.id, ...(from ? { from } : {}) }, { onframe: d => frames.push(d), onend: w => ended.push(w) });
  const s = await open();
  assert.match(s.id, /^st_/);
  // a message by call on the same wire (the person is this device's own, from the server's chain)
  await peer.call("stream.send", { session: chat.id, text: "hello from the phone" });
  await until(async () => frames.some(d => JSON.stringify(d).includes("hello from the phone")), 8000);
  const seen = frames.length;
  // another viewer's session id is refused: a thread this person is not in gives no stream
  await assert.rejects(() => peer.call("stream.open-peer", { session: "t_not_mine_at_all" }), e => /not_found|no such session/i.test(`${e.code} ${e.message}`));
  // the peer stream drops: the app is told, reopens and resumes from the last cursor it saw
  const cursor = Math.max(0, ...frames.map(d => Number(d && (d.cursor ?? d.seq ?? d.n)) || 0));
  peer.close();
  await new Promise(r => setTimeout(r, 100));
  assert.ok(ended.includes("closed"), "the dropped peer stream ended the stream on the device");
  peer = await mkPeer();
  const again = [];
  await peer.openStream("stream.open-peer", { session: chat.id, from: cursor }, { onframe: d => again.push(d), onend: () => {} });
  await peer.call("stream.send", { session: chat.id, text: "after the resume" });
  await until(async () => again.some(d => JSON.stringify(d).includes("after the resume")), 8000);
  assert.ok(seen > 0);
  // the paired session ends: nothing more is sent
  const before = again.length;
  await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink");
  await new Promise(r => setTimeout(r, 800));
  await peer.call("stream.send", { session: chat.id, text: "too late" }).catch(() => null);
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!again.slice(before).some(d => JSON.stringify(d).includes("too late")), "no frame after the session ended");
  peer.close();
});


test("PS-A, real daemon: a web device with a software session may open a chat's stream, but a call that needs presence is refused over the same wire", async t => {
  const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software", realPresence: true });
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const k = f.w.d.kernel;
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const chat = await k.gateway.grants.chats.create(oc, { people: [] });
  const peer = await openServerPeer(connect({ relay: f.w.status.url, route: f.done.route, box: f.done.box, name: "Alex's browser", crypto: nodeCrypto(), keyStore: f.ks }));
  t.after(() => peer.close());
  const frames = [];
  const s = await peer.openStream("stream.open-peer", { session: chat.id }, { onframe: d => frames.push(d), onend: () => {} });
  assert.match(s.id, /^st_/, "a software-strength session opens a chat's stream");
  await peer.call("stream.send", { session: chat.id, text: "from the browser" });
  await until(async () => frames.some(d => JSON.stringify(d).includes("from the browser")), 8000);
  // a call that needs the person's presence: no proof, and a made-up one, are both refused (the session alone never counts)
  const code = e => String(e && e.code);
  await assert.rejects(() => peer.call("vault.reveal", { name: "northwind-mail" }), e => /presence_required|presence|denied/.test(code(e)), "no proof: refused");
  await assert.rejects(() => peer.call("vault.reveal", { name: "northwind-mail", proof: { method: "passkey", id: "made-up" } }), e => /presence|denied|bad_proof|invalid/.test(`${code(e)} ${e.message}`), "a made-up proof: refused");
});

test("PS-A, real daemon: the ninth stream.open-peer on one device is refused, and closing one makes room", async t => {
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const k = f.w.d.kernel;
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const chat = await k.gateway.grants.chats.create(oc, { people: [] });
  const peer = await openServerPeer(connect({ relay: f.w.status.url, route: f.done.route, box: f.done.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: f.ks }));
  t.after(() => peer.close());
  const opened = [];
  for (let i = 0; i < 8; i++) opened.push(await peer.openStream("stream.open-peer", { session: chat.id }, { onframe: () => {}, onend: () => {} }));
  await assert.rejects(() => peer.openStream("stream.open-peer", { session: chat.id }, { onframe: () => {}, onend: () => {} }), e => /rate_limited|too many/.test(`${e.code} ${e.message}`), "the ninth is refused");
  opened[0].close();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(await peer.openStream("stream.open-peer", { session: chat.id }, { onframe: () => {}, onend: () => {} }), "closing one makes room");
});

test("renewal lock survives a restart: three wrong answers, the daemon restarts on the same home, and the device is still locked: no fresh tries, until the owner lifts it", async t => {
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

test("the three-strikes count is in the store too: two wrong answers, a restart, one wrong answer, and the device is locked", async t => {
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
test("add this device from another device, real daemon: a box-less device redeems the code, the words match, the person says yes, and the identity's list takes the device's key", async t => {
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

test("add this device from another device: a no, a wrong pick, a used code and a server's code each add nothing", async t => {
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
test("a recovered phone's key, on the identity's list but never paired here, is not admitted: no device channel, no peer stream, no session; its way in is a pairing (the owner's yes, or its identity proof on a pair-to server)", async t => {
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

test("an invitee link pointed at a box whose key is not the record's route.box sends no hello and answers with a plain refusal", async t => {
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
test("after the adopter lets a server go, its device is dropped at the relay: the relay refuses the old key and the peer door has no row for it", async t => {
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
test("invitee channels: 40 strangers holding channels never take the slots the owner's paired phone needs, and an idle invitee channel is closed", async t => {
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
test("a home that already has a claimed owner is not paired by a different identity: refused before the ask, nothing recorded, no session, the kernel owner unchanged", async t => {
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
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
  const ks = keystore(t);
  const pairing = pairServer({ payload: code.qr, owner: { id: ident.id, name: "Carol", vyre: "alex" }, deviceKind: "phone", presenceKey, name: "Carol's iPhone", crypto: nodeCrypto(), keyStore: ks, pollMs: 100, signIdentity: ident.sign, onWords: () => {} });
  await assert.rejects(() => pairing, e => e.code === "owned_by_other" && /already belongs to another/.test(e.message), "refused with its own words");
  assert.equal(((await w.call("wink.server.pairing", {}, "cli", PROOF)).data || {}).asking || false, false, "the person at the server is never asked");
  const st = (await w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.owned, false, "the pairing record names no owner");
  assert.equal(w.d.kernel.id.owner, ownerAfterClaim, "the kernel owner is unchanged");
  await noOwnerDevices(w);
});

test("a kernel that refuses the owner fails the pairing: the owner record is taken back, the device has no row and no session", async t => {
  const ident = await standinIdentity(t);
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const noProof = process.env.VYRE_TEST_PAIR_NO_PROOF; delete process.env.VYRE_TEST_PAIR_NO_PROOF;
  const saved = process.env.VYRE_WINK_TYPED_CODE; delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (noProof !== undefined) process.env.VYRE_TEST_PAIR_NO_PROOF = noProof; if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const w = await world(t, { kernel: true });
  // the kernel adopts another identity between the early check and the pick (a claim at the server's own screen while the pairing waits)
  const code = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "hardware" };
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
  assert.equal((await w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false, "the owner record was taken back");
  assert.equal(w.d.kernel.id.owner, ownerAfterClaim);
  await noOwnerDevices(w);
});

test("a device is the owner's person only as the person its row names: a row naming another person, or nobody, gets no person facts", () => {
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

test("the owner's second device (a computer after a phone) pairs: the same identity, its proof checked, the person at the server picks the words, and the owner does not change", async t => {
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

test("FO-1: adopt never changes the owner of an owned server: the adopter naming another identity, with presence, is refused owned_by_other and nothing moves", async t => {
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

test("a paired device's live presence session rides the kernel call: an admin act is refused needs_presence without a session, passes after start-paired, and is refused again once the session is revoked", async t => {
  // a development build: the paired session of a software key is presence for an admin act (the SW-1 test below has the switch off)
  const savedSw = process.env.VYRE_SEAL_SOFTWARE; process.env.VYRE_SEAL_SOFTWARE = "1";
  t.after(() => { if (savedSw === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = savedSw; });
  const f = await pairFreshServer(t);
  const links = linksFor(t, f);
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const space = f.w.d.kernel.id.space;
  const rk = links.remoteKernel("srv", space);
  const define = () => rk.gateway.records.define(null, { add_types: [CONTACT] }).then(() => "ok", e => String(e.code || e.message));
  assert.match(await define(), /needs_presence|presence/, "no paired session: refused for presence");
  await links.startPaired("srv");
  assert.equal(await define(), "ok", "with the device's paired session the admin act passes");
  await f.w.d.registry.call("presence.person.end-paired", { device: f.done.device }, "module:wink");
  assert.match(await define(), /needs_presence|presence|not_a_member|session/, "the session was revoked: refused again at the next call");
});

test("SW-1: a software-marked paired session is presence over the door only where the presence module takes software proofs (the development switch); a hardware-marked one passes either way", async t => {
  const f = await pairFreshServer(t, { presenceStorage: "software" });
  const links = linksFor(t, f);
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const rk = links.remoteKernel("srv", f.w.d.kernel.id.space);
  const define = () => rk.gateway.records.define(null, { add_types: [CONTACT] }).then(() => "ok", e => String(e.code || e.message));
  await links.startPaired("srv");
  const mine = (await f.w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data;
  assert.ok((mine.sessions || mine).some(s => s.software === true), "the paired session is software-marked");
  const saved = process.env.VYRE_SEAL_SOFTWARE;
  t.after(() => { if (saved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = saved; });
  delete process.env.VYRE_SEAL_SOFTWARE;
  assert.match(await define(), /needs_presence|presence/, "switch off: a software session is not presence for an admin act");
  process.env.VYRE_SEAL_SOFTWARE = "1";
  assert.equal(await define(), "ok", "switch on (a development build): it passes");
});

test("SW-1 on a release-kind build (software switch off): a software paired session is refused an admin act, an enclave-key session passes, and a session the owner's phone approved passes for a software-key browser", async t => {
  const saved = process.env.VYRE_SEAL_SOFTWARE;
  t.after(() => { if (saved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = saved; });
  delete process.env.VYRE_SEAL_SOFTWARE;
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const defineOn = (f, links) => links.remoteKernel("srv", f.w.d.kernel.id.space).gateway.records.define(null, { add_types: [CONTACT] }).then(() => "ok", e => String(e.code || e.message));
  // an enclave key (the app reported hardware storage; unattested is accepted, ruling 6410c6a): not software, passes
  { const f = await pairFreshServer(t, { presenceStorage: "hardware" }); const links = linksFor(t, f); await links.startPaired("srv");
    const mine = (await f.w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data; assert.ok(!(mine.sessions || mine).some(s => s.software === true), "an enclave-key session is not software-marked");
    assert.equal(await defineOn(f, links), "ok", "an enclave-key session passes"); }
  // a software-key browser: refused, until the owner's phone approves its sign-in
  { const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software" }); const links = linksFor(t, f); await links.startPaired("srv");
    assert.match(await defineOn(f, links), /needs_presence|presence/, "a software session is refused");
    const ask = await links.askSignIn("srv", "Alex's browser");
    assert.equal((await links.signInStatus("srv", ask.id)).state, "waiting");
    assert.match(await defineOn(f, links), /needs_presence|presence/, "asking is not approval");
    assert.equal((await f.w.d.registry.call("presence.person.session-answer", { id: ask.id, yes: true }, "cli", PROOF)).data.state, "approved");
    assert.equal((await links.signInStatus("srv", ask.id)).state, "approved");
    await links.startPaired("srv");
    assert.equal(await defineOn(f, links), "ok", "the phone-approved session passes"); }
  // a refused ask grants nothing
  { const f = await pairFreshServer(t, { kind: "web", about: { kind: "web" }, presenceStorage: "software" }); const links = linksFor(t, f); await links.startPaired("srv");
    const ask = await links.askSignIn("srv");
    assert.equal((await f.w.d.registry.call("presence.person.session-answer", { id: ask.id, yes: false }, "cli", PROOF)).data.state, "refused");
    assert.equal((await links.signInStatus("srv", ask.id)).state, "refused");
    assert.match(await defineOn(f, links), /needs_presence|presence/, "a refused ask leaves the session software"); }
});
