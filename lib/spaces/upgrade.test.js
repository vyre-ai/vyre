import "../../scripts/mac-test-guard.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { createSqliteStore } from "../../kernel/store/sqlite.js";
import { createTwentyStore } from "../../stores/twenty/store.js";
import { TwentyClient } from "../../stores/twenty/client.js";
import { FakeTwenty } from "../../stores/twenty/testing/fake-twenty.js";
import { CONTACT, LEAD } from "../../kernel/conformance/suite.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest } from "../../kernel/remote/proof.js";
import { planUpgrade, runUpgrade, fingerprint, resealPortFor } from "./upgrade.js";
import { startSealer } from "../../kernel/seal/client.js";
import { tmp, signer, enrolDevice } from "../../kernel/seal/testing.js";
import { canonical } from "../../kernel/core/canonical.js";

const PERSONAL = "spc_pppppppppppp".replace(/p/g, "c"), CLOUD = "spc_" + "dddddddddddd";
const ME = "per_" + "m".repeat(26);
let T = 1_800_000_000_000;
const clock = () => ++T;
const dirs = [];
const fake = await new FakeTwenty().start();
after(async () => { await fake.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const presenceFor = () => { const used = new Set(); return { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "wrong_payload") }; };
const sign = (space, call, ...a) => ({ presence: { payload_hash: proofRequest(space, call, ...a).payload_hash, nonce: Math.random().toString(36) } });

/** Personal (the built-in SQLite store, the device's kernel) and My Cloud (the Twenty store over a fake Twenty, the server's kernel), both for the same person. */
async function rig() {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "up-")); dirs.push(dir);
  const pk = await createKernel({ space: PERSONAL, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock, presence: presenceFor(), store: createSqliteStore({ db: new DatabaseSync(":memory:") }) });
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const twenty = createTwentyStore({ client, space: CLOUD, dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  await twenty.define({ add_types: [...CORE_TYPES] }); // My Cloud's Twenty has the core types before its kernel starts, as a real server does
  const ck = await createKernel({ space: CLOUD, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 2), clock, presence: presenceFor(), store: twenty });
  const chain = (k) => k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: ME, path: "direct" });
  const local = { space: PERSONAL, records: pk.gateway.records, definitions: (c) => pk.gateway.definitions(c), chain: chain(pk) };
  const remote = { space: CLOUD, records: ck.gateway.records, definitions: (c) => ck.gateway.definitions(c), chain: chain(ck) };
  return { pk, ck, local, remote, twenty };
}
const ref = (r) => ({ sealed: "ssn", ref: r, present: true, valid_format: true, set_at: 1 });

/**
 * Two stand-in sealing processes with real cryptography: the device's holds the plaintext of a sealed field; export wraps it to the TARGET sealer's x25519 public key (an ephemeral key, HKDF, AES-256-GCM), import
 * opens it inside the target sealer and keeps it there, giving the record only a new reference. Neither the courier nor the record store ever holds the plaintext.
 */
function sealers() {
  const device = new Map(); // ref -> plaintext, in the device's sealing process
  const cloud = new Map();  // ref -> plaintext, in My Cloud's sealing process
  const target = crypto.generateKeyPairSync("x25519");
  const seen = []; // everything the courier (the orchestrator) is handed
  const kdf = (secret) => Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), "vyre-upgrade-field-v1", 32));
  const ports = {
    targetKey: async () => target.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    export: async ({ ref }, targetKeyB64) => {
      const eph = crypto.generateKeyPairSync("x25519");
      const pub = crypto.createPublicKey({ key: Buffer.from(targetKeyB64, "base64"), type: "spki", format: "der" });
      const key = kdf(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }));
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(device.get(ref), "utf8"), c.final()]);
      const blob = { epk: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
      seen.push(JSON.stringify(blob));
      return blob;
    },
    import: async ({ blob }) => {
      seen.push(JSON.stringify(blob));
      const key = kdf(crypto.diffieHellman({ privateKey: target.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(blob.epk, "base64"), type: "spki", format: "der" }) }));
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64")); d.setAuthTag(Buffer.from(blob.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8");
      const r = `sv_cloud_${cloud.size + 1}`; cloud.set(r, plain);
      return ref(r);
    },
  };
  return { ports, device, cloud, seen };
}

