// A protected type (kit-proposal, kit-install, or a type that says `protected: true`): a row is changed only by whoever made it or an owner or admin. A member who may write the type cannot rewrite another's row.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice", BOB = "per_bob";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const PROPOSAL = { name: "kit-proposal", label: "Kit waiting", fields: [{ name: "proposal_id", kind: "text", label: "Id" }, { name: "body", kind: "text", label: "Body" }] };
const NOTE = { name: "memo", label: "Memo", protected: true, fields: [{ name: "body", kind: "text", label: "Body" }] };
const FREE = { name: "plain", label: "Plain", fields: [{ name: "body", kind: "text", label: "Body" }] };

test("a protected type: a member cannot create, read, change or remove its rows; an admin can; a row planted by anyone else is never returned", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (const [p, role] of [[ALICE, "admin"], [BOB, "member"]]) { const r = { person: p, role }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const alice = k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: ALICE, path: "direct" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [PROPOSAL, NOTE, FREE] });
  for (const type of ["kit-proposal", "memo"]) {
    const body = type === "kit-proposal" ? i => ({ proposal_id: `kp_${i}`, body: "{}" }) : i => ({ body: `m${i}` });
    await assert.rejects(() => R.create(bob, type, body(0)), { code: "not_allowed" }, `${type}: a member cannot create`);
    const row = await R.create(owner, type, body(1));
    assert.equal(await R.get(bob, type, row.id), null, `${type}: a member reads nothing by id`);
    assert.deepEqual((await R.query(bob, type, { page: { limit: 10 } })).rows, [], `${type}: nor by list`);
    assert.deepEqual(await R.aggregate(bob, type, { measures: [{ fn: "count" }] }), [], `${type}: nor a count`);
    assert.equal((await R.search(bob, { text: type === "memo" ? "m1" : "kp_1", page: { limit: 5 } })).rows.filter(h => h.type === type).length, 0, `${type}: nor by search`);
    await assert.rejects(() => R.update(bob, type, row.id, { body: "changed" }, row.version), e => ["not_allowed", "not_found"].includes(e.code), `${type}: a member cannot change the owner's row`);
    await assert.rejects(() => R.remove(bob, type, row.id, row.version), e => ["not_allowed", "not_found"].includes(e.code), `${type}: nor remove it`);
    assert.equal((await R.get(alice, type, row.id)).id, row.id, `${type}: an admin reads it`);
    assert.equal((await R.update(alice, type, row.id, { body: "by admin" }, row.version)).data.body, "by admin", `${type}: an admin may change it`);
    // a row planted behind the gateway's back (no kernel attributes, so nobody trusted made it) is not returned to anyone, though it has the real id and sorts first
    const planted = await k.store.create(type, "00000000-0000-4000-8000-000000000001", body(1));
    const listed = (await R.query(alice, type, { page: { limit: 10 } })).rows.map(r => r.id);
    assert.ok(!listed.includes(planted.id), `${type}: the planted row is not listed`);
    assert.equal(await R.get(alice, type, planted.id), null, `${type}: nor fetched`);
    assert.ok(listed.includes(row.id), `${type}: the real row is`);
  }
  const free = await R.create(owner, "plain", { body: "x" });
  assert.equal((await R.update(bob, "plain", free.id, { body: "y" }, free.version)).data.body, "y", "an ordinary type is unchanged");
  assert.equal((await R.get(bob, "plain", free.id)).data.body, "y");
});

test("a module's kernel handle (a Proxy over the gateway's records) works: define, create, get and query through createKernel's kernelFor", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const handle = k.kernelFor({ name: "probe", needs: { kernel: { actions: ["records.read"] } } });
  await handle.records.define(owner, { add_types: [FREE, PROPOSAL] });
  const row = await handle.records.create(owner, "plain", { body: "x" });
  assert.equal((await handle.records.get(owner, "plain", row.id)).data.body, "x");
  assert.equal((await handle.records.query(owner, "plain", { page: { limit: 5 } })).rows.length, 1);
  assert.equal((await handle.records.query(owner, "kit-proposal", { page: { limit: 5 } })).rows.length, 0);
});

test("FZ-1: nobody can replace a records method: the gateway's records are frozen, and a module's handle is a read-only view (assign, delete and defineProperty all refuse)", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const handle = k.kernelFor({ name: "probe", needs: { kernel: { actions: ["records.read"] } } });
  assert.equal(Object.isFrozen(k.gateway.records), true);
  assert.throws(() => { k.gateway.records.query = async () => ({ rows: [] }); }, TypeError);
  assert.throws(() => { delete k.gateway.records.query; }, TypeError);
  assert.throws(() => Object.defineProperty(k.gateway.records, "query", { value: () => 1 }), TypeError);
  const real = handle.records.query;
  assert.throws(() => { handle.records.query = async () => ({ rows: [] }); }, TypeError);
  assert.throws(() => { delete handle.records.query; }, TypeError);
  assert.throws(() => Object.defineProperty(handle.records, "query", { value: () => 1 }), TypeError);
  assert.throws(() => Object.setPrototypeOf(handle.records, {}), TypeError);
  assert.equal(typeof handle.records.query, typeof real, "the method is still the kernel's");
});
