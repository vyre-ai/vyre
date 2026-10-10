import "../../scripts/mac-test-guard.mjs";
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
  role: m => ({ presence: proof("grants.role", m, `vyre://${SPACE}/member/${m.person || m.remove}`) }),
  actor: a => ({ presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${a.id}`) }),
};

async function rig(wrap, { session = true } = {}) {
  const log = wrap ? wrap(createEventLog({ space: SPACE, clock })) : createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, key: Buffer.alloc(32, 5), presence });
  const store = createMemoryStore({ clock });
  const gw = createGateway({ space: SPACE, store, log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => session });
  await gs.bootstrap({ owner: OWNER });
  return { gw, gs, log, store, g: gw.grants };
}
const sel = (prefix = `vyre://${SPACE}/contact/*`, extra = {}) => ({ prefix, ...extra });
const input = (over = {}) => ({ subject: { kind: "actor", actor: actor("person", BOB) }, actions: ["records.read"], resource: sel(), conditions: {}, source: "test", ...over });

test("grants: a grant is a person's act with a fresh proof bound to this exact input, once, and never from a chain holding a model", async () => {
  const { g, gs } = await rig();
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
  const { g, gs, log } = await rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const i = input();
  const a = await g.create(owner(), i, P.create(i));
  await g.narrow(owner(), a.id, { actions: [] }, P.narrow(a.id, { actions: [] })).catch(() => {});
  const b = await g.create(owner(), input({ actions: ["records.read", "records.update"] }), P.create(input({ actions: ["records.read", "records.update"] })));
  await g.narrow(owner(), b.id, { actions: ["records.read"] }, P.narrow(b.id, { actions: ["records.read"] }));
  await g.revoke(owner(), a.id, "done", P.revoke(a.id, "done"));
  assert.deepEqual([...new Set(log.read({}).map(e => e.type))].filter(t => /^(grant|member)\./.test(t)).sort(), ["grant.created", "grant.narrowed", "grant.revoked", "member.set"]);
  const before = (await g.list(owner())).map(x => [x.id, x.status, x.actions.join()]);
  await gs.rebuild();
  assert.deepEqual((await g.list(owner())).map(x => [x.id, x.status, x.actions.join()]), before);
});

test("grants: widening is a new grant; narrowing is in place and only smaller; revoking a parent revokes its children", async () => {
  const { g, log } = await rig();
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
  const { g, gw, log } = await rig();
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
  const { g } = await rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const i = input({ subject: { kind: "actor", actor: actor("person", ALICE) } });
  await g.create(owner(), i, P.create(i));
  assert.ok((await g.list(owner())).length >= 3);
  const mine = await g.list(personChain(BOB));
  assert.ok(mine.length >= 1 && mine.every(x => x.subject.actor.id === BOB));
});

test("fields: a grant's allow-list omits other fields on read, refuses writes to them, and stops filters on them", async () => {
  const { g, gw } = await rig();
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
  const { g, gw } = await rig();
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

test("offers: the compute pair needs both sides, only for that member's own computer, and revoking either tells the runner at once", async () => {
  const { g, gs } = await rig();
  const set = (m) => g.setRole(owner(), m, P.role(m));
  await set({ person: ALICE, role: "admin" });
  await set({ person: BOB, role: "member" });
  const events = [];
  const off = g.offers.onRevoke(e => events.push(e));
  const mkO = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  const q = { member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" };
  assert.deepEqual(g.offers.active(q), { spaceAllows: false, memberAccepts: false });
  // the member cannot allow it for the Space; an admin cannot accept for the member
  await assert.rejects(() => mkO(personChain(BOB), { side: "space_allows", member: BOB }), { code: "not_allowed" });
  await assert.rejects(() => mkO(personChain(ALICE), { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" }), { code: "not_allowed" });
  const allow = await mkO(personChain(ALICE), { side: "space_allows", member: BOB });
  assert.deepEqual(g.offers.active(q), { spaceAllows: true, memberAccepts: false }, "one side is not enough");
  const accept = await mkO(personChain(BOB), { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.deepEqual(g.offers.active(q), { spaceAllows: true, memberAccepts: true });
  assert.deepEqual(g.offers.active({ member: BOB, device: "dev_other" }), { spaceAllows: true, memberAccepts: false }, "acceptance is per computer");
  assert.deepEqual(g.offers.active({ member: ALICE, device: "dev_laptop", device_key: "KEY_LAPTOP" }), { spaceAllows: false, memberAccepts: false }, "another member's computer is not covered");
  // the member withdraws: told at once; an admin cannot withdraw the member's acceptance
  const un = id => ({ presence: proof("grants.unoffer", { revoke: id }, `vyre://${SPACE}/offer/${id}`) });
  await assert.rejects(() => g.offers.unoffer(personChain(ALICE), accept.id, un(accept.id)), { code: "not_allowed" });
  await g.offers.unoffer(personChain(BOB), accept.id, un(accept.id));
  assert.deepEqual(events.map(e => [e.side, e.reason]), [["member_accepts", "withdrawn"]]);
  assert.equal(g.offers.active(q).memberAccepts, false);
  // the Space's side: a role change tells the runner too, and a non-member has no offer in effect
  await mkO(personChain(BOB), { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  await g.setRole(owner(), { person: BOB, role: "manager" }, P.role({ person: BOB, role: "manager" }));
  assert.ok(events.some(e => e.reason === "role_changed"));
  await g.offers.unoffer(personChain(ALICE), allow.id, un(allow.id));
  assert.equal(g.offers.active(q).spaceAllows, false);
  await gs.rebuild();
  assert.deepEqual(g.offers.active(q), { spaceAllows: false, memberAccepts: true }, "offers survive a rebuild from the log");
  off();
});

test("G-1: an event any chain appends in the grants names is not authority at rebuild; only events the store sealed are", async () => {
  const { g, gs, log } = await rig();
  const stranger = chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  log.append(stranger, { type: "member.set", sv: 1, subject: `vyre://${SPACE}/member/per_evil`, data: { membership: { space: SPACE, person: "per_evil", role: "owner", added_by: "x", added_at: 1 } } });
  log.append(stranger, { type: "grant.created", sv: 1, subject: `vyre://${SPACE}/grant/gr_x`, data: { grant: { id: "gr_x", space: SPACE, subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "forged", status: "active", created_at: 1 } }, mac: "AAAA" });
  await gs.rebuild();
  assert.equal(gs.roleOf(actor("person", "per_evil")), null);
  assert.deepEqual((await g.list(owner())).map(x => x.id).filter(id => id === "gr_x"), []);
  assert.equal(gs.roleOf(actor("person", OWNER)), "owner", "the real history still rebuilds");
  await assert.rejects(async () => gs.bootstrap({ owner: "per_evil" }), { code: "not_allowed" }, "the first owner is made once, at the start");
});

test("G-3: removing a member takes their grants and offers with them, tells the runner, and keeps the last owner", async () => {
  const { g, gs, gw } = await rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  await g.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  const told = [];
  g.offers.onRevoke(e => told.push(e.reason));
  const o = { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" };
  await g.offers.offer(personChain(BOB), o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  const rm = m => g.removeMember(owner(), m, P.role({ remove: m.person }));
  await assert.rejects(() => g.removeMember(owner(), { person: OWNER }, P.role({ remove: OWNER })), { code: "not_allowed" }, "the last owner stays");
  await assert.rejects(() => g.removeMember(personChain(ALICE), { person: OWNER }, P.role({ remove: OWNER })), { code: "not_allowed" }, "an admin cannot remove an owner");
  const r = await rm({ person: BOB });
  assert.ok(r.grants_revoked >= 1);
  assert.equal(gs.roleOf(actor("person", BOB)), null);
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" }).memberAccepts, false);
  assert.deepEqual(told, ["removed"]);
  assert.deepEqual((await g.list(owner(), { status: "active" })).filter(x => x.subject.actor && x.subject.actor.id === BOB), []);
  await gs.rebuild();
  assert.equal(gs.roleOf(actor("person", BOB)), null, "a removal survives a rebuild");
  assert.ok(gw);
});

test("G-2: an event's before and after are cut to the fields the chain may see, by read and by subscribe", async () => {
  const { g, gw } = await rig();
  await gw.records.define(owner(), { add_types: [CONTACT] });
  await g.addActor(owner(), actor("agent", "kit"), P.actor(actor("agent", "kit")));
  const i = input({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read", "events.read"], resource: sel(`vyre://${SPACE}/contact/*`, { fields: ["name"] }) });
  await g.create(owner(), i, P.create(i));
  await gw.records.create(owner(), "contact", { name: "Jane", age: 41, status: "open" });
  const kit = agentChain("kit");
  const ev = (await gw.events.read(kit, { type: "contact.created" }))[0];
  assert.deepEqual(Object.keys(ev.data.after), ["name"]);
  assert.deepEqual(ev.data.changed, ["name"]);
  assert.ok(!/"age"/.test(JSON.stringify(ev.data)) && !/"status"/.test(JSON.stringify(ev.data)), "the cut fields are not in the diff at all");
  const seen = [];
  gw.events.subscribe(kit, "w", { type: "contact.created" }, e => { seen.push(e); });
  for (let i = 0; i < 200 && !seen.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(seen.length >= 1 && seen.every(e => !/"age"/.test(JSON.stringify(e.data))));
  const full = (await gw.events.read(owner(), { type: "contact.created" }))[0];
  assert.equal(full.data.after.age, 41, "the owner sees the whole diff");
});


test("G-1b: a genuine event appended again does not bring back a revoked grant or a removed member (the MAC binds the position)", async () => {
  const { g, gs, log } = await rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const i = input();
  const made = await g.create(owner(), i, P.create(i));
  await g.revoke(owner(), made.id, "gone", P.revoke(made.id, "gone"));
  await g.removeMember(owner(), { person: BOB }, P.role({ remove: BOB }));
  assert.equal(gs.roleOf(actor("person", BOB)), null);
  // copy the genuine, validly sealed events and append them again with a chain that has log access
  const replay = chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  for (const e of log.read({}).filter(x => x.type === "grant.created" || x.type === "member.set")) log.append(replay, { type: e.type, sv: 1, subject: e.subject, data: e.data });
  await gs.rebuild();
  assert.equal(gs.roleOf(actor("person", BOB)), null, "the removed person stays removed");
  assert.deepEqual((await g.list(owner(), { status: "active" })).filter(x => x.id === made.id), [], "the revoked grant stays revoked");
  assert.equal(gs.roleOf(actor("person", OWNER)), "owner");
});

test("G-4: an acceptance is bound to the computer's key; a second machine naming the same id, or no key, does not claim it", async () => {
  const { g } = await rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const mkO = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  await mkO(owner(), { side: "space_allows", member: BOB });
  await assert.rejects(() => mkO(personChain(BOB), { side: "member_accepts", member: BOB, device: "dev_laptop" }), { code: "bad_input" }, "an acceptance names its computer's key");
  await mkO(personChain(BOB), { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_A" });
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_A" }).memberAccepts, true);
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_B" }).memberAccepts, false, "another machine, same id");
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop" }).memberAccepts, false, "a bare id is not enough");
});


const inviteProof = (action, input, resource) => proof(action, input, resource);
test("invites: an admin approves once; the invitee accepts alone with their own proof; single use, exact contents, expiry, and a second confirmation for admin and owner", async () => {
  const { g, gs, log } = await rig();
  const inv = async (chain, i) => g.invites.create(chain, i, { presence: inviteProof("grants.invite", i, `vyre://${SPACE}/invite/new`) });
  const guest = who => chains.fromFacts({ kind: "invitee", person: who, vouched: true });
  const acceptP = (i, who) => ({ op: "grant.accept", fields: { invite: i.id, hash: i.hash, person: who }, n: Math.random() });
  const seen = i => ({ role: i.role, scope: i.scope, expires: i.expires, invitee: i.invitee });
  // an invite for a member
  const i1 = await inv(owner(), { role: "member" });
  assert.equal(i1.status, "pending");
  assert.equal(gs.roleOf(actor("person", BOB)), null);
  await assert.rejects(() => g.invites.accept(guest(BOB), i1.id, { seen: seen(i1), proof: {} }), { code: "needs_presence" }, "no proof of their own");
  await assert.rejects(() => g.invites.accept(guest(BOB), i1.id, { seen: { ...seen(i1), role: "admin" }, proof: acceptP(i1, BOB) }), { code: "contents_differ" }, "not what was approved");
  const done = await g.invites.accept(guest(BOB), i1.id, { seen: seen(i1), proof: acceptP(i1, BOB) });
  assert.equal(done.membership.role, "member");
  assert.equal(gs.roleOf(actor("person", BOB)), "member", "applied with no admin present");
  await assert.rejects(() => g.invites.accept(guest("per_carol"), i1.id, { seen: seen(i1), proof: acceptP(i1, "per_carol") }), { code: "not_found" }, "single use");
  // a named invitee, and expiry
  const i2 = await inv(owner(), { role: "member", invitee: "per_dave" });
  await assert.rejects(() => g.invites.accept(guest("per_carol"), i2.id, { seen: seen(i2), proof: acceptP(i2, "per_carol") }), { code: "not_found" });
  const i3 = await inv(owner(), { role: "member", valid_ms: 1000 });
  T += 5000;
  await assert.rejects(() => g.invites.accept(guest("per_erin"), i3.id, { seen: seen(i3), proof: acceptP(i3, "per_erin") }), { code: "expired" });
  // an admin invite stays pending until the inviter confirms the fingerprint words
  const i4 = await inv(owner(), { role: "admin" });
  assert.equal(i4.needs_confirm, true);
  await assert.rejects(() => g.invites.accept(guest("per_frank"), i4.id, { seen: seen(i4), proof: acceptP(i4, "per_frank") }), { code: "needs_confirmation" });
  await g.invites.confirm(owner(), i4.id, { words: "amber tiger" }, { presence: inviteProof("grants.invite", { confirm: i4.id, words: "amber tiger" }, `vyre://${SPACE}/invite/${i4.id}`) });
  assert.equal((await g.invites.accept(guest("per_frank"), i4.id, { seen: seen(i4), proof: acceptP(i4, "per_frank") })).membership.role, "admin");
  // a member cannot invite anyone, an admin cannot invite an admin
  await assert.rejects(() => inv(personChain(BOB), { role: "member" }), e => ["not_found", "not_allowed"].includes(e.code));
  await assert.rejects(() => inv(personChain("per_frank"), { role: "admin" }), { code: "not_allowed" });
  // an invitee chain that is not accepting anything finds nothing
  await assert.rejects(() => g.list(guest("per_zed")), { code: "not_found" });
  // survives a rebuild: used stays used, memberships stay
  await gs.rebuild();
  assert.equal(gs.roleOf(actor("person", BOB)), "member");
  await assert.rejects(() => g.invites.accept(guest("per_gina"), i1.id, { seen: seen(i1), proof: acceptP(i1, "per_gina") }), { code: "not_found" });
  assert.ok(log.read({ type: "invite.created" }).length >= 4);
});

test("expiry sweep: expired grants and temp memberships are revoked by the kernel itself, only ever reducing power, and the runner is told", async () => {
  const { g, gs } = await rig();
  const exp = T + 60_000;
  const role = { person: "per_temp", role: "temp", scope: [`vyre://${SPACE}/contact/c1`], expires: exp };
  await g.setRole(owner(), role, P.role(role));
  const told = [];
  g.offers.onRevoke(e => told.push(e.reason));
  const withExp = input({ subject: { kind: "actor", actor: actor("person", ALICE) }, conditions: { when: { expires: exp } } });
  await g.create(owner(), withExp, P.create(withExp));
  assert.deepEqual(await gs.sweep(), { revoked: 0, removed: 0 }, "nothing expired yet");
  T = exp + 10;
  const r = await gs.sweep();
  assert.ok(r.revoked >= 2 && r.removed === 1, JSON.stringify(r));
  assert.equal(gs.roleOf(actor("person", "per_temp")), null);
  assert.deepEqual((await g.list(owner(), { status: "active" })).filter(x => x.conditions.when && x.conditions.when.expires === exp), []);
  assert.deepEqual(await gs.sweep(), { revoked: 0, removed: 0 }, "idempotent");
  await gs.rebuild();
  assert.equal(gs.roleOf(actor("person", "per_temp")), null);
});

test("installModule: a first-party module becomes a service actor with exactly the actions its manifest declared, kernel-only and idempotent", async () => {
  const { gs, gw } = await rig();
  await gw.records.define(owner(), { add_types: [CONTACT] });
  const svc = () => gw.serviceChain("goals");
  assert.equal(await gw.records.get(svc(), "contact", "0190c3f2-1111-4abc-8def-000000000000"), null, "no membership, no access");
  await gs.installModule("goals", { actions: ["records.read", "records.create"], prefixes: ["contact/*"] });
  const c = await gw.records.create(svc(), "contact", { name: "From the module" });
  assert.equal(c.data.name, "From the module");
  await assert.rejects(() => gw.records.update(svc(), "contact", c.id, { age: 1 }, 1), { code: "not_found" }, "only what it declared");
  const before = (await gw.grants.list(owner())).length;
  await gs.installModule("goals", { actions: ["records.read", "records.create"], prefixes: ["contact/*"] });
  assert.equal((await gw.grants.list(owner())).length, before, "idempotent");
  await gs.rebuild();
  assert.ok(await gw.records.get(svc(), "contact", c.id));
});

test("grants reads: members.list, members.get, invites.get and grants.list show a chain only what it may see", async () => {
  const { g } = await rig();
  await g.setRole(owner(), { person: ALICE, role: "manager" }, P.role({ person: ALICE, role: "manager" }));
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  assert.deepEqual((await g.members.list(owner())).map(m => m.person).sort(), [ALICE, BOB, OWNER].sort(), "the owner sees everyone");
  assert.equal((await g.members.list(personChain(ALICE))).length, 3, "a manager sees everyone");
  assert.deepEqual((await g.members.list(personChain(BOB))).map(m => m.person), [BOB], "a member sees only themselves");
  assert.equal((await g.members.get(personChain(BOB), BOB)).role, "member");
  await assert.rejects(() => g.members.get(personChain(BOB), ALICE), { code: "not_found" });
  await assert.rejects(() => g.members.get(owner(), "per_nobody"), { code: "not_found" }, "indistinguishable from a person you may not see");
  await assert.rejects(() => g.members.list(personChain("per_stranger")), { code: "not_found" }, "a non-member sees nothing");
  await assert.rejects(() => g.members.list(agentChain("kit")), { code: "not_found" }, "never a chain holding a model");
  // grants.list: a manager sees all, a member only theirs
  assert.ok((await g.list(personChain(ALICE))).length > (await g.list(personChain(BOB))).length);
  assert.ok((await g.list(personChain(BOB))).every(x => x.subject.actor.id === BOB));
  // the join card
  const open = await g.invites.create(owner(), { role: "member" }, { presence: proof("grants.invite", { role: "member" }, `vyre://${SPACE}/invite/new`) });
  const forEve = await g.invites.create(owner(), { role: "member", invitee: "per_eve" }, { presence: proof("grants.invite", { role: "member", invitee: "per_eve" }, `vyre://${SPACE}/invite/new`) });
  const card = await g.invites.get(personChain("per_stranger"), open.id);
  assert.deepEqual(Object.keys(card).sort(), ["confirmed", "expires", "id", "invitee", "needs_confirm", "role", "scope", "space", "status", "valid_until"]);
  assert.equal(card.status, "pending");
  assert.equal(card.space.id, SPACE);
  assert.equal((await g.invites.get(personChain("per_eve"), forEve.id)).invitee, "per_eve");
  await assert.rejects(() => g.invites.get(personChain("per_stranger"), forEve.id), { code: "not_found" }, "another person's invite");
  await assert.rejects(() => g.invites.get(personChain("per_stranger"), "inv_nope"), { code: "not_found" });
  await assert.rejects(() => g.invites.get(agentChain("kit"), open.id), { code: "not_found" });
  assert.equal((await g.invites.get(owner(), forEve.id)).id, forEve.id, "the issuer reads it");
  assert.equal((await g.invites.get(personChain(BOB), forEve.id).catch(e => e.code)), "not_found", "a plain member does not read others' invites");
});

test("owner.changed carries the owner op for the identity chain, visible to the Space and nothing else", async () => {
  const { g, log } = await rig();
  await g.setRole(owner(), { person: ALICE, role: "owner" }, P.role({ person: ALICE, role: "owner" }));
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  await g.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  await g.setRole(owner(), { person: BOB, role: "manager" }, P.role({ person: BOB, role: "manager" }));
  const ev = log.read({}).filter(e => e.type === "owner.changed");
  const oc = ev.map(e => e.data.owner_change);
  assert.deepEqual(oc.map(o => [o.op, o.person]), [["add", OWNER], ["add", ALICE], ["remove", ALICE]], "only ownership changes carry an op");
  assert.equal(oc[1].by, OWNER); assert.equal(oc[1].space, SPACE);
  assert.ok(ev.every(e => e.vis === "space"));
  assert.ok(log.read({}).filter(e => e.type === "member.set").every(e => e.vis === "owner" && e.data.owner_change === undefined));
  await g.setRole(owner(), { person: ALICE, role: "owner" }, P.role({ person: ALICE, role: "owner" }));
  await g.removeMember(owner(), { person: ALICE }, P.role({ remove: ALICE }));
  const gone = log.read({}).filter(e => e.type === "owner.changed").pop();
  assert.equal(gone.data.owner_change.op, "remove");
});

test("transferOwner: one proof hands the Space on; a failure between the two steps leaves two owners and a repeat finishes it", async () => {
  let fail = false, sets = 0;
  const { g } = await rig(real => ({ ...real, append: (c, e, ...r) => { if (fail && e.type === "member.set" && ++sets === 2) throw new Error("killed"); return real.append(c, e, ...r); } }));
  const mk = to => ({ presence: proof("grants.role", { transfer: { to, demote_to: "admin" } }, `vyre://${SPACE}/member/${to}`) });
  await g.setRole(owner(), { person: ALICE, role: "member" }, P.role({ person: ALICE, role: "member" }));
  const owners = async () => (await g.members.list(owner())).filter(m => m.role === "owner").map(m => m.person).sort();
  await assert.rejects(() => g.transferOwner(owner(), { to: ALICE }), { code: "needs_presence" });
  await assert.rejects(() => g.transferOwner(personChain(ALICE), { to: OWNER }, mk(OWNER)), e => ["not_found", "not_allowed"].includes(e.code), "a member does not hand on the Space");
  await assert.rejects(() => g.transferOwner(owner(), { to: "per_nobody" }, mk("per_nobody")), { code: "not_found" });
  // T-1: every argument is checked before the first step: a bad demote_to leaves nobody promoted
  for (const bad of ["temp", "owner", "nonsense", 7]) await assert.rejects(() => g.transferOwner(owner(), { to: ALICE, demote_to: bad }, { presence: proof("grants.role", { transfer: { to: ALICE, demote_to: bad } }, `vyre://${SPACE}/member/${ALICE}`) }), { code: "bad_input" }, `demote_to ${bad}`);
  assert.deepEqual(await owners(), [OWNER], "nobody was promoted by a refused hand-over");
  // the second step dies (the process is killed after the new owner is made)
  fail = true;
  await assert.rejects(() => g.transferOwner(owner(), { to: ALICE }, mk(ALICE)), /killed/);
  fail = false;
  assert.deepEqual(await owners(), [ALICE, OWNER].sort(), "two owners, never none");
  assert.equal((await g.members.list(personChain(ALICE))).length, 2, "the new owner holds the Space in full");
  // a repeat (a fresh proof) does only the second step
  const done = await g.transferOwner(owner(), { to: ALICE }, mk(ALICE));
  assert.equal(done.previous_role, "admin");
  assert.deepEqual(await owners(), [ALICE]);
  assert.equal((await g.members.get(personChain(ALICE), OWNER)).role, "admin");
});

test("R4: every state-changing call that fails while writing its sealed event leaves memory showing the OLD state and tells the caller it failed", async () => {
  let fail = false;
  const { g, gs, log } = await rig(real => ({ ...real, append: (c, e, ...r) => { if (fail && e.type !== "grants.snapshot") throw new Error("killed"); return real.append(c, e, ...r); } }));
  const down = async f => { fail = true; try { await assert.rejects(f, /killed/); } finally { fail = false; } };
  const members = async () => (await g.members.list(owner())).map(m => `${m.person}:${m.role}`).sort();
  await g.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const base = await members();
  const grantsNow = async () => JSON.stringify((await g.list(owner())).map(x => [x.id, x.status, x.actions.length, x.resource.prefix, x.resource.fields || null]));
  const g0 = await grantsNow();
  const i = input();
  // create
  await down(() => g.create(owner(), i, P.create(i)));
  assert.equal(await grantsNow(), g0, "create: nothing was created");
  const made = await g.create(owner(), i, P.create(i));
  const g1 = await grantsNow();
  // narrow
  await down(() => g.narrow(owner(), made.id, { actions: ["records.read"] }, P.narrow(made.id, { actions: ["records.read"] })));
  assert.equal(await grantsNow(), g1, "narrow: the grant is as wide as before");
  // revoke: the worst case, a revoke that undoes itself
  await down(() => g.revoke(owner(), made.id, "no", P.revoke(made.id, "no")));
  assert.equal(await grantsNow(), g1, "revoke: the grant is still active, and the caller was told it failed");
  assert.equal((await g.list(owner())).find(x => x.id === made.id).status, "active");
  // setRole
  await down(() => g.setRole(owner(), { person: BOB, role: "admin" }, P.role({ person: BOB, role: "admin" })));
  assert.deepEqual(await members(), base, "setRole: bob is still a member");
  assert.equal(await grantsNow(), g1);
  // removeMember
  await down(() => g.removeMember(owner(), { person: BOB }, P.role({ remove: BOB })));
  assert.deepEqual(await members(), base, "removeMember: bob is still a member");
  assert.equal(await grantsNow(), g1);
  // addActor
  const kit = actor("agent", "kit");
  await down(() => g.addActor(owner(), kit, P.actor(kit)));
  assert.equal(gs.members.has(kit), false, "addActor: no such actor");
  // offer, unoffer
  const q = { member: BOB, device: "dev1" };
  const o1 = { side: "space_allows", member: BOB, device: "dev1" };
  await down(() => g.offers.offer(owner(), o1, { presence: proof("grants.offer", o1, `vyre://${SPACE}/offer/new`) }));
  assert.deepEqual(g.offers.active(q), { spaceAllows: false, memberAccepts: false }, "offer: nothing offered");
  const off = await g.offers.offer(owner(), o1, { presence: proof("grants.offer", o1, `vyre://${SPACE}/offer/new`) });
  assert.equal(g.offers.active(q).spaceAllows, true);
  await down(() => g.offers.unoffer(owner(), off.id, { presence: proof("grants.unoffer", { revoke: off.id }, `vyre://${SPACE}/offer/${off.id}`) }));
  assert.equal(g.offers.active(q).spaceAllows, true, "unoffer: the offer is still active");
  // invites: create, confirm, accept
  const ip = (action, inp, res) => ({ presence: proof(action, inp, res) });
  const ic = { role: "admin" };
  await down(() => g.invites.create(owner(), ic, ip("grants.invite", ic, `vyre://${SPACE}/invite/new`)));
  const inv = await g.invites.create(owner(), ic, ip("grants.invite", ic, `vyre://${SPACE}/invite/new`));
  const cf = { confirm: inv.id, words: "amber tiger" };
  await down(() => g.invites.confirm(owner(), inv.id, { words: "amber tiger" }, ip("grants.invite", cf, `vyre://${SPACE}/invite/${inv.id}`)));
  assert.equal((await g.invites.get(owner(), inv.id)).confirmed, false, "confirm: still unconfirmed");
  await g.invites.confirm(owner(), inv.id, { words: "amber tiger" }, ip("grants.invite", cf, `vyre://${SPACE}/invite/${inv.id}`));
  const guest = chains.fromFacts({ kind: "invitee", person: "per_frank", vouched: true });
  const seen = { role: inv.role, scope: inv.scope, expires: inv.expires, invitee: inv.invitee };
  const acc = () => ({ op: "grant.accept", fields: { invite: inv.id, hash: inv.hash, person: "per_frank" }, n: Math.random() });
  await down(() => g.invites.accept(guest, inv.id, { seen, proof: acc() }));
  assert.deepEqual(await members(), base, "accept: frank did not join");
  assert.equal((await g.invites.get(guest, inv.id)).status, "pending", "accept: the invite is still unused");
  assert.equal((await g.invites.accept(guest, inv.id, { seen, proof: acc() })).membership.role, "admin");
  // sweep (the kernel's own clean-up of expired power)
  const t = { person: "per_tina", role: "temp", scope: [`vyre://${SPACE}/contact/*`], expires: T + 1000 };
  await g.setRole(owner(), t, P.role(t));
  T += 5000;
  const before = await members();
  await down(() => g.sweep());
  assert.deepEqual(await members(), before, "sweep: the expired member is still listed until the sweep is written");
  assert.equal((await g.sweep()).removed >= 1, true);
  void log;
});

// WF-1 (reviewer-2): a change is written to the log FIRST and applied in memory second, so a sealing process that fails under the event leaves memory as it was, and a rebuild from the log agrees.
import { createKernelSeal } from "../core/seal.js";
test("WF-1: a seal.mac that rejects once leaves the store exactly as it was, and a rebuild from the log agrees, after each of revoke, removeMember, setRole, adoptOwner, bootstrap and chatChange", async () => {
  const real = createKernelSeal({ key: Buffer.alloc(32, 5) });
  let fails = 0;
  const seal = { sync: false, verify: real.verify, verifyMany: real.verifyMany, mac: async (p, d) => { if (fails > 0) { fails--; throw new Error("the sealing process is restarting"); } return real.mac(p, d); } };
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, seal, presence });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true });
  /** The state a reader sees: every grant's status, the members and their roles, the chats. */
  const view = () => JSON.stringify({ grants: [...gs.list(owner ? undefined : undefined) || []] });
  void view;
  const shape = async () => JSON.stringify({ members: gs.members.list ? await gs.members.list(owner()) : null, owner: gs.adopted() });
  void shape;
  const snap = () => capture(gs);
  async function capture(g) { return JSON.stringify({ roles: ["per_owner", ALICE, BOB].map(p => g.roleOf({ kind: "person", id: p, space: SPACE })), active: (await g.list(owner())).filter(x => x.status === "active").map(x => x.id).sort(), adopted: g.adopted() }); }
  const againstRebuild = async (what) => { const live = await snap(); await gs.rebuild(); assert.equal(await snap(), live, `${what}: a rebuild from the log agrees with the live store`); return live; };
  // bootstrap fails once: nothing is made, then it works
  fails = 1;
  await assert.rejects(() => gs.bootstrap({ owner: OWNER }), /sealing process/);
  assert.equal(gs.roleOf({ kind: "person", id: OWNER, space: SPACE }), null, "a failed bootstrap leaves no owner in memory");
  await gs.bootstrap({ owner: OWNER });
  await gw.grants.setRole(owner(), { person: ALICE, role: "admin" }, P.role({ person: ALICE, role: "admin" }));
  await gw.grants.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const made = await gw.grants.create(owner(), input(), P.create(input()));
  let at = await againstRebuild("after setup");
  // revoke
  fails = 1;
  await assert.rejects(() => gw.grants.revoke(owner(), made.id, "leaked", P.revoke(made.id, "leaked")), /sealing process/);
  assert.equal(await snap(), at, "a failed revoke changed nothing in memory");
  await againstRebuild("failed revoke");
  // setRole
  fails = 1;
  await assert.rejects(() => gw.grants.setRole(owner(), { person: BOB, role: "admin" }, P.role({ person: BOB, role: "admin" })), /sealing process/);
  assert.equal(await snap(), at, "a failed setRole changed nothing");
  await againstRebuild("failed setRole");
  // removeMember
  fails = 1;
  await assert.rejects(() => gw.grants.removeMember(owner(), { person: BOB }, P.role({ remove: BOB })), /sealing process/);
  assert.equal(await snap(), at, "a failed removeMember changed nothing: BOB is still a member");
  await againstRebuild("failed removeMember");
  // a chat change
  const chat = await gw.grants.chats.create(owner(), { people: [ALICE] });
  fails = 1;
  await assert.rejects(() => gw.grants.chats.change(owner(), chat.id, { add_people: [BOB] }), /sealing process/);
  assert.deepEqual(gs.chatPeopleAt(chat.id, chat.ver), [OWNER, ALICE].sort().length ? gs.chatPeopleAt(chat.id, chat.ver) : null);
  assert.equal(gs.chatVersion(chat.id).ver, chat.ver, "a failed chat change did not move the room's version");
  await againstRebuild("failed chat change");
  // adoptOwner (a change of several events: the marker first, then the moves; the log decides)
  const NEW = "per_cccccccccccccccccccccccccc";
  fails = 1;
  await assert.rejects(() => gs.adoptOwner(NEW, OWNER), /sealing process/);
  assert.equal(gs.adopted(), null, "a failed adoption left no marker in memory");
  await againstRebuild("failed adoption");
  // and each of them, once the sealing process is back, works
  await gw.grants.revoke(owner(), made.id, "leaked", P.revoke(made.id, "leaked"));
  await againstRebuild("revoke after the failure");
});

test("AO-3: a crash right after the owner.adopted marker (the owner moved only in part) is finished by the next adoptOwner with the same id, and a rebuild agrees; another id is still refused", async () => {
  const real = createKernelSeal({ key: Buffer.alloc(32, 5) });
  let allow = Infinity;
  const seal = { sync: false, verify: real.verify, verifyMany: real.verifyMany, mac: async (p, d) => { if (allow <= 0) throw new Error("the process died"); allow--; return real.mac(p, d); } };
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, seal, presence });
  await gs.bootstrap({ owner: OWNER });
  const NEW = "per_cccccccccccccccccccccccccc", OTHER = "per_dddddddddddddddddddddddddd";
  const role = p => gs.roleOf({ kind: "person", id: p, space: SPACE });
  allow = 1; // the marker is sealed and written, then the process dies
  await assert.rejects(() => gs.adoptOwner(NEW, OWNER), /process died/);
  allow = Infinity;
  assert.deepEqual(gs.adopted(), { from: OWNER, to: NEW }, "the marker is in the log and in memory");
  assert.equal(role(OWNER), "owner", "the move did not happen");
  assert.equal(role(NEW), null);
  await assert.rejects(() => gs.adoptOwner(OTHER, OWNER), { code: "already_adopted" }, "a different id is refused while the first is unfinished");
  // a restart: the rebuild reads the marker, and the boot repair (kernel/index.js) calls adoptOwner with it
  await gs.rebuild();
  assert.deepEqual(gs.adopted(), { from: OWNER, to: NEW });
  const done = await gs.adoptOwner(NEW, OWNER);
  assert.deepEqual(done, { owner: NEW, previous: OWNER, changed: true });
  assert.equal(role(NEW), "owner"); assert.equal(role(OWNER), null);
  assert.equal(log.read({ type: "owner.adopted" }).length, 1, "the marker is not written twice");
  const live = JSON.stringify([role(NEW), role(OWNER)]);
  await gs.rebuild();
  assert.equal(JSON.stringify([role(NEW), role(OWNER)]), live, "a rebuild agrees");
  assert.deepEqual(await gs.adoptOwner(NEW, OWNER), { owner: NEW, previous: OWNER, changed: false });
});

test("lend (ruling 5 Oct): the first lend takes ONE proof bound to the compound act and makes both sides; the proof covers nothing else; taking it away needs only a live session", async () => {
  const { g } = await rig();
  const set = m => g.setRole(owner(), m, P.role(m));
  await set({ person: ALICE, role: "admin" });
  await set({ person: BOB, role: "member" });
  const lendProof = o => ({ presence: proof("grants.offer", { lend: { member: o.member, device: o.device, device_key: o.device_key, network_cap: o.network_cap ?? null } }, `vyre://${SPACE}/offer/lend`) });
  const q = (member, device, device_key) => ({ member, device, device_key });
  // a member lends their own computer: their side only, with one proof
  const b = { member: BOB, device: "dev_laptop", device_key: "KEY_B" };
  assert.equal((await g.offers.lend(personChain(BOB), b, lendProof(b))).offers.length, 1);
  assert.deepEqual(g.offers.active(q(BOB, "dev_laptop", "KEY_B")), { spaceAllows: false, memberAccepts: true });
  // an owner or admin lending their own computer: the Space's side and their own, ONE proof
  const a = { member: ALICE, device: "dev_alice", device_key: "KEY_A" };
  const made = await g.offers.lend(personChain(ALICE), a, lendProof(a));
  assert.deepEqual(made.offers.map(o => o.side).sort(), ["member_accepts", "space_allows"]);
  assert.deepEqual(g.offers.active(q(ALICE, "dev_alice", "KEY_A")), { spaceAllows: true, memberAccepts: true });
  // the proof is for this act only: another device, another member, a replay, no proof, and someone else's computer are all refused
  const c = { member: ALICE, device: "dev_other", device_key: "KEY_C" };
  const forA = lendProof(a);
  await assert.rejects(() => g.offers.lend(personChain(ALICE), c, forA));
  await assert.rejects(() => g.offers.lend(personChain(ALICE), c, {}));
  const once = lendProof(c);
  await g.offers.lend(personChain(ALICE), c, once);
  await assert.rejects(() => g.offers.lend(personChain(ALICE), { ...c, device: "dev_third" }, once), "a spent proof is not reusable");
  await assert.rejects(() => g.offers.lend(personChain(ALICE), { member: BOB, device: "dev_x", device_key: "K" }, lendProof({ member: BOB, device: "dev_x", device_key: "K" })), { code: "not_allowed" });
  // taking it away: no fresh proof, a live session is enough, and it withdraws both sides
  const told = [];
  const off = g.offers.onRevoke(e => told.push(e.side));
  assert.deepEqual(await g.offers.unlend(personChain(ALICE), { member: ALICE, device: "dev_alice" }), { withdrawn: 2 });
  assert.deepEqual(g.offers.active(q(ALICE, "dev_alice", "KEY_A")), { spaceAllows: false, memberAccepts: false });
  assert.deepEqual(told.sort(), ["member_accepts", "space_allows"], "the runner is told at once");
  assert.deepEqual(await g.offers.unlend(personChain(BOB), { member: BOB, device: "dev_laptop" }), { withdrawn: 1 });
  // a member cannot withdraw the Space's side of someone else's computer
  assert.deepEqual(await g.offers.unlend(personChain(BOB), { member: ALICE, device: "dev_other" }), { withdrawn: 0 });
  off();
});

test("lend (ruling 5 Oct, one rule c328cd1): a person withdraws with no session, and a model's chain cannot lend or withdraw", async () => {
  const { g } = await rig(undefined, { session: false });
  const set = m => g.setRole(owner(), m, P.role(m));
  await set({ person: BOB, role: "member" });
  const b = { member: BOB, device: "dev_laptop", device_key: "KEY_B" };
  const pr = { presence: proof("grants.offer", { lend: { member: BOB, device: "dev_laptop", device_key: "KEY_B", network_cap: null } }, `vyre://${SPACE}/offer/lend`) };
  await g.offers.lend(personChain(BOB), b, pr);
  await assert.rejects(() => g.offers.unlend(agentChain("juno"), { member: BOB, device: "dev_laptop" }));
  await assert.rejects(() => g.offers.lend(agentChain("juno"), b, pr));
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_B" }).memberAccepts, true, "a model's chain moved nothing");
  // one permission rule (ruling c328cd1): the member's own chain withdraws with no session
  await g.offers.unlend(personChain(BOB), { member: BOB, device: "dev_laptop" });
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_B" }).memberAccepts, false, "withdrawn by the person");
});

test("lend (ruling 5 Oct): after the member's own off, on again needs only the live session; after anyone else's off, a removal or a role change it is a first grant and takes the proof again; a rebuild keeps the difference", async () => {
  const { g, gs } = await rig();
  const set = m => g.setRole(owner(), m, P.role(m));
  await set({ person: ALICE, role: "admin" });
  await set({ person: BOB, role: "member" });
  const l = { member: BOB, device: "dev_laptop", device_key: "KEY_B" };
  const withProof = { presence: proof("grants.offer", { lend: { ...l, network_cap: l.network_cap ?? null } }, `vyre://${SPACE}/offer/lend`) };
  await g.offers.lend(personChain(BOB), l, withProof);
  await g.offers.unlend(personChain(BOB), { member: BOB, device: "dev_laptop" });
  // the person's own off: on again with no proof at all
  await g.offers.lend(personChain(BOB), l, {});
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_B" }).memberAccepts, true);
  await gs.rebuild();
  await g.offers.unlend(personChain(BOB), { member: BOB, device: "dev_laptop" });
  await gs.rebuild();
  await g.offers.lend(personChain(BOB), l, {});
  // an admin's off of the member's side: the next lend is a first grant again
  await g.offers.unlend(personChain(ALICE), { member: BOB, device: "dev_laptop" });
  await assert.rejects(() => g.offers.lend(personChain(BOB), l, {}), "needs the proof again");
  await gs.rebuild();
  await assert.rejects(() => g.offers.lend(personChain(BOB), l, {}), "and still after a rebuild");
  await g.offers.lend(personChain(BOB), l, { presence: proof("grants.offer", { lend: { ...l, network_cap: l.network_cap ?? null } }, `vyre://${SPACE}/offer/lend`) });
  // removing the member ends the offer without their own act: back in, it is a first grant again
  await g.removeMember(owner(), { person: BOB }, P.role({ remove: BOB }));
  await set({ person: BOB, role: "member" });
  assert.equal(g.offers.active({ member: BOB, device: "dev_laptop", device_key: "KEY_B" }).memberAccepts, false);
  await assert.rejects(() => g.offers.lend(personChain(BOB), l, {}));
  // a different computer key is a different grant
  await assert.rejects(() => g.offers.lend(personChain(BOB), { ...l, device_key: "OTHER" }, {}));
});

test("lender's cap (reviewer-2 CAP-1..3): the lend proof binds the cap (stated or not stated), the tightest live cap wins, and a lend with another cap on an accepted computer is refused", async () => {
  const { g } = await rig();
  await g.setRole(owner(), { person: BOB, role: "member" }, P.role({ person: BOB, role: "member" }));
  const lp = o => ({ presence: proof("grants.offer", { lend: { member: o.member, device: o.device, device_key: o.device_key, network_cap: o.network_cap ?? null } }, `vyre://${SPACE}/offer/lend`) });
  const base = { member: BOB, device: "dev_a", device_key: "KEY_A" };
  // CAP-1: a proof made for one cap is refused for another and for none; an invalid cap is bad_input
  await assert.rejects(() => g.offers.lend(personChain(BOB), { ...base, network_cap: "internet" }, lp({ ...base, network_cap: "provider" })), "a proof for provider is refused for internet");
  await assert.rejects(() => g.offers.lend(personChain(BOB), base, lp({ ...base, network_cap: "provider" })), "a proof for provider is refused for none stated");
  await assert.rejects(() => g.offers.lend(personChain(BOB), { ...base, network_cap: "provider" }, lp(base)), "a proof for none stated is refused for provider");
  await assert.rejects(() => g.offers.lend(personChain(BOB), { ...base, network_cap: "everything" }, lp({ ...base, network_cap: "everything" })), { code: "bad_input" });
  await g.offers.lend(personChain(BOB), { ...base, network_cap: "provider" }, lp({ ...base, network_cap: "provider" }));
  assert.equal(g.offers.capOf({ member: BOB, device: "dev_a" }), "provider");
  // CAP-3: lending the accepted computer again with another cap (or none) is refused with a plain message, never silently kept at the old one
  await assert.rejects(() => g.offers.lend(personChain(BOB), { ...base, network_cap: "internet" }, lp({ ...base, network_cap: "internet" })), /different network limit/);
  // a lend that states no limit inherits the floor this computer was lent with (ruled 10 Oct): it is the same lend again, not a change, and the limit stays
  await g.offers.lend(personChain(BOB), base, lp(base));
  assert.equal(g.offers.capOf({ member: BOB, device: "dev_a" }), "provider", "stating none keeps the old limit");
  // CAP-2: the tightest live cap wins, whatever the order, and an acceptance that states none never loosens one that does
  const x = { side: "member_accepts", member: BOB, device: "dev_b", device_key: "KEY_B" };
  const offer = (o) => g.offers.offer(personChain(BOB), o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  await offer(x); assert.equal(g.offers.capOf({ member: BOB, device: "dev_b" }), undefined);
  await offer({ ...x, network_cap: "internet" }); assert.equal(g.offers.capOf({ member: BOB, device: "dev_b" }), "internet");
  await offer({ ...x, network_cap: "provider" }); assert.equal(g.offers.capOf({ member: BOB, device: "dev_b" }), "provider");
  await offer(x); assert.equal(g.offers.capOf({ member: BOB, device: "dev_b" }), "provider", "a later acceptance with none stated does not loosen it");
});