/** My Cloud's key (stand-in for its published Space key) and the receipt it signs from ITS OWN store: what the target tool does. The Personal kernel checks it through the registry's move hooks. */
function receipts(w) {
  const key = crypto.generateKeyPairSync("ed25519");
  const hooks = { verifyUpgradeReceipt: async (r, c) => (r && r.body && r.body.from === c.from && r.body.to === c.to && r.body.upgrade_id === c.upgrade_id && crypto.verify(null, Buffer.from(`vyre-upgrade-receipt-v1\n${canonical(r.body)}`), key.publicKey, Buffer.from(r.sig, "base64url")) ? r.body : null) };
  w.pk.bindSpaces({ moveHooks: () => hooks });
  return async (upgrade_id, plan, over = {}) => {
    const fp = await fingerprint(w.remote, plan.objects);
    const body = { v: 1, upgrade_id, from: PERSONAL, to: CLOUD, count: fp.count, objects_root: fp.root, at: 1, ...over };
    return { body, sig: crypto.sign(null, Buffer.from(`vyre-upgrade-receipt-v1\n${canonical(body)}`), key.privateKey).toString("base64url") };
  };
}

async function fill(w) {
  await w.local.records.define(w.local.chain, { add_types: [CONTACT, LEAD] });
  const a = await w.local.records.create(w.local.chain, "contact", { name: "Ada", age: 30 });
  const b = await w.local.records.create(w.local.chain, "contact", { name: "Bo", ssn: ref("sv_1") });
  const c = await w.local.records.create(w.local.chain, "contact", { name: "Cy" });
  const l1 = await w.local.records.create(w.local.chain, "lead", { title: "One", contact: { urn: `vyre://${PERSONAL}/contact/${a.id}` }, referrers: [{ urn: `vyre://${PERSONAL}/contact/${b.id}` }, { urn: `vyre://${PERSONAL}/contact/${c.id}` }] });
  const l2 = await w.local.records.create(w.local.chain, "lead", { title: "Two" });
  return { a, b, c, l1, l2 };
}

