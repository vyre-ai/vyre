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

async function fill(w) {
  await w.local.records.define(w.local.chain, { add_types: [CONTACT, LEAD] });
  const a = await w.local.records.create(w.local.chain, "contact", { name: "Ada", age: 30 });
  const b = await w.local.records.create(w.local.chain, "contact", { name: "Bo", ssn: ref("sv_1") });
  const c = await w.local.records.create(w.local.chain, "contact", { name: "Cy" });
  const l1 = await w.local.records.create(w.local.chain, "lead", { title: "One", contact: { urn: `vyre://${PERSONAL}/contact/${a.id}` }, referrers: [{ urn: `vyre://${PERSONAL}/contact/${b.id}` }, { urn: `vyre://${PERSONAL}/contact/${c.id}` }] });
  const l2 = await w.local.records.create(w.local.chain, "lead", { title: "Two" });
  return { a, b, c, l1, l2 };
}

test("upgrade: one approval carries every record with its id, links rewritten to My Cloud, a sealed field named as not carried, and the Personal space then points there", async () => {
  const w = await rig();
  const r = await fill(w);
  const plan = await planUpgrade({ local: w.local, to: CLOUD });
  assert.deepEqual([plan.counts.total, plan.counts.records.contact, plan.counts.records.lead], [5, 3, 2]);
  assert.match(plan.hash, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(plan.sealed, [`contact/${r.b.id}: ssn`], "the plan says up front what cannot be carried");
  // no approval, no upgrade; a proof for another target or plan is no proof
  await assert.rejects(() => w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }), { code: "needs_presence" });
  await assert.rejects(() => w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: "spc_" + "e".repeat(12), plan_hash: plan.hash })), { code: /needs_presence|bad_proof|wrong/ });
  const started = await w.pk.gateway.upgrade.start(w.local.chain, { to: CLOUD, plan_hash: plan.hash }, sign(PERSONAL, "upgrade", { to: CLOUD, plan_hash: plan.hash }));
  assert.match(started.upgrade_id, /^[0-9a-f-]{36}$/);
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote });
  assert.deepEqual(report.moved.records, { contact: 3, lead: 2 });
  assert.deepEqual(report.notMoved.map(n => n.what), [`contact/${r.b.id}.ssn`]);
  // the records are in My Cloud, in Twenty, with their ids and their links pointing at My Cloud
  const got = await w.remote.records.get(w.remote.chain, "lead", r.l1.id);
  assert.equal(got.data.title, "One");
  assert.equal(got.data.contact.urn, `vyre://${CLOUD}/contact/${r.a.id}`);
  assert.deepEqual(got.data.referrers.map(x => x.urn).sort(), [`vyre://${CLOUD}/contact/${r.b.id}`, `vyre://${CLOUD}/contact/${r.c.id}`].sort());
  const bo = await w.remote.records.get(w.remote.chain, "contact", r.b.id);
  assert.equal(bo.data.name, "Bo");
  assert.equal(bo.data.ssn, undefined, "the sealed value did not travel");
  assert.equal((await w.remote.records.get(w.remote.chain, "contact", r.a.id)).data.age, 30);
  // a stopped upgrade resumes: running it again finds everything there and changes nothing
  const again = await runUpgrade({ plan, local: w.local, remote: w.remote });
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
  const ports = {
    chats: { plan: async () => ({ counts: { chats: 2 } }), move: async ({ to }) => { moves.push(["chats", to]); return { chats: 2 }; } },
    memory: { plan: async () => ({ counts: { items: 7 } }), move: async () => { throw new Error("the identity home is locked"); } },
  };
  const plan = await planUpgrade({ local: w.local, to: CLOUD, ports });
  assert.deepEqual([plan.counts.chats, plan.counts.memory], [{ chats: 2 }, { items: 7 }]);
  const report = await runUpgrade({ plan, local: w.local, remote: w.remote, ports });
  assert.deepEqual(moves, [["chats", CLOUD]]);
  assert.deepEqual(report.moved.chats, { chats: 2 });
  assert.ok(report.notMoved.some(n => n.what === "memory" && /locked/.test(n.why)), "the memory failure is named");
  assert.deepEqual(report.moved.records, { contact: 3, lead: 2 }, "the records moved anyway");
  // a blocker (chats the move cannot carry) stops everything before a record is written
  const w2 = await rig();
  await fill(w2);
  const blocked = { chats: { plan: async () => ({ blockers: ["a chat is still open on another device"], counts: {} }), move: async () => ({}) } };
  const p2 = await planUpgrade({ local: w2.local, to: CLOUD, ports: blocked });
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
