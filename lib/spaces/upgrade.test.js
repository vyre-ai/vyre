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
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest } from "../../kernel/remote/proof.js";
import { planUpgrade, runUpgrade } from "./upgrade.js";

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
  // finish: counts only, the failures by name, and the Personal space is frozen and points at My Cloud
  assert.equal(w.pk.gateway.upgrade.movedTo(), null);
  const fin = await w.pk.gateway.upgrade.finish(w.local.chain, { upgrade_id: started.upgrade_id, counts: { records: report.moved.records }, failed: report.notMoved.map(n => n.what), freeze: report.recordsComplete });
  assert.deepEqual([fin.upgraded, fin.to, fin.frozen], [true, CLOUD, true]);
  assert.equal(w.pk.gateway.upgrade.movedTo().to, CLOUD);
  await assert.rejects(() => w.local.records.create(w.local.chain, "contact", { name: "late" }), { code: "moved" });
  assert.equal((await w.local.records.get(w.local.chain, "contact", r.a.id)).data.name, "Ada", "the Personal records stay readable");
  await assert.rejects(() => w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: CLOUD, plan_hash: plan.hash })), { code: "invalid" }, "a moved space is not upgraded twice");
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
  assert.deepEqual((await w2.remote.definitions(w2.remote.chain)).filter(t => t.name === "contact"), [], "nothing was written to My Cloud");
  // a plan for other spaces is refused
  await assert.rejects(() => runUpgrade({ plan: { ...p2, blockers: [], to: "spc_" + "e".repeat(12) }, local: w2.local, remote: w2.remote }), { code: "bad_input" });
});

test("upgrade: a type My Cloud already has with fewer fields gains the missing ones, named in the plan, and its records carry whole", async () => {
  const w = await rig();
  // My Cloud already has a narrower contact (a name only), the way its core types can be
  await w.remote.records.define(w.remote.chain, { add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name", required: true }] }] });
  await w.local.records.define(w.local.chain, { add_types: [CONTACT] });
  const a = await w.local.records.create(w.local.chain, "contact", { name: "Ada", age: 30 });
  const plan = await planUpgrade({ local: w.local, remote: w.remote, to: CLOUD });
  const gains = plan.extend.find(e => e.type === "contact").fields;
  assert.ok(gains.includes("age") && !gains.includes("name"), JSON.stringify(plan.extend));
  const hashBefore = plan.hash;
  assert.notEqual((await planUpgrade({ local: w.local, to: CLOUD })).hash, hashBefore, "what My Cloud will gain is part of what the person approves");
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote });
  assert.deepEqual(report.moved.records, { contact: 1 });
  assert.equal((await w.remote.records.get(w.remote.chain, "contact", a.id)).data.age, 30);
});