test("upgrade: one approval carries every record with its id, links rewritten to My Cloud, a sealed field carried SEALED (the plaintext never in the clear on the server), and the Personal space then points there", async () => {
  const w = await rig();
  const r = await fill(w);
  const sl = sealers();
  sl.device.set("sv_1", "123-45-6789");
  const ports = { reseal: sl.ports };
  // with no way to carry a sealed field the plan says so, and nothing runs: a sealed value is never left behind
  const bare = await planUpgrade({ local: w.local, remote: w.remote, to: CLOUD });
  assert.deepEqual(bare.sealed, [`contact/${r.b.id}: ssn`]);
  assert.match(bare.blockers[0], /sealed field/);
  await assert.rejects(() => runUpgrade({ plan: bare, local: w.local, remote: w.remote }), { code: "blocked" });
  const plan = await planUpgrade({ local: w.local, remote: w.remote, to: CLOUD, ports });
  assert.deepEqual([plan.counts.total, plan.counts.records.contact, plan.counts.records.lead, plan.blockers], [5, 3, 2, []]);
  assert.match(plan.hash, /^[A-Za-z0-9_-]{43}$/);
  // no approval, no upgrade; a proof for another target or plan is no proof
  await assert.rejects(() => w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }), { code: "needs_presence" });
  await assert.rejects(() => w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: "spc_" + "e".repeat(12), plan_hash: plan.hash })), { code: /needs_presence|bad_proof|wrong/ });
  const started = await w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: CLOUD, plan_hash: plan.hash }));
  assert.match(started.upgrade_id, /^[0-9a-f-]{36}$/);
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote, ports });
  assert.deepEqual(report.moved.records, { contact: 3, lead: 2 });
  assert.equal(report.moved.sealed_fields, 1);
  assert.deepEqual(report.notMoved, [], "nothing is left behind");
  // the records are in My Cloud, in Twenty, with their ids and their links pointing at My Cloud
  const got = await w.remote.records.get(w.remote.chain, "lead", r.l1.id);
  assert.equal(got.data.title, "One");
  assert.equal(got.data.contact.urn, `vyre://${CLOUD}/contact/${r.a.id}`);
  assert.deepEqual(got.data.referrers.map(x => x.urn).sort(), [`vyre://${CLOUD}/contact/${r.b.id}`, `vyre://${CLOUD}/contact/${r.c.id}`].sort());
  const bo = await w.remote.records.get(w.remote.chain, "contact", r.b.id);
  assert.equal(bo.data.name, "Bo");
  assert.equal((await w.remote.records.get(w.remote.chain, "contact", r.a.id)).data.age, 30);
  // the sealed field reads correctly in My Cloud: the record holds a reference, and My Cloud's own sealing process opens what was wrapped to it
  assert.equal(bo.data.ssn.sealed, "ssn");
  assert.match(bo.data.ssn.ref, /^sv_cloud_/);
  assert.equal(sl.cloud.get(bo.data.ssn.ref), "123-45-6789");
  // and the plaintext was never in the clear anywhere the server could keep it: not in what the courier carried, not in a single request Twenty received, not in any file the stores wrote
  const PLAIN = "123-45-6789";
  assert.ok(sl.seen.length === 2 && sl.seen.every(x => !x.includes(PLAIN)), "the courier handled only the wrapped blob");
  assert.ok(!JSON.stringify(fake.requests).includes(PLAIN), "Twenty never received the plaintext");
  const filesWith = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (fs.readFileSync(f).includes(PLAIN)) filesWith.push(f); } };
  for (const d of dirs) walk(d);
  assert.deepEqual(filesWith, [], "no file on the server's disk holds the plaintext");
  // a stopped upgrade resumes: running it again finds everything there and changes nothing (the sealed field is not carried twice)
  const again = await runUpgrade({ plan, local: w.local, remote: w.remote, ports });
  assert.deepEqual(again.moved.records, { contact: 3, lead: 2 });
  // finish: counts only, the failures by name. The Personal space freezes ONLY on My Cloud's own signed receipt that it holds exactly what this space holds
  assert.equal(w.pk.gateway.upgrade.movedTo(), null);
  const receiptFor = receipts(w);
  const approve = () => w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: CLOUD, plan_hash: plan.hash }));
  const fin1 = await w.pk.gateway.upgrade.finish(w.local.chain, { upgrade_id: started.upgrade_id, counts: { records: report.moved.records }, failed: [], freeze: true });
  assert.deepEqual([fin1.frozen, fin1.not_frozen_because], [false, "My Cloud has not confirmed that everything arrived"], "the caller's word is not a proof of arrival");
  const s2 = await approve();
  const wrongCount = await receiptFor(s2.upgrade_id, plan, { count: 4 });
  const fin2 = await w.pk.gateway.upgrade.finish(w.local.chain, { upgrade_id: s2.upgrade_id, counts: {}, freeze: true, receipt: wrongCount });
  assert.deepEqual([fin2.frozen, fin2.not_frozen_because], [false, "My Cloud's receipt does not match what this space holds"], "a receipt for fewer objects than this space holds");
  const s3 = await approve();
  const forged = { body: (await receiptFor(s3.upgrade_id, plan)).body, sig: "A".repeat(86) };
  assert.equal((await w.pk.gateway.upgrade.finish(w.local.chain, { upgrade_id: s3.upgrade_id, counts: {}, freeze: true, receipt: forged })).frozen, false, "a receipt not signed by My Cloud's key");
  assert.equal(w.pk.gateway.upgrade.movedTo(), null);
  const s4 = await approve();
  const good = await receiptFor(s4.upgrade_id, plan);
  assert.equal(good.body.count, 5);
  const fin = await w.pk.gateway.upgrade.finish(w.local.chain, { upgrade_id: s4.upgrade_id, counts: { records: report.moved.records }, failed: [], freeze: true, receipt: good });
  assert.deepEqual([fin.upgraded, fin.to, fin.frozen], [true, CLOUD, true]);
  assert.equal(w.pk.gateway.upgrade.movedTo().to, CLOUD);
  await assert.rejects(() => w.local.records.create(w.local.chain, "contact", { name: "late" }), { code: "moved" });
  assert.equal((await w.local.records.get(w.local.chain, "contact", r.a.id)).data.name, "Ada", "the Personal records stay readable");
  await assert.rejects(() => approve(), { code: "invalid" }, "a moved space is not upgraded twice");
});

