// A person's profile in a Space (records/core-types.js MEMBER_PROFILE, kernel/gateway/ownership.js): the person makes and changes their own; nobody else does, not an owner, not an admin, not an agent.
// Every member reads every profile. An owner or an admin may remove one. Real kernel, real members.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { MEMBER_PROFILE } from "../../records/core-types.js";
import { mayWrite } from "./ownership.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ADMIN = "per_admin", BOB = "per_bob", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[ADMIN, "admin"], [BOB, "member"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  await k.gateway.records.define(owner, { add_types: [MEMBER_PROFILE] });
  const as = (/** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: id, path: "direct", session: "s" });
  return { k, owner, as, R: k.gateway.records };
}
const code = p => p.then(() => null, e => e && e.code);
const T = "member-profile";

test("a member makes and changes her own profile, and only her own", async () => {
  const { as, R } = await rig();
  assert.equal(await code(R.create(as(BOB), T, { person: DAN, about: "Not me" })), "not_allowed", "a profile for someone else");
  const mine = await R.create(as(BOB), T, { person: BOB, name: "Bob", about: "Runs intake", look: "s3~c5" });
  const next = await R.update(as(BOB), T, mine.id, { about: "Runs intake and billing" }, mine.version);
  assert.equal(next.data.about, "Runs intake and billing");
  assert.equal(await code(R.update(as(BOB), T, mine.id, { person: DAN }, next.version)), "not_allowed", "handing it to someone else");
  assert.equal(await code(R.update(as(DAN), T, mine.id, { about: "Changed by Dan" }, next.version)), "not_allowed", "another member changing it");
});

test("an owner and an admin read a profile and cannot make or change someone else's; they may remove one", async () => {
  const { owner, as, R } = await rig();
  const bobs = await R.create(as(BOB), T, { person: BOB, about: "Runs intake" });
  assert.equal((await R.get(owner, T, bobs.id)).data.about, "Runs intake", "the owner reads it");
  assert.equal((await R.get(as(DAN), T, bobs.id)).data.about, "Runs intake", "another member reads it");
  assert.equal(await code(R.update(owner, T, bobs.id, { about: "Changed by the owner" }, bobs.version)), "not_allowed", "the owner");
  assert.equal(await code(R.update(as(ADMIN), T, bobs.id, { about: "Changed by an admin" }, bobs.version)), "not_allowed", "an admin");
  assert.equal(await code(R.create(owner, T, { person: BOB, about: "Made by the owner" })), "not_allowed", "the owner making one for her");
  const own = await R.create(owner, T, { person: OWNER, about: "Owns the Space" });
  assert.equal(own.data.person, OWNER, "the owner writes their own like anyone");
  assert.equal(await code(R.remove(as(ADMIN), T, bobs.id, bobs.version)), null, "an admin removes a profile");
});

test("a person calling through a module (a person and a service hop) cannot make or change the person's profile", async () => {
  const { k, as, R } = await rig();
  const viaModule = k.chains.fromFacts({ kind: "module", inbound: as(BOB), module: "some-module", first_party: true });
  assert.equal(viaModule.hops.length, 2, "the person and the module's service hop");
  assert.notEqual(await code(R.create(viaModule, T, { person: BOB, about: "Made by a module" })), null, "create");
  const mine = await R.create(as(BOB), T, { person: BOB, about: "Runs intake" });
  assert.notEqual(await code(R.update(viaModule, T, mine.id, { about: "Changed by a module" }, mine.version)), null, "update");
  assert.equal((await R.get(as(BOB), T, mine.id)).data.about, "Runs intake", "unchanged");
  // the rule itself, whatever the gate before it says: a person with a service hop after them is not the person's own act
  const ctx = { trusted: false, project: async () => null };
  const hop = (kind, id) => ({ actor: { kind, id, space: SPACE } });
  const personService = { space: SPACE, hops: [hop("person", BOB), hop("service", "some-module")] };
  const personOnly = { space: SPACE, hops: [hop("person", BOB)] };
  const own = { id: mine.id, data: { person: BOB } };
  assert.equal(await code(mayWrite(personService, T, null, { person: BOB }, { ...ctx, op: "create" })), "not_allowed", "create, person and service");
  assert.equal(await code(mayWrite(personService, T, own, { about: "x" }, { ...ctx, op: "update" })), "not_allowed", "update, person and service");
  assert.equal(await code(mayWrite(personService, T, own, { about: "x" }, { ...ctx, op: "update", trusted: true })), "not_allowed", "trust does not let it change one");
  assert.equal(await mayWrite(personOnly, T, null, { person: BOB }, { ...ctx, op: "create" }), true, "the person alone");
  assert.equal(await mayWrite(personOnly, T, own, { about: "x" }, { ...ctx, op: "update" }), true, "the person alone");
});

test("an agent acting for the person cannot change the person's profile", async () => {
  const { k, as, R } = await rig();
  const mine = await R.create(as(BOB), T, { person: BOB, about: "Runs intake" });
  const agent = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: BOB, agent: "assistant", session: "s1" });
  assert.notEqual(await code(R.update(agent, T, mine.id, { about: "Written by an agent" }, mine.version)), null, "refused");
  assert.equal((await R.get(as(BOB), T, mine.id)).data.about, "Runs intake", "unchanged");
});
