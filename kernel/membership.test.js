import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
import { canonical, sha256 } from "./core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", ADA = "per_ada";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) ? null : "wrong_proof") };

test("membership: one named person's role and nothing else, only for a module that declares it, logged; a list runs under the person's own chain", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [ADA, "manager"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const plain = k.kernelFor({ name: "plain", needs: { kernel: { actions: [] } } });
  assert.equal(plain.membership, undefined, "not declared, not there");
  assert.equal(k.kernelFor({ name: "none" }).membership, undefined);
  const spaces = k.kernelFor({ name: "spaces", needs: { kernel: { actions: [], membership: true } } });
  assert.deepEqual(await spaces.membership(BOB), { member: true, role: "member" });
  assert.deepEqual(await spaces.membership(ADA), { member: true, role: "manager" });
  assert.deepEqual(await spaces.membership("per_nobody"), { member: false, role: null });
  assert.deepEqual(Object.keys(await spaces.membership(BOB)).sort(), ["member", "role"], "nothing else");
  await assert.rejects(() => spaces.membership("../x"), { code: "bad_input" });
  await assert.rejects(() => spaces.membership(undefined), { code: "bad_input" });
  await assert.rejects(() => spaces.membership(BOB, "spc_bbbbbbbbbbbb"), { code: "not_found" });
  const ev = k.log.read({ type: "membership.read" });
  assert.equal(ev.length, 4, "each answered call is an event, a refused one is not");
  assert.deepEqual(ev[0].data, { module: "spaces", person: BOB, member: true });
  // enumeration is the person's own: a manager sees everyone, a member only themselves
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  assert.equal((await g.members.list(dev(ADA, "d-a"))).length, 3);
  assert.deepEqual((await g.members.list(dev(BOB, "d-b"))).map(m => m.person), [BOB]);
});