test("upgrade: chats and memory go through their ports, a failing port is named and does not stop the records, and a blocker stops it before anything is written", async () => {
  const w = await rig();
  await fill(w);
  const moves = [];
  const sl = sealers(); sl.device.set("sv_1", "secret-one");
  const ports = {
    reseal: sl.ports,
    chats: { plan: async () => ({ counts: { chats: 2 } }), move: async ({ to }) => { moves.push(["chats", to]); return { chats: 2 }; } },
    memory: { plan: async () => ({ counts: { items: 7 } }), move: async () => { throw new Error("the identity home is locked"); } },
  };
  const plan = await planUpgrade({ local: w.local, remote: w.remote, to: CLOUD, ports });
  assert.deepEqual([plan.counts.chats, plan.counts.memory], [{ chats: 2 }, { items: 7 }]);
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote, ports });
  assert.deepEqual(moves, [["chats", CLOUD]]);
  assert.deepEqual(report.moved.chats, { chats: 2 });
  assert.ok(report.notMoved.some(n => n.what === "memory" && /locked/.test(n.why)), "the memory failure is named");
  assert.deepEqual(report.moved.records, { contact: 3, lead: 2 }, "the records moved anyway");
  // a blocker (chats the move cannot carry) stops everything before a record is written
  const w2 = await rig();
  await fill(w2);
  const sl2 = sealers(); sl2.device.set("sv_1", "secret-one");
  const blocked = { reseal: sl2.ports, chats: { plan: async () => ({ blockers: ["a chat is still open on another device"], counts: {} }), move: async () => ({}) } };
  const p2 = await planUpgrade({ local: w2.local, remote: w2.remote, to: CLOUD, ports: blocked });
  assert.deepEqual(p2.blockers, ["chats: a chat is still open on another device"]);
  await assert.rejects(() => runUpgrade({ plan: p2, local: w2.local, remote: w2.remote, ports: blocked }), { code: "blocked" });
  assert.deepEqual((await w2.remote.definitions(w2.remote.chain)).filter(t => t.name === "lead"), [], "no type was added to My Cloud");
  assert.equal((await w2.remote.records.query(w2.remote.chain, "contact", { page: { limit: 5 } })).rows.length, 0, "and no record was written");
  // a plan for other spaces is refused
  await assert.rejects(() => runUpgrade({ plan: { ...p2, blockers: [], to: "spc_" + "e".repeat(12) }, local: w2.local, remote: w2.remote }), { code: "bad_input" });
});

test("upgrade: a type My Cloud already has with fewer fields gains the missing ones, named in the plan, and its records carry whole", async () => {
  const w = await rig();
  // My Cloud already has its own core contact (a name, an email, a phone ...), narrower than the Personal one in the fields the person added
  await w.local.records.define(w.local.chain, { add_types: [CONTACT] });
  const a = await w.local.records.create(w.local.chain, "contact", { name: "Ada", age: 30 });
  const plan = await planUpgrade({ local: w.local, remote: w.remote, to: CLOUD });
  const gains = plan.extend.find(e => e.type === "contact").fields;
  assert.ok(gains.includes("age") && !gains.includes("name") && !gains.includes("email"), JSON.stringify(plan.extend));
  const hashBefore = plan.hash;
  assert.notEqual((await planUpgrade({ local: w.local, to: CLOUD })).hash, hashBefore, "what My Cloud will gain is part of what the person approves");
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote });
  assert.deepEqual(report.moved.records, { contact: 1 });
  assert.equal((await w.remote.records.get(w.remote.chain, "contact", a.id)).data.age, 30);
});

test("upgrade: a different record already holding an id in My Cloud is named, not counted; a finish after the window is refused (UP-1, UP-2)", async () => {
  const w = await rig();
  const r = await fill(w);
  const sl = sealers(); sl.device.set("sv_1", "x");
  const ports = { reseal: sl.ports };
  const plan = await planUpgrade({ local: w.local, remote: w.remote, to: CLOUD, ports });
  assert.ok(plan.types.find(t => t.name === "contact").ids.includes(r.a.id), "the plan names ids, so the check afterwards is by id");
  // another record already sits in My Cloud under Ada's id, with other content
  await w.remote.records.define(w.remote.chain, { add_types: [LEAD] });
  await w.remote.records.create(w.remote.chain, "contact", { name: "Not Ada" }, { import: true, id: r.a.id });
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote, ports });
  assert.ok(report.notMoved.some(n => n.what === `contact/${r.a.id}` && /different record/.test(n.why)), JSON.stringify(report.notMoved));
  assert.equal(report.moved.records.contact, 2, "the clash is not counted as carried");
  assert.equal(report.recordsComplete, false, "so the Personal space is not frozen");
  assert.equal((await w.remote.records.get(w.remote.chain, "contact", r.a.id)).data.name, "Not Ada", "and nothing there was overwritten");
  // the window: an approval older than a day cannot be closed
  const started = await w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: CLOUD, plan_hash: plan.hash }));
  T += 25 * 60 * 60 * 1000;
  await assert.rejects(() => w.pk.gateway.upgrade.finish(w.local.chain, { upgrade_id: started.upgrade_id, counts: { records: {} }, freeze: true }), { code: "invalid" });
  assert.equal(w.pk.gateway.upgrade.movedTo(), null);
});

