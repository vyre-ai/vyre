// @ts-check
// The second half of test/wink.test.js, split off because the file grew past the 300 s per-file limit (the first half is wink.test.js); the helpers are the same.
// Wink pairing as grants (core/wink): a typed code, two-sided, ends in one grant and a few events; an invitation becomes a membership;
// sharing a computer is a node.host grant; removal takes the grant and the device with it. A real vyred, the Node relay, a real typing
// device (relay/client/join.js). 127.0.0.1 only. Run on a runner or the test server (daemon tests never run on the person's Mac).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
// This file has 29 cases of 5 to 20 s that can outrun the 300 s per-file limit on a loaded machine. The cases are dealt out to 3 files (wink-paired.test.js and its -b.. siblings, which set VYRE_WINK_PAIRED_SHARD and import this module), each well inside the per-file limit even on a loaded machine.
const SHARDS = 3;
const SHARD = Number(process.env.VYRE_WINK_PAIRED_SHARD ?? 0);
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
import { authenticator } from "../apps/app/src/identity/soft-authenticator.js";
import { claimIdentityWithPasskey } from "../apps/app/src/identity/claim.js";
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
  const d = await start({ ...(opt.realPresence ? {} : { presence: lenient }), root, log: m => { logs.push(String(m)); if (process.env.WLOG) console.error(m); }, coreKeys: macCore(), ...(opt.kernel ? { kernel: true } : {}), ...(opt.kernelSealer ? { kernelSealer: opt.kernelSealer } : {}), ...(opt.kernelDoor ? { kernelDoor: opt.kernelDoor } : {}) });
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











shardTest("paired session ends, on the real kernel: removing the owner key that confirmed the pairing ends the session at once, and a key that confirmed nothing does not", async t => {
  const a = await pairedOnKernel(t, { confirmWithRealKey: true });
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const otherId = (await a.w.d.registry.call("presence.enroll", { kind: "device", name: "Spare", public_key: other.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 }, "cli", PROOF)).data.id;
  assert.equal((await a.w.d.registry.call("presence.remove", { id: otherId }, "cli", PROOF)).data.removed, otherId);
  assert.equal(await a.live(), true, "removing a key that confirmed nothing leaves the session alone");
  assert.equal((await a.w.d.registry.call("presence.remove", { id: a.ownerKey }, "cli", PROOF)).data.removed, a.ownerKey);
  assert.equal(await a.live(), false, "the session bound to the removed key is gone at once");
});

shardTest("PS-4 and sessions scope, on the real kernel: a paired session lists only itself, a person's own surface lists every one", async t => {
  const a = await pairedOnKernel(t);
  const b = await pairedOnKernel(t, {}, a.w);
  const list = async (caller, meta) => { const x = (await a.w.d.registry.call("presence.person.sessions", {}, caller, meta)).data; return (x.sessions || x).map(y => y.id).sort(); };
  assert.deepEqual(await list("cli", PROOF), [a.sessionId, b.sessionId].sort(), "the owner's surface sees both");
  assert.deepEqual(await list("deck", { person: { id: a.sessionId } }), [a.sessionId], "a paired session sees only itself");
  assert.deepEqual(await list("deck", { person: { id: b.sessionId } }), [b.sessionId]);
});

shardTest("a browser whose identity is a passkey pairs a fresh server: the owner proof is a WebAuthn assertion, the server checks it against the directory's entry, and it is the owner", { timeout: 120_000 }, async t => {
  const ident = await standinIdentity(t, { passkey: true });
  const f = await pairFreshServer(t, { kind: "web", presenceStorage: "software", ident });
  assert.ok(f.done.paired, JSON.stringify(f.done).slice(0, 200));
  assert.equal(ident.auth.seen.gets >= 3, true, "the proof was a passkey assertion (the genesis, the claim, the pairing)");
  const st = (await f.w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.owned, true, JSON.stringify(st).slice(0, 300));
  assert.equal(st.owner_proof, "passkey");
});

