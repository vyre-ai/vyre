// After a restart a store that keeps the kernel attributes only in memory (Twenty's AttrMap) starts with an empty map; the log's create events are the authority (kernel/gateway/records.js attrsOf).
// A kept (protected) row made before the restart must still be read by an owner, not by a member; a privileged row must not be listed to a member. A kernel on a record store whose `meta` is an empty
// Map but whose log holds the create events.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { createSqliteStore } from "../store/sqlite.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const key = Buffer.alloc(32, 7);
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const KEPT = { name: "memo", label: "Memo", protected: true, fields: [{ name: "body", kind: "text", label: "Body" }] };
const NOTE = { name: "note", label: "Note", fields: [{ name: "body", kind: "text", label: "Body" }] };

test("after a restart on a store that keeps kernel attributes in memory: the owner still reads a kept row, a member still does not, and a privileged row is not listed to a member", async () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-restart-attrs-"));
  const kernelFile = path.join(dir, "kernel.db"), recordsFile = path.join(dir, "records.db");
  // the records live in their own database; the attributes are an empty Map at every start (what the Twenty store's meta is after a restart)
  const boot = () => { const store = createSqliteStore({ db: new DatabaseSync(recordsFile), clock: () => Date.now() }); return bootKernel({ db: new DatabaseSync(kernelFile), store: Object.create(store, { meta: { value: new Map() } }), space: SPACE, owner: OWNER, owner_uid: 501, key, sealer }); };
  const ownerOf = (/** @type {any} */ k) => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  const bobOf = (/** @type {any} */ k) => k.chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  let k = await boot();
  const o = ownerOf(k);
  await k.gateway.records.define(o, { add_types: [KEPT, NOTE] });
  const role = { person: BOB, role: "member" };
  await k.gateway.grants.setRole(o, role, { presence: proofFor("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  const kept = await k.gateway.records.create(o, "memo", { body: "kept by the owner" });
  const open = await k.gateway.records.create(o, "note", { body: "a plain note" });
  const secret = await k.gateway.records.create(o, "note", { body: "a privileged note" }, { attrs: { sensitivity: "privileged" } });
  const listed = async (/** @type {any} */ kk, /** @type {any} */ who, type = "note") => (await kk.gateway.records.query(who, type, { page: { limit: 50 } }).catch(() => ({ rows: [] }))).rows.map((/** @type {any} */ r) => r.id);
  // before the restart: the same answers (the map was filled by this process)
  assert.ok((await k.gateway.records.get(o, "memo", kept.id)), "before: the owner reads the kept row");
  assert.ok(!(await listed(k, bobOf(k))).includes(secret.id), "before: a privileged row is not listed to a member");
  // restart: a new kernel on the same files, with an empty attribute map
  k = await boot();
  const o2 = ownerOf(k), bob2 = bobOf(k);
  assert.ok((await k.gateway.records.get(o2, "memo", kept.id)), "after the restart the owner still reads the kept row (the log's create event says who made it)");
  assert.ok((await listed(k, o2, "memo")).includes(kept.id), "and lists it");
  assert.equal(await k.gateway.records.get(bob2, "memo", kept.id).catch(() => null), null, "a member still reads none of it");
  const seen = await listed(k, bob2);
  assert.ok(seen.includes(open.id), "a member still lists the plain note");
  assert.ok(!seen.includes(secret.id), "and still not the privileged one, though the map is empty (the log says it is privileged)");
});

test("a store with its own attribute map and a log that is not durable never says 'no privileged record': the restricted member's count is not pushed down to the store", async () => {
  const { createGateway } = await import("./index.js");
  const { createEventLog } = await import("../core/events.js");
  const { createChainBuilder } = await import("../core/chain.js");
  let T = 1_800_000_000_000; const clock = () => ++T;
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const real = createSqliteStore({ db: new DatabaseSync(":memory:"), clock });
  const store = Object.create(real, { meta: { value: new Map(), enumerable: true } });
  const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const grants = [{ id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: actor(OWNER) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" },
    { id: "gr_0002", space: SPACE, subject: { kind: "actor", actor: actor(BOB) }, actions: ["records.read"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/note/*`, where: [{ attr: "project", op: "eq", value: "p1" }] }, status: "active" }];
  const gw = createGateway({ space: SPACE, store, log: createEventLog({ space: SPACE, clock }), chains, clock, attrs: () => ({}), attrPush: () => true,
    grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ id) => grants.find(g => g.id === id) },
    members: { has: (/** @type {any} */ a) => a.id === OWNER || a.id === BOB }, hasPresenceSession: () => false });
  const owner = chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const bob = chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  await gw.records.define(owner, { add_types: [NOTE] });
  await gw.records.create(owner, "note", { body: "p1 note" }, { attrs: { project: "p1" } });
  const before = store.stats().aggregate_pushed;
  const count = JSON.stringify(await gw.records.aggregate(bob, "note", { measures: [{ fn: "count" }] }));
  assert.ok(count.includes("1"), `her count is one row: ${count}`);
  assert.equal(store.stats().aggregate_pushed, before, "and it was not pushed down to the store");
});