test("upgrade with REAL sealing processes: a sealed field is carried sealed under the one approval of the exact list, reads correctly in My Cloud, and the plaintext is on no disk but the sealers' own folders, encrypted", async t => {
  fake.reset();
  const PLAIN = "123-45-6789";
  const dirA = tmp("up-a"), dirB = tmp("up-b"), dirT = fs.mkdtempSync(path.join(SCRATCH, "up-t-")); dirs.push(dirT);
  const sealA = startSealer({ dir: dirA, timeoutMs: 8000, dev: true, unattested: true }), sealB = startSealer({ dir: dirB, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealA.close(); await sealB.close(); fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true }); });
  const alexA = signer(ME), alexB = signer(ME);
  await enrolDevice(sealA, alexA, { person: ME }); await enrolDevice(sealB, alexB, { person: ME });
  const pk = await createKernel({ space: PERSONAL, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock, presence: presenceFor(), sealer: sealA, store: createSqliteStore({ db: new DatabaseSync(":memory:") }) });
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const twenty = createTwentyStore({ client, space: CLOUD, dir: dirT, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  await twenty.define({ add_types: [...CORE_TYPES] });
  const ck = await createKernel({ space: CLOUD, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 2), clock, presence: presenceFor(), sealer: sealB, store: twenty });
  const chain = (k) => k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: ME, path: "direct" });
  const local = { space: PERSONAL, records: pk.gateway.records, definitions: (c) => pk.gateway.definitions(c), chain: chain(pk) };
  const remote = { space: CLOUD, records: ck.gateway.records, definitions: (c) => ck.gateway.definitions(c), chain: chain(ck) };
  await local.records.define(local.chain, { add_types: [CONTACT] });
  const bo = await local.records.create(local.chain, "contact", { name: "Bo" });
  const urn = `vyre://${PERSONAL}/contact/${bo.id}`;
  const put = await pk.gateway.seal.put(local.chain, { record: urn, field: "ssn", class: "us-ssn", value: PLAIN });
  await local.records.update(local.chain, "contact", bo.id, { ssn: put.ref }, bo.version);
  const sealing = { local: pk.gateway.seal, remote: ck.gateway.seal };
  // the plan names the sealed ref and has no blocker, because the transfer exists
  const plan = await planUpgrade({ local, remote, to: CLOUD, ports: { reseal: resealPortFor({ local, remote, sealing, plan_hash: "", approval: {} }) } });
  assert.deepEqual([plan.sealed.length, plan.sealedRefs, plan.blockers], [1, [put.ref.ref], []]);
  // the person's ONE approval covers the plan hash, the target's key and the exact list of sealed refs
  const approval = { proof: null };
  const port = resealPortFor({ local, remote, sealing, plan_hash: plan.hash, approval });
  const tk = await port.targetKey();
  const fields = { plan_hash: plan.hash, target_key: tk, refs: plan.sealedRefs };
  await assert.rejects(() => port.approve(plan.sealedRefs, urn), { code: "needs_presence" }, "without the person's proof nothing is approved");
  approval.proof = alexA.proof(local.chain, "seal.export_approve", fields);
  await port.approve(plan.sealedRefs, urn);
  // EX-1, through the REAL sealing processes: a key the person never approved (any other wrapping key, here the source's own) gets nothing, even with the approval that exists for the real target's key
  const attacker = String((await pk.gateway.seal.wrapKey(local.chain, { record: urn })).key);
  assert.notEqual(attacker, tk);
  await assert.rejects(() => pk.gateway.seal.export(local.chain, { record: urn, to_record: `vyre://${CLOUD}/contact/${bo.id}`, field: "ssn", ref: put.ref.ref, target_key: attacker, plan_hash: plan.hash }), { code: "needs_presence" }, "an export to a key other than the approved one is refused by the sealing process");
  // and a port whose target key cannot be verified against the published key never reaches the source's sealing process at all
  let approveCalls = 0;
  const spy = { ...sealing, local: { export: (...a) => pk.gateway.seal.export(...a), exportApprove: (...a) => { approveCalls++; return pk.gateway.seal.exportApprove(...a); } } };
  const unverified = resealPortFor({ local, remote, sealing: spy, plan_hash: plan.hash, approval, requireAttest: true, attest: async () => { throw Object.assign(new Error("not signed by the published key"), { code: "unverified_target" }); } });
  await assert.rejects(() => unverified.approve(plan.sealedRefs, urn), { code: "unverified_target" });
  assert.equal(approveCalls, 0, "no approval was asked of the sealing process for an unverified key");
  assert.equal(resealPortFor({ local, remote, sealing, plan_hash: plan.hash, approval, requireAttest: true }), null, "with nothing to verify the key against there is no port");
  const report = await runUpgrade({ plan, local, remote, ports: { reseal: port } });
  assert.deepEqual([report.moved.sealed_fields, report.notMoved], [1, []]);
  // it reads correctly in My Cloud, through My Cloud's own sealing process
  const got = await remote.records.get(remote.chain, "contact", bo.id);
  assert.equal(got.data.ssn.sealed, put.ref.sealed);
  assert.notEqual(got.data.ssn.ref, put.ref.ref, "My Cloud holds its own reference");
  const proof = alexB.proof(remote.chain, "seal.reveal", { ref: got.data.ssn.ref, purpose: "check" });
  assert.equal((await sealB.api.reveal({ chain: remote.chain, ref: got.data.ssn.ref, purpose: "check", proof })).value, PLAIN);
  // the plaintext is nowhere in the clear: not in any request Twenty received, not in either sealer's folder, not in the store's own folder
  assert.ok(!JSON.stringify(fake.requests).includes(PLAIN), "Twenty never received it");
  const holds = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (fs.readFileSync(f).includes(PLAIN)) holds.push(f); } };
  for (const d of [dirA, dirB, dirT]) walk(d);
  assert.deepEqual(holds, [], "no file holds the plaintext");
  // each listed ref goes once, and a second try needs the person again
  await assert.rejects(() => port.export({ urn, to_urn: `vyre://${CLOUD}/contact/${bo.id}`, field: "ssn", ref: put.ref.ref }, tk), { code: "needs_presence" });
});

