// A protected type (kit-proposal, kit-install, or a type that says `protected: true`): a row is changed only by whoever made it or an owner or admin. A member who may write the type cannot rewrite another's row.
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

test("a member cannot change or remove another's row of a protected type, can of an ordinary type, can of their own; an admin and the maker can", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (const [p, role] of [[ALICE, "admin"], [BOB, "member"]]) { const r = { person: p, role }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const alice = k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: ALICE, path: "direct" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [PROPOSAL, NOTE, FREE] });
  // a member who may write these types (a grant on them)
  const gi = { subject: { kind: "role", name: "member" }, actions: ["records.read", "records.create", "records.update", "records.remove"], resource: { prefix: `vyre://${SPACE}/*` }, conditions: {}, source: "test" };
  void gi;
  for (const type of ["kit-proposal", "memo"]) {
    const row = await R.create(owner, type, type === "kit-proposal" ? { proposal_id: "kp_1", body: "{}" } : { body: "mine" });
    await assert.rejects(() => R.update(bob, type, row.id, { body: "changed" }, row.version), e => ["not_allowed", "not_found"].includes(e.code), `${type}: a member cannot change the owner's row`);
    await assert.rejects(() => R.remove(bob, type, row.id, row.version), e => ["not_allowed", "not_found"].includes(e.code), `${type}: nor remove it`);
    assert.equal((await R.update(alice, type, row.id, { body: "by admin" }, row.version)).data.body, "by admin", `${type}: an admin may`);
    const own = await R.create(bob, type, type === "kit-proposal" ? { proposal_id: "kp_2", body: "{}" } : { body: "bob's" });
    assert.equal((await R.update(bob, type, own.id, { body: "bob edits" }, own.version)).data.body, "bob edits", `${type}: a member changes their own`);
  }
  const free = await R.create(owner, "plain", { body: "x" });
  assert.equal((await R.update(bob, "plain", free.id, { body: "y" }, free.version)).data.body, "y", "an ordinary type is unchanged");
});
