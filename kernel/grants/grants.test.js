import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../gateway/index.js";
import { createGrantsStore } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { canonical, sha256 } from "../core/canonical.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice", BOB = "per_bob";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const personChain = who => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
const agentChain = (name, who = OWNER) => chains.fromFacts({ kind: "agent_session", agent: name, session: "s", thread: "t", vouched: true });
const actor = (kind, id) => ({ kind, id, space: SPACE });

/** A presence verifier with the same contract as the sealing process's: a proof binds the op and the exact fields, once. */
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) && !used.has(proof.n) && (used.add(proof.n), true) ? null : "wrong_payload") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const P = {
  create: input => ({ presence: proof("grants.create", input, `vyre://${SPACE}/grant/new`) }),
  revoke: (id, reason) => ({ presence: proof("grants.revoke", { id, reason }, `vyre://${SPACE}/grant/${id}`) }),
  narrow: (id, patch) => ({ presence: proof("grants.narrow", { id, patch }, `vyre://${SPACE}/grant/${id}`) }),
  role: m => ({ presence: proof("grants.role", m, `vyre://${SPACE}/member/${m.person}`) }),
  actor: a => ({ presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${a.id}`) }),
};

function rig() {
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock });
  const store = createMemoryStore({ clock });
  const gw = createGateway({ space: SPACE, store, log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true });
  gs.bootstrap({ owner: OWNER });
  return { gw, gs, log, store, g: gw.grants };
}
const sel = (prefix = `vyre://${SPACE}/contact/*`, extra = {}) => ({ prefix, ...extra });
const input = (over = {}) => ({ subject: { kind: "actor", actor: actor("person", BOB) }, actions: ["records.read"], resource: sel(), conditions: {}, source: "test", ...over });

test("grants: a grant is a person's act with a fresh proof bound to this exact input, once, and never from a chain holding a model", async () => {
  const { g, gs } = rig();
  await g.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const i = input();
  await assert.rejects(() => g.create(owner(), i), { code: "needs_presence" });
  await assert.rejects(() => g.create(owner(), i, P.create({ ...i, actions: ["records.update"] })), { code: "needs_presence" }, "a proof for other input");
  const made = await g.create(owner(), i, P.create(i));
  assert.equal(made.status, "active");
  assert.match(made.id, /^gr_/);
  const p2 = P.create(i);
  await g.create(owner(), i, p2);
  await assert.rejects(() => g.create(owner(), i, p2), { code: "needs_presence" }, "a proof is used once");
  // a chain holding a model, even [owner, agent] with a valid proof
  await assert.rejects(() => g.create(agentChain("kit"), i, P.create(i)), { code: "chain_not_person" });
  // only an owner or admin gives access; a member does not
  await assert.rejects(() => g.create(personChain(BOB), i, P.create(i)), e => ["not_found", "not_allowed"].includes(e.code));
});

test("grants: events for every change, and rebuild from the log restores the store", async () => {
  const { g, gs, log } = rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const i = input();
  const a = await g.create(owner(), i, P.create(i));
  await g.narrow(owner(), a.id, { actions: [] }, P.narrow(a.id, { actions: [] })).catch(() => {});
  const b = await g.create(owner(), input({ actions: ["records.read", "records.update"] }), P.create(input({ actions: ["records.read", "records.update"] })));
  await g.narrow(owner(), b.id, { actions: ["records.read"] }, P.narrow(b.id, { actions: ["records.read"] }));
  await g.revoke(owner(), a.id, "done", P.revoke(a.id, "done"));
  assert.deepEqual([...new Set(log.read({}).map(e => e.type))].filter(t => /^(grant|member)\./.test(t)).sort(), ["grant.created", "grant.narrowed", "grant.revoked", "member.set"]);
  const before = (await g.list(owner())).map(x => [x.id, x.status, x.actions.join()]);
  gs.rebuild();
  assert.deepEqual((await g.list(owner())).map(x => [x.id, x.status, x.actions.join()]), before);
});

test("grants: widening is a new grant; narrowing is in place and only smaller; revoking a parent revokes its children", async () => {
  const { g, log } = rig();
  await g.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  const parent = input({ subject: { kind: "actor", actor: actor("person", OWNER) }, actions: ["records.read", "records.update"], conditions: { delegate: { allowed: true, max_depth: 2 } } });
  const p = await g.create(owner(), parent, P.create(parent));
  // narrowing in place: smaller only
  await assert.rejects(() => g.narrow(owner(), p.id, { actions: ["records.read", "records.remove"] }, P.narrow(p.id, { actions: ["records.read", "records.remove"] })), { code: "not_contained" });
  await assert.rejects(() => g.narrow(owner(), p.id, { prefix: `vyre://${SPACE}/*/*` }, P.narrow(p.id, { prefix: `vyre://${SPACE}/*/*` })), { code: "not_contained" });
  const narrowed = await g.narrow(owner(), p.id, { actions: ["records.read", "records.update"], fields: ["name"] }, P.narrow(p.id, { actions: ["records.read", "records.update"], fields: ["name"] }));
  assert.deepEqual([...narrowed.resource.fields], ["name"]);
  await assert.rejects(() => g.narrow(owner(), p.id, { fields: ["name", "age"] }, P.narrow(p.id, { fields: ["name", "age"] })), { code: "not_contained" }, "a field list only shrinks");
  // delegation: contained, by the holder only
  const child = input({ subject: { kind: "actor", actor: actor("person", BOB) }, actions: ["records.read"], resource: sel(`vyre://${SPACE}/contact/*`, { fields: ["name"] }), parent: p.id });
  const c = await g.create(owner(), child, P.create(child));
  assert.equal(c.parent, p.id);
  const wider = { ...child, actions: ["records.read", "records.remove"] };
  await assert.rejects(() => g.create(owner(), wider, P.create(wider)), { code: "not_contained" });
  const moreFields = { ...child, resource: sel(`vyre://${SPACE}/contact/*`, { fields: ["name", "age"] }) };
  await assert.rejects(() => g.create(owner(), moreFields, P.create(moreFields)), { code: "not_contained" });
  const notHolder = { ...child };
  await assert.rejects(() => g.create(personChain(ALICE), notHolder, P.create(notHolder)), { code: "not_allowed" });
  await g.revoke(owner(), p.id, "gone", P.revoke(p.id, "gone"));
  assert.deepEqual((await g.list(owner(), { status: "active" })).filter(x => x.id === p.id || x.id === c.id), []);
  assert.equal(log.read({ type: "grant.revoked" }).filter(e => e.data.because === p.id).length, 1, "the child's revoke names its parent");
});

test("roles: bundles instantiate as grants; temp carries scope and expiry; an admin cannot make an admin; a Space keeps an owner", async () => {
  const { g, gw, log } = rig();
  const set = (chain, m) => g.setRole(chain, m, P.role(m));
  await set(owner(), { person: ALICE, role: "admin" });
  await set(owner(), { person: BOB, role: "member" });
  const ap = personChain(ALICE);
  await assert.rejects(() => set(ap, { person: "per_carol", role: "admin" }), { code: "not_allowed" });
  await assert.rejects(() => set(ap, { person: OWNER, role: "member" }), { code: "not_allowed" });
  await set(ap, { person: "per_carol", role: "manager" });
  await assert.rejects(() => set(owner(), { person: OWNER, role: "admin" }), { code: "not_allowed" }, "the only owner stays");
  await assert.rejects(() => set(owner(), { person: "per_t", role: "temp" }), { code: "bad_input" }, "temp needs scope and expiry");
  const exp = T + 100000;
  await set(owner(), { person: "per_t", role: "temp", scope: [`vyre://${SPACE}/contact/c1`], expires: exp });
  assert.equal(gw.members.roleOf(actor("person", BOB)), "member");
  assert.equal(gw.members.isAdmin(actor("person", ALICE)), true);
  assert.equal(gw.members.isAdmin(actor("person", BOB)), false);
  // a member reads and writes records but cannot define types or give access
  await gw.records.define(owner(), { add_types: [CONTACT] });
  await assert.rejects(() => gw.records.define(personChain(BOB), { add_types: [{ name: "x", label: "X", fields: [] }] }), { code: "not_found" });
  const c = await gw.records.create(personChain(BOB), "contact", { name: "Jane" });
  assert.equal(c.data.name, "Jane");
  // a temp reaches only its scope, and only until expiry
  const t = personChain("per_t");
  assert.equal(await gw.records.get(t, "contact", c.id), null);
  T = exp + 10;
  assert.equal(await gw.records.get(t, "contact", c.id), null);
  assert.ok(log.read({ type: "member.set" }).length >= 5);
});

test("grants: list shows an admin everything and anyone else only their own", async () => {
  const { g } = rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const i = input({ subject: { kind: "actor", actor: actor("person", ALICE) } });
  await g.create(owner(), i, P.create(i));
  assert.ok((await g.list(owner())).length >= 3);
  const mine = await g.list(personChain(BOB));
  assert.ok(mine.length >= 1 && mine.every(x => x.subject.actor.id === BOB));
});

test("fields: a grant's allow-list omits other fields on read, refuses writes to them, and stops filters on them", async () => {
  const { g, gw } = rig();
  await gw.records.define(owner(), { add_types: [CONTACT] });
  await g.setRole(owner(), { person: ALICE, role: "member" }, P.role({ person: ALICE, role: "member" }));
  // Alice's member role is broad; give a field-limited grant to an assistant and use it alone
  await g.addActor(owner(), actor("agent", "kit"), P.actor(actor("agent", "kit")));
  const i = input({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read", "records.update"], resource: sel(`vyre://${SPACE}/contact/*`, { fields: ["name", "tags"] }) });
  await g.create(owner(), i, P.create(i));
  const c = await gw.records.create(owner(), "contact", { name: "Jane", age: 41, status: "open" });
  const kit = agentChain("kit");
  // owner is in the agent chain too, so the intersection applies: the narrowest hop wins
  const seen = await gw.records.get(kit, "contact", c.id);
  assert.deepEqual(Object.keys(seen.data), ["name"], "age and status are not allowed, tags is not set");
  const q = await gw.records.query(kit, "contact", { page: { limit: 5 } });
  assert.deepEqual(Object.keys(q.rows[0].data), ["name"]);
  await assert.rejects(() => gw.records.update(kit, "contact", c.id, { age: 99 }, c.version), { code: "field_not_allowed" });
  assert.equal((await gw.records.update(kit, "contact", c.id, { name: "Janet" }, c.version)).data.name, "Janet");
  await assert.rejects(() => gw.records.query(kit, "contact", { filter: { field: "age", op: "eq", value: 41 }, page: { limit: 5 } }), { code: "bad_input" }, "no oracle on an omitted field");
  await assert.rejects(() => gw.records.aggregate(kit, "contact", { group_by: ["status"], measures: [{ fn: "count" }] }), { code: "bad_input" });
  const full = await gw.records.get(owner(), "contact", c.id);
  assert.equal(full.data.age, 41, "the owner alone sees everything");
});

test("fields: a human-level seal hides a field from members outside the chosen roles", async () => {
  const { g, gw } = rig();
  const T2 = { ...CONTACT, name: "deal", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "terms", kind: "sealed", label: "Terms", seal: { level: "human", class: "free", reveal_roles: ["owner", "admin"] } }] };
  await gw.records.define(owner(), { add_types: [T2] });
  await g.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const ref = { sealed: "terms", ref: "sv_9", present: true, valid_format: true, set_at: 1 };
  const d = await gw.records.create(owner(), "deal", { title: "Big", terms: ref });
  assert.ok("terms" in (await gw.records.get(personChain(ALICE), "deal", d.id)).data, "an admin is among the reveal roles");
  assert.ok(!("terms" in (await gw.records.get(personChain(BOB), "deal", d.id)).data), "a member is not: the field is absent, not a placeholder");
  await assert.rejects(() => gw.records.query(personChain(BOB), "deal", { filter: { field: "terms.hint", op: "eq", value: "x" }, page: { limit: 1 } }), { code: "bad_input" });
});