test("EX-1: a target key is taken only through a verified answer; no way to verify means no sealed transfer; the name is in the plan hash", async () => {
  const fakeSeal = { export: async () => ({ blob: "b" }), exportApprove: async () => ({}), wrapKey: async () => ({ key: "ATTACKER" }), import: async () => ({ ref: "r" }) };
  const base = { local: { chain: {} }, remote: { space: "spc_remote", chain: {} }, sealing: { local: fakeSeal, remote: fakeSeal }, plan_hash: "h", approval: {} };
  assert.equal(resealPortFor({ ...base, requireAttest: true }), null, "no attest, no port");
  // the attested key is what the port uses, never the unsigned wrapKey answer
  const port = resealPortFor({ ...base, requireAttest: true, targetName: "acme", attest: async () => "SIGNED-KEY" });
  assert.equal(await port.targetKey(), "SIGNED-KEY");
  assert.equal(port.targetName, "acme");
  // a failed verification stops the port: no key, nothing approved
  const bad = resealPortFor({ ...base, requireAttest: true, attest: async () => { throw Object.assign(new Error("not signed"), { code: "unverified_target" }); } });
  await assert.rejects(() => bad.targetKey(), { code: "unverified_target" });
  await assert.rejects(() => bad.approve(["r1"], "vyre://spc_local/contact/x"), { code: "unverified_target" });
  // the person sees the target's name and the plan hash covers it
  const mk = (targetName) => ({ list: async () => [], definitions: async () => [] });
  const side = { space: "spc_local", chain: {}, definitions: async () => [], records: {} };
  const p1 = await planUpgrade({ local: side, to: "spc_remote", ports: { reseal: { targetName: "acme" } } });
  const p2 = await planUpgrade({ local: side, to: "spc_remote", ports: { reseal: { targetName: "evil" } } });
  assert.equal(p1.target_name, "acme");
  assert.notEqual(p1.hash, p2.hash);
});