shardTest("a device with no box pairs a fresh server through pairServer: the claimed identity and its name become the owner, only after the right pick at the server", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
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
async function standinIdentity(t, { passkey = false } = {}) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const rt = createRuntime({ worker: workerDir, Class: WD.Directory, classes: { DIRECTORY: WD.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async () => [] } });
  let n = 0;
  const state = { down: false };
  const fetchDir = async (url, init) => { if (state.down) throw new Error("unreachable"); return workerDir.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": `198.51.${(n >> 8) & 255}.${n++ & 255}` } }), rt.env); };
  const seen = memorySeen();
  const home = tempHome(t);
  const store = fileIdentityStore(path.join(home, "spaces"));
  const idDir = idDirectory({ base: "http://127.0.0.1:1", fetch: fetchDir, now: () => clock.t, seen });
  const ops = createIdentityOps({ store, dir: idDir, seen, now: () => clock.t, emit() {}, stretch: { memoryKiB: 64, passes: 1 } });
  spacesHooks.fetch = /** @type {any} */ (fetchDir);
  spacesHooks.now = () => clock.t;
  t.after(async () => { spacesHooks.fetch = null; spacesHooks.now = null; await rt.settle(); });
  if (passkey) {
    // a browser's identity: a passkey is the first device (0.2.9), and every proof it makes is a WebAuthn assertion, never a bare signature
    const auth = authenticator();
    const made = await claimIdentityWithPasskey({ name: "alex", code: (await idDir.reserve("alex")).code, password: "four plain words here", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (fetchDir), now: () => clock.t, params: { memoryKiB: 64, passes: 1 }, webauthn: auth });
    return { id: made.id, home, state, clock, auth, sign: async m => ({ eid: made.eid, sig: Buffer.from(await made.key.sign(m)).toString("base64url") }) };
  }
  await ops.create({ name: "alex", password: "four plain words here", deviceLabel: "Alex's phone", code: (await idDir.reserve("alex")).code });
  return { id: store.status().id, home, state, store, ops: () => store.ops(), clock,
    sign: async m => ({ eid: store.status().eid, sig: Buffer.from(await store.sign(Buffer.from(m))).toString("base64url") }) };
}

/** A box-less device pairs a fresh server and picks the words; resolves what the device then holds. */
async function pairFreshServer(t, { kind = "phone", about, presenceStorage = "hardware", ident = null, devKey = null, realPresence = false, kernelSealer = null, kernelDoor = null } = {}) {
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
  const w = await world(t, { kernel: true, realPresence, kernelSealer, kernelDoor });
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
  return { w, dk, ks, ident, owner, done, made, sign: m => devKey ? devKey.sign(m) : crypto.sign("sha256", Buffer.from(m), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
const linksFor = (t, f) => {
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "Alex's iPhone", sign: f.sign,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => links.close());
  return links;
};

shardTest("device-first, real daemon, relay and kernel: the pick leaves the device recorded, granted, enrolled and admitted: start-paired works, the server lists it with presence, and a call over the peer session answers the owner", async t => {
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

shardTest("device-first attacks: a removed device holding a token and a stream is refused at its next call; a replayed start-paired is refused, a fresh sign-in by its own key replaces the session; a stranger never gets a stream", async t => {
  const f = await pairFreshServer(t);
  const { w, done } = f;
  const links = linksFor(t, f);
  const l = links.sessionFor("srv");
  const first = await links.startPaired("srv");
  await l.call("records.me", {});
  const sessionsNow = async () => ((await w.d.registry.call("presence.person.sessions", {}, "cli", PROOF)).data.sessions || []).filter(x => x.paired).map(x => x.id);
  assert.deepEqual(await sessionsNow(), [first.id]);
  // a TRUE replay (the exact signed start-paired message sent again) is refused: the grant is one use
  const conn = connect({ relay: w.status.url, route: done.route, box: done.box, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: f.ks });
  t.after(() => conn.close());
  const raw = async (tool, input) => (await conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json().catch(() => ({}));
  const ch = (await raw("presence.person.pair-challenge", {})).data.challenge;
  const sig = await f.sign(`paired-start\n${done.device}\n${ch}`);
  const signedIn = await raw("presence.person.start-paired", { sig });
  assert.ok(signedIn.data && signedIn.data.token, `the device's own key, answering a fresh challenge, signs in: ${JSON.stringify(signedIn)}`);
  const replayed = await raw("presence.person.start-paired", { sig });
  assert.equal(replayed.error && replayed.error.code, "denied", "the same signed message again is refused");
  // a FRESH own-key sign-in is not a replay (#112): it replaces the device's own session, so the earlier one is gone and exactly one is live
  assert.deepEqual(await sessionsNow(), [signedIn.data.id], "the sign-in with the fresh challenge replaced the first session");
  const third = await links.startPaired("srv");
  assert.notEqual(third.id, signedIn.data.id);
  assert.deepEqual(await sessionsNow(), [third.id], "and so did the next fresh sign-in: one live session, never two");
  // removing the device at the server ends its next call, session and all
  assert.equal((await w.call("wink.remove", { device: done.device }, SCREEN, A)).data.removed, done.device);
  await assert.rejects(() => l.call("records.me", {}), e => /denied|closed|removed|unreachable|paired/.test(`${e.code} ${e.message}`));
  await assert.rejects(() => links.remoteKernel("srv", w.d.kernel.id.space).gateway.grants.members.list(null), e => /denied|closed|removed|unreachable|paired|not_a_member/.test(`${e.code} ${e.message}`));
});

shardTest("device-first: a web device is recorded as web with software storage", async t => {
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

shardTest("wink.server.adopt takes `proof` through the registry: a waiting redeemer's call with a proof is judged by the tool (denied, no identity port here), never refused as an unknown field", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
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

shardTest("a box-less device pairs a fresh server, is recorded as the owner's device with its kind, and then start-paired succeeds with no second step", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
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

shardTest("device-first, real daemon: the owner's device calls spaces.host-here on the server over the peer session; the server's kernel builds the chain from the peer and decides", async t => {
  const f = await pairFreshServer(t);
  const w = f.w;
  const links = linksFor(t, f);
  await links.startPaired("srv");
  const session = links.sessionFor("srv");
  // making a space is not a yes moment: the owner's authenticated call is enough, with no proof offered (a passkey browser has none to give right after pairing)
  const made = await session.call("spaces.host-here", { name: "harlow" });
  assert.match(made.space, /^spc_[a-z2-7]{12}$/);
  assert.ok(w.d.kernel.spaces.hosts(made.space), "the space is hosted by the SERVER's kernel");
});

shardTest("guard: a daemon with the kernel mounts the relay peer door (a merge once dropped the line and every peer stream was refused)", async t => {
  const w = await world(t, { kernel: true });
  const door = /** @type {any} */ (w.d.registry.deps).peerDoor && /** @type {any} */ (w.d.registry.deps).peerDoor();
  assert.ok(door && door.space === "home" && typeof door.accept === "function" && typeof door.allow === "function", "registry.deps.peerDoor() answers the door");
  assert.equal(door.allow("abcdefghijklmnop"), true);
  assert.equal(door.allow("../etc"), false);
});

shardTest("pairServer maps a refused owner to bad_owner, not a network error, and nothing is owned", async t => {
  const w = await world(t);
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; });
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  await assert.rejects(pairServer({ payload: made.qr, owner: { id: "per_a", name: "Alex" }, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t) }), e => e.code === "bad_owner");
  assert.equal((await w.call("wink.server.status", {}, "cli", PROOF)).data.owned, false);
});

shardTest("a pairing whose app closed before the yes does not leave the server busy: the ask is dropped and the next scanner is asked", async t => {
  const w = await world(t, { abandonMs: 150 });
  const saved = process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_WINK_TYPED_CODE = "0";
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
  process.env.VYRE_WINK_TYPED_CODE = "0";
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

shardTest("owning a server needs the identity proof checked against the directory: the right proof owns and the device has its session; no proof, another identity's, and an unreachable directory each refuse in their own words and own nothing", async t => {
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

shardTest("an owned server: a second device with no owner presence is granted nothing, and pair.answer from a paired device is refused", async t => {
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

shardTest("sessionFor signs the device in by itself when a call needs the person (no manual start-paired); a lapsed session is renewed with the device's own key; a removed device is refused", async t => {
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


shardTest("a computer's own device key makes the owner's proof for an act that needs presence over the peer wire: REAL presence on the server checks the key it enrolled at pairing", async t => {
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
  assert.match(made.space, /^spc_[a-z2-7]{12}$/, "host-here answered with no presence proof at all");
  assert.ok(f.w.d.kernel.spaces.hosts(made.space), "the space is hosted by the server's kernel");
  // an act that DOES need presence (taking a started space back) is the one that checks the enrolled key
  const second = await links.sessionFor("srv").call("spaces.host-here", { name: "second" });
  const retired = await links.sessionFor("srv").call("spaces.retire-here", { id: second.space });
  assert.ok(retired, "retire-here answered after the device signed the server's presence_required");
  // PW-1: with the dev switch off (a computer's own software key), nothing signs a presence challenge by itself
  const quiet = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "q", sign: m => devKey.sign(m), proveTool: devKey.proveTool,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => quiet.close());
  const third = await links.sessionFor("srv").call("spaces.host-here", { name: "third" });
  await assert.rejects(() => quiet.sessionFor("srv").call("spaces.retire-here", { id: third.space }), e => e.code === "presence_required");
  // a key the server never enrolled proves nothing
  const stranger = deviceKey(path.join(tempHome(t), "stranger.json"));
  const bad = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: f.ks }, name: "x", sign: m => devKey.sign(m), proveTool: stranger.proveTool, autoPresence: true,
    channelOf: sid => (sid === "srv" ? { relay: f.w.status.url, route: f.done.route, box: f.done.box } : null) });
  t.after(() => bad.close());
  await assert.rejects(() => bad.sessionFor("srv").call("spaces.retire-here", { id: third.space }), e => e.code === "presence_required");
});


shardTest("renewal lock: three wrong sign-in answers lock the device for fifteen minutes; only the owner's own device lifts it", async t => {
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

shardTest("SERVER-HOSTED SPACE end to end: a device daemon with a spaces module asks the paired server over the peer session; the SERVER's kernel hosts the space, the device keeps only a row and reaches it through the remote kernel", async t => {
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
  // one permission rule (ruling c328cd1): a paired device is you, so a change of types needs no proof and no session
  assert.ok(!noProof.error, `a change of types from a paired device passes with no proof: ${JSON.stringify(noProof.error)}`);
  fs.writeFileSync(standInFile, "");
  const MEMO = { name: "memo", label: "Memo", fields: [{ name: "title", kind: "text", label: "Title" }] };
  const defined = await dcall("records.define", { space: id, diff: { add_types: [MEMO] } });
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

shardTest("the pairing path adopts for real: after the pick the SERVER's home owner is the identity its own pairing record names (spaces.owner.adopt from module:wink); another identity, an added module and a second adoption change nothing", async t => {
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

shardTest("an invitee's session opens the stream with the signed hello in its head and only for that route; a new hello replaces the old link", async t => {
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













// ---- Add this device from another device: the joining side (relay/client/phonepair.js), a box-less device with its own identity key ----


// ---- a recovered phone (tailnet, 4 Oct): its key is on the identity's list by recovery and was never paired with this server ----


// ---- step 13 (walker): a removed server's route is refused ----


// ---- IV-5 (reviewer-3): invitee channels have a pool and a life of their own ----

/** After a refused pairing: the app\'s relay device goes (the drop follows the answer), and no device has a record of being the owner\'s. */
const noOwnerDevices = async w => {
  await until(async () => ((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []).filter(d => d.kind === "app" && !d.removed).length === 0 || null, 8000);
  for (const d of (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []) assert.equal((await w.d.registry.call("wink.device.record", { id: d.id }, "module:presence")).data, null, "no owner device record");
};

// ---- first owner wins: a home whose kernel already has a claimed owner is not paired by a different identity ----



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


shardTest("M1 invites to a space on its server: the home's one-use challenge is answered with the person's own key (a software key on a development build), and a release-kind build refuses a software key", async t => {
  const { startSealer } = await import("../kernel/seal/client.js");
  const { tmp } = await import("../kernel/seal/testing.js");
  const { softwareKey } = await import("../core/spaces/presence-signer.js");
  const softSaved = process.env.VYRE_SEAL_SOFTWARE;
  process.env.VYRE_SEAL_SOFTWARE = "1";
  t.after(() => { if (softSaved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = softSaved; });
  // the server's kernel runs on a real sealing process that takes software keys (a development build)
  const sealDir = tmp("m1-invite-seal");
  const sealer = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true, software: true });
  t.after(async () => { await sealer.close().catch(() => {}); fs.rmSync(sealDir, { recursive: true, force: true }); });
  const ident = await standinIdentity(t);
  // M1's own device key (the file its Wink module offers in every pairing hello): pairing it as the owner's computer is what enrols it in the home's sealing process
  const devKey = deviceKey(path.join(ident.home, "wink-keys.json.device"));
  const f = await pairFreshServer(t, { ident, kernelSealer: sealer, kind: "computer", presenceStorage: "software", devKey, kernelDoor: { usesKernelChain: true, ledgerKey: () => Buffer.alloc(32, 7).toString("base64") } });
  const server = f.w.d;
  const links = linksFor(t, f);
  await links.startPaired("srv");
  // M1: a computer with the SAME identity the server is owned by (the identity file is copied in, so its device key and id are the claimed ones)
  const droot = ident.home;
  fs.writeFileSync(path.join(droot, "config.json"), JSON.stringify({ name: "m1", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const { hooks: spacesHooks } = await import("../core/spaces/index.js");
  const device = await start({ root: droot, kernel: true, presence: lenient, sessionFor: async () => links.sessionFor("srv"), log: () => {} });
  spacesHooks.sessionFor = async () => links.sessionFor("srv");
  t.after(() => { spacesHooks.sessionFor = null; spacesHooks.buildRoot = undefined; });
  t.after(() => device.stop());
  const dcall = (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {any} */ headers = {}) => import("../core/daemon/client.js").then(m => m.call(tool, input, { root: droot, caller: "cli", headers }));
  device.registry.deps.db.prepare("INSERT INTO wink_devices (id, identity, kind, name, owner_kind, owner_id, created) VALUES (?, ?, 'server', 'srv', 'identity', ?, 1)").run("srv", ident.id, ident.id);
  const proofHeader = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ key: "k1" })).toString("base64url"), "x-vyre-presence": "passkey id=x" };
  const made = await dcall("spaces.create", { name: "harlowinv", displayName: "Harlow Legal", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
  assert.ok(!made.error && made.data.status === "done", JSON.stringify(made).slice(0, 300));
  const id = made.data.space;
  assert.equal(server.kernel.spaces.hosts(id), true, "the SERVER's kernel hosts it");
  // the pairing itself enrolled M1's key for the owner (nothing was enrolled by hand): the sealing process knows exactly this key
  const key = softwareKey(path.join(droot, "wink-keys.json.device"));
  assert.notEqual(await sealer.presenceCheck({ chain: { space: id, hops: [{ actor: { kind: "person", id: ident.id, space: id }, via: {} }] }, op: "x", fields: {}, proof: { signer: "software", key_id: key.key_id } }), "unknown_key", "the key is enrolled: the sealing process knows it (it refuses this empty proof for another reason)");
  // a release-kind build never answers with a software key: the call is handed back as a request to sign, and nothing is made
  const releaseRoot = tempHome(t);
  spacesHooks.buildRoot = releaseRoot;
  const refused = await dcall("spaces.invites.create", { space: id, role: "member" });
  assert.ok(!refused.error && refused.data.needs_proof === true && refused.data.request.challenge && refused.data.request.home, `release kind: ${JSON.stringify(refused).slice(0, 300)}`);
  // a development build answers the home's challenge with the person's software key and the invite is made in the one call
  spacesHooks.buildRoot = undefined;
  const made1 = await dcall("spaces.invites.create", { space: id, role: "member" });
  assert.ok(!made1.error && /\/join\/inv_/.test(made1.data.link), `dev kind: ${JSON.stringify(made1).slice(0, 400)}`);
  // a sealed value from M1 goes to the SERVER's sealing process (the record keeps only the reference)
  const PERSON = { name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }] };
  const def = await dcall("records.define", { space: id, diff: { add_types: [PERSON] } });
  assert.ok(!def.error, String(JSON.stringify(def.error)));
  const rec = await dcall("records.create", { space: id, type: "person", data: { name: "Jane" } });
  assert.ok(!rec.error, String(JSON.stringify(rec.error)));
  const urn = `vyre://${id}/person/${rec.data.record.id}`;
  const put = await dcall("records.seal-put", { urn, field: "ssn", value: "123-45-6789", class: "us-ssn" });
  assert.ok(!put.error, String(JSON.stringify(put.error)));
  assert.ok(!JSON.stringify(put.data).includes("123-45-6789"), "the value is not in the record");
  // a reveal on the server's space: the home's sealing process checks the yes. No proof: the call says what to sign; the proof made for that challenge shows the value; a wrong one shows nothing
  // the owner holds seal.reveal by role: no grant is made here
  const asked = await dcall("records.reveal", { urn, field: "ssn", purpose: "check the id" });
  assert.ok(!asked.error && asked.data.needs_proof === true && asked.data.request.op === "seal.reveal" && asked.data.request.challenge, JSON.stringify(asked).slice(0, 400));
  const { softwareProof } = await import("../core/spaces/presence-signer.js");
  const keyFile = path.join(droot, "wink-keys.json.device");
  const proofFor = (/** @type {any} */ rq, /** @type {any} */ tweak = {}) => ({ ...softwareProof(keyFile, ident.id, { op: rq.op, fields: rq.fields, payload_hash: rq.payload_hash, nonce: rq.challenge, home: rq.home, space: id }), ...tweak });
  const hdr = (/** @type {any} */ p) => ({ "x-vyre-kernel-proof": Buffer.from(JSON.stringify(p)).toString("base64url") });
  const shown = await dcall("records.reveal", { urn, field: "ssn", purpose: "check the id" }, hdr(proofFor(asked.data.request)));
  assert.ok(!shown.error && shown.data.value === "123-45-6789", JSON.stringify(shown).slice(0, 300));
  const again = await dcall("records.reveal", { urn, field: "ssn", purpose: "check the id" });
  const bad = await dcall("records.reveal", { urn, field: "ssn", purpose: "check the id" }, hdr(proofFor(again.data.request, { signature: Buffer.alloc(64).toString("base64url") })));
  assert.ok(bad.error, "a proof with a wrong signature shows nothing");
  const other = await dcall("records.reveal", { urn, field: "ssn", purpose: "check the id" });
  const forOther = await dcall("records.reveal", { urn, field: "ssn", purpose: "another purpose" }, hdr(proofFor(other.data.request)));
  assert.ok(forOther.error || forOther.data.needs_proof, "a proof for another request shows nothing");
  // and the home knows the invite
  const invs = await server.kernel.spaces.hosted(id).gateway.grants.invites.list(server.kernel.spaces.hosted(id).kernel.chains.fromFacts({ kind: "device", device_key_id: "x", person: ident.id, path: "direct", session: "s" }), {}).catch(() => null);
  if (invs) assert.ok(JSON.stringify(invs).includes(made1.data.id), "the home holds the invite");
});

shardTest("typed pair, real daemon and relay: addThisDevice by code with its presence key, the owner's signed ack confirms it, start-paired signs in with that key, and a person-session call works", async t => {
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  const savedTyped = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE; // the release default: the typed code is on
  t.after(() => { if (savedTyped !== undefined) process.env.VYRE_WINK_TYPED_CODE = savedTyped; else delete process.env.VYRE_WINK_TYPED_CODE; });
  const w = await world(t);
  const open = (await w.call("wink.phone.open", {})).data;
  assert.match(open.code, /^WINK-/);
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  const idKey = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const ks = keystore(t);
  let ack = "";
  const joining = addThisDevice({ code: open.code, relay: w.status.url, key: { publicKey: idKey, label: "Sam's phone" }, presenceKey, name: "Sam's phone", crypto: nodeCrypto(), keyStore: ks, pollMs: 50, onAck: a => { ack = a; } });
  joining.catch(() => {});
  await until(async () => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  // the ack is the owner's yes: typed with the owner's own proof (the stub accepts any proof), nothing is a device before it
  assert.equal((await w.call("wink.code.ack", { offer: open.code_offer, typed: ack }, "cli", PROOF)).data.ok, true);
  const done = await joining;
  assert.equal(done.paired, true);
  // the pair record is the owner's confirmation, with the device's presence key: what the paired session is granted on
  const rec = (await w.d.registry.call("wink.device.record", { id: done.device }, "module:presence")).data;
  assert.ok(rec && rec.confirmed && rec.owner && rec.confirmedBy === rec.owner, JSON.stringify(rec));
  assert.ok(rec.confirmKeyId, "a key id the grant is made for");
  assert.ok(rec.key, "the device's P-256 presence key was reported at pairing");
  // sign in: challenge, then start-paired signed with the PRESENCE key (never the identity key)
  const c = connect({ relay: done.relay, route: done.route, box: done.box, name: "Sam's phone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => c.close());
  const ch = await over(c, "presence.person.pair-challenge", {});
  assert.equal(ch.status, 200, JSON.stringify(ch));
  const sig = crypto.sign("sha256", Buffer.from(`paired-start\n${done.device}\n${ch.body.data.challenge}`), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const started = await over(c, "presence.person.start-paired", { sig });
  assert.equal(started.status, 200, JSON.stringify(started));
  // a person-session call from that device
  const me = await w.d.registry.call("wink.access", {}, `device:${done.device}`, { person: { id: started.body.data.id }, peer: { stableId: done.device, node: done.device } });
  assert.ok(!me.error, `the session answers: ${JSON.stringify(me.error)}`);
  assert.ok(me.data.devices.some(d => d.id === done.device), "the owner's device list, read with the typed-paired device's own session, holds that device");
});

shardTest("a link to a server that was removed and paired again is made afresh: forget lets go of the old connection and the next call connects to where the pairing now says the server is", async () => {
  const closed = [], opened = [];
  let where = { relay: "r1", route: "a", box: "b" };
  const links = createServerLinks({ connect: ch => { opened.push(ch.route); return { ready: () => Promise.reject(new Error("no relay here")), close: () => closed.push(ch.route) }; }, options: {}, name: "m", openMs: 20, channelOf: () => where });
  await links.sessionFor("srv").call("x").catch(() => {});
  assert.deepEqual(opened, ["a"]);
  where = { relay: "r1", route: "c", box: "d" };
  links.forget("srv");
  assert.deepEqual(closed, ["a"], "the old connection was closed");
  await links.sessionFor("srv").call("x").catch(() => {});
  assert.deepEqual(opened, ["a", "c"], "the next call connects to the new route");
});

shardTest("a pairing refused twice in a minute says its reason both times in the server's log", async t => {
  const f = await pairFreshServer(t);
  const crypt = nodeCrypto();
  for (let i = 0; i < 2; i++) {
    const k = await clientDeviceKey({ keyStore: keystore(t), crypto: crypt });
    await assert.rejects(() => openChannel({ relay: f.w.status.url, route: f.done.route, box: Buffer.from(f.done.box, "base64url"), keys: k, hello: { v: 1, pair: "y".repeat(22) }, crypto: crypt, WebSocket: globalThis.WebSocket }));
  }
  await until(async () => f.w.logs.filter(l => /relay: refused (a hello|again) \(this pairing code has expired/.test(l)).length >= 2);
});

shardTest("pair, release, then pair a browser as ANOTHER identity: refused with the server's own words and a log line saying why", async t => {
  const f = await pairFreshServer(t, { kind: "computer", presenceStorage: "software" });
  const w = f.w, dev = f.done.device;
  const rel = await w.d.registry.call("wink.server.release", {}, `device:${dev}`, { peer: { kind: "device", stableId: dev, node: dev } });
  assert.deepEqual(rel.data, { released: true }, JSON.stringify(rel.error));
  await until(async () => !(await relayHas(w, dev)));
  const other = await standinIdentity(t);
  const made = (await w.call("wink.server.code", { qr: true }, "cli", PROOF)).data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  let shown = "";
  const pairing = pairServer({ payload: made.qr, owner: { id: other.id, name: "Bea", vyre: "alex" }, signIdentity: other.sign, deviceKind: "web", keyStorage: "software", about: { kind: "web" }, name: "Bea's browser", crypto: nodeCrypto(), keyStore: keystore(t), presenceKey: { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" }, pollMs: 100, onWords: x => { shown = x; } });
  pairing.catch(() => {});
  const q = await until(async () => { const x = (await w.call("wink.server.pairing", {}, "cli", PROOF)).data; return x && x.asking ? x : null; }, 6000).catch(() => null);
  if (q) { await until(async () => shown); await w.call("wink.server.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 }, "cli", PROOF); }
  const r = await pairing.then(() => "paired", e => `${e.code}: ${e.message}`);
  assert.match(r, /^owned_by_other: This server belongs to alex\.vyre\.run\. Ask them to add you to a space, or reset the server to start over/);
  const st = (await w.call("wink.server.status", {}, "cli", PROOF)).data;
  assert.equal(st.owned, true, "the server is still owned: the kernel keeps its owner");
  assert.equal(st.released, true);
  await until(async () => w.logs.some(l => /a pairing from web:\S+ did not finish \(owned_by_other\)/.test(l)));
});

/** A device paired by the typed code on a kernel world (typed pair, signed ack, confirmed by its owner): { w, done, dk, ks, sign }. @param {any} t */
async function typedPairedOnKernel(t) {
  const { addThisDevice } = await import("../relay/client/phonepair.js");
  const savedTyped = process.env.VYRE_WINK_TYPED_CODE;
  delete process.env.VYRE_WINK_TYPED_CODE;
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; if (savedTyped !== undefined) process.env.VYRE_WINK_TYPED_CODE = savedTyped; else delete process.env.VYRE_WINK_TYPED_CODE; });
  const w = await world(t, { kernel: true });
  const opened = await w.call("wink.phone.open", {}, "cli", PROOF);
  assert.ok(opened.data && opened.data.code, `wink.phone.open gives a code: ${JSON.stringify(opened.error || opened.data).slice(0, 200)}`);
  const open = opened.data;
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  // the same key for the app's WebCrypto calls below
  const pkey = { privateKey: await globalThis.crypto.subtle.importKey("pkcs8", dk.privateKey.export({ format: "der", type: "pkcs8" }), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
  const idKey = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const ks = keystore(t);
  let ack = "";
  const joining = addThisDevice({ code: open.code, relay: w.status.url, key: { publicKey: idKey, label: "Sam's phone" }, presenceKey, name: "Sam's phone", crypto: nodeCrypto(), keyStore: ks, pollMs: 50, onAck: a => { ack = a; } });
  joining.catch(() => {});
  await until(async () => ack);
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.code_offer, typed: ack }, "cli", PROOF)).data.ok, true);
  // This box holds no name, so the owner's app would put the phone's key on the name's list and report it (wink.phone.enrolled); here the report is "could not", so the waiting phone is told at once.
  const asked = await until(() => w.events.find(e => e[0] === "wink.enrol-asked"), 4000).catch(() => null);
  if (asked) assert.equal((await w.call("wink.phone.enrolled", { device: asked[1].device, ok: false, reason: "this test box holds no name" }, "cli", PROOF)).data.ok, true);
  const done = await joining;
  const sign = m => crypto.sign("sha256", Buffer.from(m), { key: dk.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { w, done, dk, ks, sign, pkey };
}

shardTest("typed pair on the kernel: the typed-paired, acked device defines a record type and reads records.me over its own paired session", async t => {
  const { w, done, ks, sign } = await typedPairedOnKernel(t);
  const links = createServerLinks({ connect, options: { crypto: nodeCrypto(), keyStore: ks }, name: "Sam's phone", sign, channelOf: sid => (sid === "srv" ? { relay: w.status.url, route: done.route, box: done.box } : null) });
  t.after(() => links.close());
  assert.ok((await links.startPaired("srv")).id);
  const session = links.sessionFor("srv");
  const me = await session.call("records.me", {});
  assert.ok(JSON.stringify(me).includes(w.d.kernel.id.owner), `records.me answers the owner: ${JSON.stringify(me).slice(0, 200)}`);
  // the kernel's own gate for a change of types: a paired device is the person (one rule), so a real diff goes through with no extra proof
  const defined = await session.call("records.define", { diff: { add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] }] } });
  assert.equal(defined.applied, true, JSON.stringify(defined));
  // the same call as the daemon's own HTTP path builds it: the relay row plus the person Wink's record names, through callerFacts
  const { callerFacts } = await import("../core/daemon/index.js");
  const info = await w.d.registry.call("relay.device.info", { id: done.device }, "module:vyred");
  const rec = await w.d.registry.call("wink.device.record", { id: done.device }, "module:vyred");
  const facts = callerFacts(`device:${done.device}`, { caller: `device:${done.device}` }, { person: { id: "ps", kind: "bearer" } }, w.d.kernel, false, { ...info.data, person: rec.data && rec.data.owner });
  assert.ok(facts, "a confirmed paired device is given person facts");
  const viaFacts = await w.d.registry.call("records.define", { diff: { add_types: [{ name: "company", label: "Company", fields: [{ name: "name", kind: "text", label: "Name" }] }] } }, `device:${done.device}`, { kernelFacts: facts, person: { id: "ps", kind: "bearer" } });
  assert.equal(viaFacts.data && viaFacts.data.applied, true, JSON.stringify(viaFacts));
});

shardTest("typed pair on the kernel, over the relay as the app calls: the paired session's bearer and signed proof reach records.me and records.define as the person", async t => {
  const { w, done, ks, pkey } = await typedPairedOnKernel(t);
  // and HTTP over the relay, the way the app calls: the paired session's bearer token and a signed proof per request (the daemon builds the person's chain from the device facts, never from the session id)
  const { startPaired } = await import("../apps/app/src/auth/paired.ts");
  const { proofWith } = await import("../apps/app/src/auth/person.ts");
  const conn = connect({ relay: done.relay, route: done.route, box: done.box, name: "Sam's phone", crypto: nodeCrypto(), keyStore: ks });
  t.after(() => conn.close());
  const rawCall = async (tool, i) => { const x = await conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(i) }); return x.json().catch(() => ({})); };
  const st = await startPaired({ device: done.device, call: rawCall, privateKey: pkey.privateKey, label: "Sam's phone" });
  assert.ok(st.token, JSON.stringify(st));
  const signer = async m => new Uint8Array(await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pkey.privateKey, new TextEncoder().encode(m)));
  const http = async (tool, input) => { const body = JSON.stringify(input), url = `/v1/tools/${tool}`; const r = await conn.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Vyre ${st.token}`, "x-vyre-proof": await proofWith(signer, { method: "POST", url, body }) }, body }); return r.json().catch(() => ({})); };
  const meHttp = await http("records.me", {});
  assert.equal(meHttp.data && meHttp.data.person, w.d.kernel.id.owner, `records.me over the relay answers the owner: ${JSON.stringify(meHttp)}`);
  const defHttp = await http("records.define", { diff: { add_types: [{ name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }] }] } });
  assert.equal(defHttp.data && defHttp.data.applied, true, JSON.stringify(defHttp));
});

shardTest("the My Cloud upgrade end to end: a space made on the person's server has a published key, My Cloud signs the receipt, it verifies, and only then does Personal freeze and point there", async t => {
  const { startSealer } = await import("../kernel/seal/client.js");
  const { tmp } = await import("../kernel/seal/testing.js");
  const { softwareKey } = await import("../core/spaces/presence-signer.js");
  const softSaved = process.env.VYRE_SEAL_SOFTWARE;
  process.env.VYRE_SEAL_SOFTWARE = "1";
  t.after(() => { if (softSaved === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = softSaved; });
  // the server's kernel runs on a real sealing process that takes software keys (a development build)
  const sealDir = tmp("m1-invite-seal");
  const sealer = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true, software: true });
  t.after(async () => { await sealer.close().catch(() => {}); fs.rmSync(sealDir, { recursive: true, force: true }); });
  const ident = await standinIdentity(t);
  // M1's own device key (the file its Wink module offers in every pairing hello): pairing it as the owner's computer is what enrols it in the home's sealing process
  const devKey = deviceKey(path.join(ident.home, "wink-keys.json.device"));
  const f = await pairFreshServer(t, { ident, kernelSealer: sealer, kind: "computer", presenceStorage: "software", devKey, kernelDoor: { usesKernelChain: true, ledgerKey: () => Buffer.alloc(32, 7).toString("base64") } });
  const server = f.w.d;
  const links = linksFor(t, f);
  await links.startPaired("srv");
  // M1: a computer with the SAME identity the server is owned by (the identity file is copied in, so its device key and id are the claimed ones)
  const droot = ident.home;
  fs.writeFileSync(path.join(droot, "config.json"), JSON.stringify({ name: "m1", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const { hooks: spacesHooks } = await import("../core/spaces/index.js");
  const device = await start({ root: droot, kernel: true, presence: lenient, kernelPresence: { check: async () => null }, sessionFor: async () => links.sessionFor("srv"), log: m => { if (process.env.WLOG) console.error(m); } });
  spacesHooks.sessionFor = async () => links.sessionFor("srv");
  t.after(() => { spacesHooks.sessionFor = null; spacesHooks.buildRoot = undefined; });
  t.after(() => device.stop());
  const dcall = (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {any} */ headers = {}) => import("../core/daemon/client.js").then(m => m.call(tool, input, { root: droot, caller: "cli", headers }));
  device.registry.deps.db.prepare("INSERT INTO wink_devices (id, identity, kind, name, owner_kind, owner_id, created) VALUES (?, ?, 'server', 'srv', 'identity', ?, 1)").run("srv", ident.id, ident.id);
  const proofHeader = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ key: "k1" })).toString("base64url"), "x-vyre-presence": "passkey id=x" };
  const made = await dcall("spaces.create", { name: "mycloudup", displayName: "My Cloud", home: { kind: "server", device: { id: "srv", name: "srv", alwaysOn: true }, confirmed: true } }, proofHeader);
  assert.ok(!made.error && made.data.status === "done", JSON.stringify(made).slice(0, 300));
  const id = made.data.space;
  assert.equal(server.kernel.spaces.hosts(id), true, "the SERVER's kernel hosts it");
  // the hosted space has its key from creation, and the directory names it with that key
  const home = device.kernel.id.space;
  const resolved = await dcall("spaces.identity.resolve", { name: "mycloudup" });
  assert.ok(!resolved.error && resolved.data.kind === "space" && resolved.data.spaceId === id, JSON.stringify(resolved).slice(0, 300));
  // Personal records on this device's own home kernel
  const NOTE = { name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title", required: true }, { name: "body", kind: "text", label: "Body" }] };
  assert.ok(!(await dcall("records.define", { space: home, diff: { add_types: [NOTE] } })).error);
  const ids = [];
  for (const n of ["one", "two", "three"]) { const r = await dcall("records.create", { space: home, type: "note", data: { title: n, body: `body ${n}` } }); assert.ok(!r.error, JSON.stringify(r.error)); ids.push(r.data.record.id); }
  const plan = await dcall("spaces.upgrade.plan", { to: id });
  assert.ok(!plan.error, JSON.stringify(plan.error));
  assert.ok(plan.data.counts, JSON.stringify(plan).slice(0, 400));
  assert.equal(plan.data.counts.records.note, 3);
  // one approval: with none the device is asked for it, bound to this exact plan
  const asked = await dcall("spaces.upgrade.run", { to: id, plan_hash: plan.data.hash });
  assert.ok(!asked.error && asked.data.needs_proof === true && asked.data.request.op, JSON.stringify(asked).slice(0, 300));
  const { softwareActProof } = await import("../core/spaces/presence-signer.js");
  const proof = softwareActProof(path.join(droot, "wink-keys.json.device"), ident.id, asked.data.request);
  const hdr = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify(proof)).toString("base64url") };
  const done = await dcall("spaces.upgrade.run", { to: id, plan_hash: plan.data.hash }, hdr);
  assert.ok(!done.error && done.data.upgraded, JSON.stringify(done).slice(0, 600));
  assert.deepEqual([done.data.upgraded, done.data.moved.records.note, done.data.notMoved], [true, 3, []]);
  // My Cloud's signed receipt verified against the space's published key, so Personal froze and points there
  assert.equal(done.data.frozen, true, JSON.stringify(done.data));
  const row = (await dcall("spaces.list")).data.find(x => x.id === home);
  assert.equal(row && row.upgraded_to, id);
  // the records are on the server, in the hosted space
  for (const rid of ids) { const g = await dcall("records.get", { urn: `vyre://${id}/note/${rid}` }); assert.ok(!g.error && g.data.record.data.title, JSON.stringify(g.error)); }
  const late = await dcall("records.create", { space: home, type: "note", data: { title: "late" } });
  assert.equal(late.error && late.error.code, "moved", "Personal takes no new records");
});
