import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { isUuid, timeOf } from "../core/ids.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const agent = () => chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
let n = 0;
const G = (over = {}) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor("person", OWNER) }, actions: ["records.*", "records.define", "events.read"], action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0, ...over });

function rig({ grants = [G()], store = createMemoryStore({ clock }), attrs, members = [], ...cfg } = {}) {
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, ...members]);
  const gw = createGateway({
    space: SPACE, store, log, chains, clock, attrs,
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) },
    hasPresenceSession: () => true, ...cfg,
  });
  return { gw, log, store, r: gw.records };
}
const withType = async rg => { await rg.r.define(owner(), { add_types: [CONTACT] }); return rg; };
const ref = { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 };

test("gateway: create mints a time-prefixed id, the store keeps it, and one event says who did it", async () => {
  const { r, log } = await withType(rig());
  const c = await r.create(owner(), "contact", { name: "Jane", ssn: ref });
  assert.ok(isUuid(c.id) && timeOf(c.id) > 0);
  assert.equal(c.version, 1);
  assert.equal(c.urn, `vyre://${SPACE}/contact/${c.id}`);
  const ev = log.read({ type: "contact.created" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, `person:${OWNER}@${SPACE}`);
  assert.equal(ev[0].subject, c.urn);
  assert.deepEqual(ev[0].data.after.ssn, { sealed: true, changed: true }, "the log never holds the sealed reference");
  assert.equal(ev[0].red, "pii");
  assert.equal(ev[0].prov.decision.startsWith("dec_"), true);
  assert.equal((await r.get(owner(), "contact", c.id)).data.name, "Jane");
});

test("gateway: update and remove carry a diff, check the version, and restore comes back", async () => {
  const { r, log } = await withType(rig());
  const c = await r.create(owner(), "contact", { name: "Jane", age: 40 });
  const u = await r.update(owner(), "contact", c.id, { age: 41 }, 1);
  assert.equal(u.version, 2);
  const e = log.read({ type: "contact.updated" })[0];
  assert.deepEqual(e.data.changed, ["age"]);
  assert.equal(e.data.before.age, 40);
  assert.equal(e.data.after.age, 41);
  await assert.rejects(() => r.update(owner(), "contact", c.id, { age: 5 }, 1), { code: "version_conflict" });
  assert.equal(log.read({ type: "contact.updated" }).length, 1, "a refused write writes no event");
  await r.remove(owner(), "contact", c.id, 2);
  assert.equal(await r.get(owner(), "contact", c.id), null);
  assert.equal((await r.restore(owner(), "contact", c.id)).version, 4);
  assert.deepEqual(log.read().map(e => e.type), ["types.defined", "contact.created", "contact.updated", "contact.removed", "contact.restored"]);
  assert.deepEqual(await gwAudit(r, log), { ok: true });
});
const gwAudit = async (r, log) => ({ ok: log.verify().ok && r.openIntents() === 0 });

test("gateway: a hand-made chain is refused, and a deny looks like absence while the log keeps the truth", async () => {
  const { r, log } = await withType(rig({ grants: [G()] }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  await assert.rejects(() => r.get({ hops: [], space: SPACE }, "contact", c.id), { code: "bad_input" });
  const stranger = chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  assert.equal(await r.get(stranger, "contact", c.id), null, "no grant for the agent: it sees nothing");
  await assert.rejects(() => r.update(stranger, "contact", c.id, { name: "x" }, 1), e => e.code === "not_found" && e.hidden_reason === "not_a_member");
  assert.ok(log.read({ type: "access.denied" }).length >= 1);
  assert.equal((await r.get(owner(), "contact", c.id)).data.name, "Jane", "the refused write changed nothing");
});

test("gateway: the gateway filters rows itself; a store that ignores the grant cannot leak, in a list, a total or a search", async () => {
  const proj = new Map();
  const attrs = urn => ({ project: proj.get(urn) || "p9" });
  const g = G({ resource: { prefix: `vyre://${SPACE}/contact/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } });
  const ownerAll = G({ actions: ["records.create", "records.define"] });
  const rg = await withType(rig({ grants: [ownerAll, g], attrs }));
  const { r } = rg;
  for (let i = 0; i < 6; i++) { const c = await r.create(owner(), "contact", { name: `Harlow ${i}`, age: i }); if (i % 2 === 0) proj.set(c.urn, "p1"); }
  const q = await r.query(owner(), "contact", { sort: [{ field: "age", dir: "asc" }], page: { limit: 2 } });
  assert.deepEqual(q.rows.map(x => x.data.age), [0], "page of two from the store, one visible");
  assert.ok(q.next_cursor);
  const all = [];
  let cursor;
  do { const p = await r.query(owner(), "contact", { sort: [{ field: "age", dir: "asc" }], page: { limit: 2, ...(cursor ? { cursor } : {}) } }); all.push(...p.rows.map(x => x.data.age)); cursor = p.next_cursor; } while (cursor);
  assert.deepEqual(all, [0, 2, 4]);
  const tot = await r.aggregate(owner(), "contact", { measures: [{ fn: "count" }, { fn: "sum", field: "age" }] });
  assert.deepEqual(tot[0].values, { count: 3, "sum:age": 6 }, "the total counts only what the caller may see");
  const hits = await r.search(owner(), { text: "harlow", page: { limit: 50 } });
  assert.equal(hits.rows.length, 3);
});

test("gateway: a store that returns rows of another type or a different id is not believed", async () => {
  const inner = createMemoryStore({ clock });
  const liar = { ...inner, async query(t, s) { const p = await inner.query(t, s); return { ...p, rows: [...p.rows, { type: "secret", id: "0190c3f2-1111-4abc-8def-000000000000", version: 1, data: {}, created_at: 1, updated_at: 1 }] }; } };
  const { r } = await withType(rig({ store: liar }));
  await r.create(owner(), "contact", { name: "Jane" });
  const p = await r.query(owner(), "contact", { page: { limit: 10 } });
  assert.equal(p.rows.length, 1);
  const forger = { ...inner, async create(t, id, d) { const rec = await inner.create(t, id, d); return { ...rec, id: id.slice(0, -1) + (id.endsWith("0") ? "1" : "0") }; } };
  const bad = await withType(rig({ store: forger }));
  await assert.rejects(() => bad.r.create(owner(), "contact", { name: "x" }), { code: "id_mismatch" });
  assert.equal(bad.r.openIntents(), 0);
  assert.equal(bad.log.read({ type: "contact.created" }).length, 0);
});

test("gateway: a record changed or made outside the gateway comes back labelled external and modified_outside", async () => {
  const { r, store, gw } = await withType(rig());
  const c = await r.create(owner(), "contact", { name: "Jane" });
  assert.equal((await r.get(owner(), "contact", c.id)).modified_outside, undefined);
  assert.equal((await r.get(owner(), "contact", c.id)).labels.trust, "member");
  await store.update("contact", c.id, { name: "Mallory" }, 1);
  const g = await r.get(owner(), "contact", c.id);
  assert.equal(g.modified_outside, true);
  assert.equal(g.labels.trust, "external");
  const rogue = await store.create("contact", "0190c3f2-2222-4abc-8def-000000000001", { name: "Planted" });
  assert.equal((await r.get(owner(), "contact", rogue.id)).modified_outside, true);
  // a gateway write after it records the new truth; a restart rebuilds the index from the log
  const again = await r.update(owner(), "contact", c.id, { name: "Jane Doe" }, 2);
  assert.equal(again.modified_outside, undefined);
  r.rebuild();
  assert.equal((await r.get(owner(), "contact", c.id)).modified_outside, undefined);
  assert.equal((await gw.audit.verify()).ok, true);
});

test("gateway: a lost answer leaves an intent open; recovery writes the missing event, or closes it as nothing happened", async () => {
  const inner = createMemoryStore({ clock });
  let mode = "ok";
  const flaky = new Proxy(inner, { get: (t, k) => (k === "create" ? async (...a) => { if (mode === "before") throw Object.assign(new Error("down"), { code: "unavailable" }); const rec = await t.create(...a); if (mode === "after") throw Object.assign(new Error("lost"), { code: "unavailable" }); return rec; } : t[k]) });
  const { r, log, gw } = await withType(rig({ store: flaky }));
  mode = "after";
  await assert.rejects(() => r.create(owner(), "contact", { name: "Applied" }), { code: "unavailable" });
  mode = "before";
  await assert.rejects(() => r.create(owner(), "contact", { name: "Never" }), { code: "unavailable" });
  mode = "ok";
  assert.equal(r.openIntents(), 2);
  assert.equal((await gw.audit.verify()).open_intents, 2);
  assert.equal(log.read({ type: "contact.created" }).length, 0, "nothing is claimed until the truth is known");
  assert.deepEqual(await r.recover(), { completed: 1, compensated: 1, still_open: 0, unresolved: 0 });
  assert.equal(r.openIntents(), 0);
  const ev = log.read({ type: "contact.created" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.recovered, true);
  assert.equal(ev[0].actor, `person:${OWNER}@${SPACE}`, "the event names who did it, from the chain stored with the intent");
  assert.equal(ev[0].data.after.name, "Applied");
});

test("gateway: a definite refusal closes the intent as compensated and writes no event", async () => {
  const { r, log } = await withType(rig());
  const c = await r.create(owner(), "contact", { name: "Jane" });
  await assert.rejects(() => r.update(owner(), "contact", c.id, { name: "x" }, 9), { code: "version_conflict" });
  await assert.rejects(() => r.create(owner(), "contact", { name: "x", ssn: "123-45-6789" }), { code: "sealed_value_refused" });
  assert.equal(r.openIntents(), 0);
  assert.deepEqual(r.intents().map(i => i.state), ["completed", "compensated", "compensated"]);
  assert.equal(log.read({ type: "contact.created" }).length, 1);
});

test("gateway: a model in the chain gets placeholders for sealed fields, a person gets the reference", async () => {
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"] })];
  const { r } = await withType(rig({ grants, members: ["agent:kit"] }));
  const c = await r.create(owner(), "contact", { name: "Jane", ssn: ref });
  const asModel = await r.get(agent(), "contact", c.id);
  assert.deepEqual(asModel.data.ssn, { sealed: "ssn", present: true, valid_format: true });
  assert.equal("ref" in asModel.data.ssn, false);
  assert.equal((await r.get(owner(), "contact", c.id)).data.ssn.ref, "sv_1");
  const listed = await r.query(agent(), "contact", { page: { limit: 5 } });
  assert.equal("ref" in listed.rows[0].data.ssn, false);
});

test("gateway: an action that needs presence or approval does not run, and says what it needs", async () => {
  const g = G({ actions: ["records.create"], conditions: { how: { presence: "fresh" } } });
  let session = true;
  const { r, log } = await withType(rig({ grants: [G({ actions: ["records.define"] }), g], hasPresenceSession: () => session }));
  session = false;
  await assert.rejects(() => r.create(owner(), "contact", { name: "x" }), e => e.code === "needs_presence" && e.decision.startsWith("dec_") && e.obligations.some(o => o.type === "presence"));
  assert.equal(log.read({ type: "contact.created" }).length, 0);
  assert.equal(r.openIntents(), 0);
});

test("gateway: changing types is admin work: it needs a presence session, and the change is logged", async () => {
  const noSession = rig({ hasPresenceSession: () => false });
  await assert.rejects(() => noSession.r.define(owner(), { add_types: [CONTACT] }), { code: "needs_presence" });
  const { r, log } = rig();
  const res = await r.define(owner(), { add_types: [CONTACT] });
  assert.equal(res.applied, true);
  assert.equal(log.read({ type: "types.defined" })[0].data.changes[0], "added type contact");
  await r.define(owner(), { add_types: [CONTACT] });
  assert.equal(log.read({ type: "types.defined" }).length, 1, "a no-op diff writes no event");
  await assert.rejects(() => r.define(owner(), { add_types: [{ name: "Bad Name", label: "x", fields: [] }] }), { code: "bad_input" });
});

test("gateway: the log verifies after a mixed run and health reports the store", async () => {
  const { r, gw } = await withType(rig());
  for (let i = 0; i < 10; i++) { const c = await r.create(owner(), "contact", { name: `n${i}` }); await r.update(owner(), "contact", c.id, { age: i }, 1); }
  assert.deepEqual(await gw.audit.verify(), { ok: true, events: 21, open_intents: 0 });
  assert.deepEqual(await gw.health(), { ok: true, versions: { memory: "1" } });
});

// ---- K2 gate fixes (reviewer-2 probes) ----
const agentGrants = actions => [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions })];

test("K2-1: a chain holding a model cannot filter, sort, group or measure on a sealed field or its sub-fields", async () => {
  const { r } = await withType(rig({ grants: agentGrants(["records.read"]), members: ["agent:kit"] }));
  await r.create(owner(), "contact", { name: "Jane", ssn: { ...ref, hint: "last4 6789" } });
  const probes = [
    { filter: { field: "ssn.hint", op: "eq", value: "last4 6789" } },
    { filter: { field: "ssn.hint", op: "contains", value: "6789" } },
    { filter: { and: [{ field: "name", op: "eq", value: "Jane" }, { not: { field: "ssn", op: "is_null" } }] } },
    { sort: [{ field: "ssn.hint", dir: "asc" }] },
  ];
  for (const p of probes) await assert.rejects(() => r.query(agent(), "contact", { ...p, page: { limit: 5 } }), { code: "bad_input" }, JSON.stringify(p));
  await assert.rejects(() => r.aggregate(agent(), "contact", { group_by: ["ssn.hint"], measures: [{ fn: "count" }] }), { code: "bad_input" });
  await assert.rejects(() => r.aggregate(agent(), "contact", { measures: [{ fn: "count", field: "ssn" }] }), { code: "bad_input" });
  assert.equal((await r.query(agent(), "contact", { filter: { field: "name", op: "eq", value: "Jane" }, page: { limit: 5 } })).rows.length, 1, "an ordinary field still works");
  assert.equal((await r.query(owner(), "contact", { filter: { field: "ssn.hint", op: "eq", value: "last4 6789" }, page: { limit: 5 } })).rows.length, 1, "a person's own chain may");
});

test("K2-1: a store that cannot describe its types gets no model queries by field", async () => {
  const inner = createMemoryStore({ clock });
  const blind = new Proxy(inner, { get: (t, k) => (k === "describe" ? undefined : t[k]) });
  const { r } = await withType(rig({ store: blind, grants: agentGrants(["records.read"]), members: ["agent:kit"] }));
  await assert.rejects(() => r.query(agent(), "contact", { filter: { field: "name", op: "eq", value: "x" }, page: { limit: 5 } }), { code: "unsupported" });
  assert.equal((await r.query(agent(), "contact", { page: { limit: 5 } })).rows.length, 0, "no field named, nothing to guard");
});

test("K2-4: recovery completes only on an exact match, and never writes another person's change as the lost one", async () => {
  const inner = createMemoryStore({ clock });
  let lose = false;
  const flaky = new Proxy(inner, { get: (t, k) => (k === "update" ? async (...a) => { if (lose) throw Object.assign(new Error("lost"), { code: "unavailable" }); return t.update(...a); } : t[k]) });
  const { r, log } = await withType(rig({ store: flaky }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  lose = true;
  await assert.rejects(() => r.update(owner(), "contact", c.id, { age: 1 }, 1), { code: "unavailable" });
  lose = false;
  await inner.update("contact", c.id, { age: 99 }, 1);
  assert.deepEqual(await r.recover(), { completed: 0, compensated: 0, still_open: 0, unresolved: 1 });
  assert.equal(log.read({ type: "contact.updated" }).length, 0, "someone else's change is not claimed");
  assert.equal(r.openIntents(), 0);
  // The exact change did land: it completes, attributed from the intent's own chain.
  lose = true;
  await assert.rejects(() => r.update(owner(), "contact", c.id, { age: 5 }, 2), { code: "unavailable" });
  lose = false;
  await inner.update("contact", c.id, { age: 5 }, 2);
  assert.equal((await r.recover()).completed, 1);
  assert.equal(log.read({ type: "contact.updated" })[0].data.recovered, true);
});

test("K2-6: events.read and subscribe go through authorize and vis", async () => {
  const { gw, r, log } = await withType(rig({ owner: OWNER, grants: [...agentGrants(["records.read", "events.read"]).slice(0, 1), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["events.read", "records.read"], resource: { prefix: `vyre://${SPACE}/contact/*` } })], members: ["agent:kit"] }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  log.append(owner(), { type: "note.added", sv: 1, subject: `vyre://${SPACE}/contact/${c.id}`, vis: "owner", data: {} });
  log.append(owner(), { type: "note.added", sv: 1, subject: `vyre://${SPACE}/matter/m1`, data: {} });
  const mine = await gw.events.read(owner(), {});
  assert.ok(mine.length >= 4);
  const theirs = await gw.events.read(agent(), {});
  assert.deepEqual(theirs.map(e => e.type), ["contact.created"], "no read on the matter, and the owner-only note stays hidden");
  const seen = [];
  gw.events.subscribe(agent(), "watch", {}, e => { seen.push(e.type); });
  await new Promise(res => setTimeout(res, 20));
  assert.deepEqual([...new Set(seen)], ["contact.created"]);
  await assert.rejects(() => gw.events.read({ hops: [] }, {}), { code: "bad_input" });
});

test("K2-8: odd types and ids are refused on every call", async () => {
  const { r } = await withType(rig());
  for (const t of ["Contact", "../x", "a b", "", 5]) {
    await assert.rejects(() => r.get(owner(), t, "0190c3f2-1111-4abc-8def-000000000000"), { code: "bad_input" });
    await assert.rejects(() => r.query(owner(), t, { page: { limit: 1 } }), { code: "bad_input" });
    await assert.rejects(() => r.aggregate(owner(), t, { measures: [{ fn: "count" }] }), { code: "bad_input" });
  }
  for (const i of ["../x", "1", "", "%2e%2e", 7]) await assert.rejects(() => r.get(owner(), "contact", i), { code: "bad_input" });
  await assert.rejects(() => r.search(owner(), { text: "x", types: ["Bad"], page: { limit: 1 } }), { code: "bad_input" });
});

test("K2-5: a store that alters a field, or returns a stale version, is caught and nothing is recorded as done", async () => {
  const inner = createMemoryStore({ clock });
  let bad = null;
  const liar = new Proxy(inner, { get: (t, k) => (k === "create" ? async (...a) => { const r = await t.create(...a); return bad === "drop" ? { ...r, data: { ...r.data, name: "Changed" } } : r; } : k === "update" ? async (...a) => { const r = await t.update(...a); return bad === "stale" ? { ...r, version: a[3] } : r; } : t[k]) });
  const { r, log } = await withType(rig({ store: liar }));
  bad = "drop";
  await assert.rejects(() => r.create(owner(), "contact", { name: "Jane" }), { code: "store_disagreed" });
  assert.equal(log.read({ type: "contact.created" }).length, 0);
  assert.equal(log.read({ type: "store.disagreed" }).length, 1);
  bad = null;
  const c = await r.create(owner(), "contact", { name: "Jane" });
  bad = "stale";
  await assert.rejects(() => r.update(owner(), "contact", c.id, { age: 3 }, 1), { code: "store_disagreed" });
  assert.equal(r.openIntents(), 0);
});

test("K2-7: row policy reads kernel attributes the gateway wrote; a record it did not write has none and never matches", async () => {
  const where = [{ attr: "sensitivity", op: "ne", value: "privileged" }];
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*`, where } })];
  const store = createMemoryStore({ clock });
  const { r } = await withType(rig({ grants, members: ["agent:kit"], store }));
  const open = await r.create(owner(), "contact", { name: "Open" }, { attrs: { sensitivity: "internal" } });
  const secret = await r.create(owner(), "contact", { name: "Secret" }, { attrs: { sensitivity: "privileged" } });
  const foreign = await store.create("contact", "0190c3f2-1111-4abc-8def-0000000000ff", { name: "Foreign" });
  assert.equal((await r.get(agent(), "contact", open.id)).data.name, "Open");
  assert.equal(await r.get(agent(), "contact", secret.id), null);
  assert.equal(await r.get(agent(), "contact", foreign.id), null, "no kernel attributes, so a predicate does not match (not ne)");
  await assert.rejects(() => r.create(owner(), "contact", { name: "x" }, { attrs: { created_by: "forged" } }), { code: "bad_input" });
});

test("K2-10: no cursor when only rows the chain cannot read remain", async () => {
  const where = [{ attr: "sensitivity", op: "eq", value: "internal" }];
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*`, where } })];
  const { r } = await withType(rig({ grants, members: ["agent:kit"] }));
  await r.create(owner(), "contact", { name: "a" }, { attrs: { sensitivity: "internal" } });
  for (let i = 0; i < 3; i++) await r.create(owner(), "contact", { name: `hidden${i}` }, { attrs: { sensitivity: "privileged" } });
  const q = await r.query(agent(), "contact", { sort: [{ field: "name", dir: "asc" }], page: { limit: 1 } });
  assert.equal(q.rows.length, 1);
  assert.equal(q.next_cursor, undefined, "the hidden rows after it do not make a cursor");
  assert.equal((await r.query(owner(), "contact", { page: { limit: 1 } })).next_cursor !== undefined, true);
});

test("K1-9b: audit.verify also checks each kept event against its commitment", async () => {
  const { r, gw, log } = await withType(rig());
  await r.create(owner(), "contact", { name: "Jane" });
  assert.equal((await gw.audit.verify()).ok, true);
  assert.equal(log.proves(log.read({ type: "contact.created" })[0].seq), true);
  log.erase(log.read({ type: "contact.created" })[0].seq);
  assert.equal((await gw.audit.verify()).ok, true, "an erased event keeps only its envelope and still verifies");
});

test("R2-1: an agent with events.read but no records.read cannot read record values from the log, by read or subscribe", async () => {
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["events.read"] })];
  const { gw, r } = await withType(rig({ grants, members: ["agent:kit"], owner: OWNER }));
  await r.create(owner(), "contact", { name: "SecretName" });
  assert.ok(!JSON.stringify(await gw.events.read(agent(), {})).includes("SecretName"));
  assert.deepEqual((await gw.events.read(agent(), {})).filter(e => e.type.startsWith("contact.")), []);
  const seen = [];
  gw.events.subscribe(agent(), "w", {}, e => { seen.push(e); });
  await new Promise(res => setTimeout(res, 20));
  assert.deepEqual(seen.filter(e => e.type.startsWith("contact.")), []);
  assert.ok(JSON.stringify(await gw.events.read(owner(), {})).includes("SecretName"), "a person who may read it still can");
});

test("kernel facade: definitions go through authorize, the action registry and members are readable, a service chain is the kernel's", async () => {
  const { gw } = await withType(rig({ grants: agentGrants(["records.read"]).concat([]), members: ["agent:kit"] }));
  assert.deepEqual((await gw.definitions(owner())).map(t => t.name), ["contact"]);
  assert.deepEqual((await gw.definitions(agent())).map(t => t.name), ["contact"], "an assistant with records.read sees the types");
  const rogue = chains.fromFacts({ kind: "agent_session", agent: "rogue", session: "s", thread: "t", vouched: true });
  await assert.rejects(() => gw.definitions(rogue), { code: "not_found" });
  assert.ok(gw.actions().some(a => a.action === "records.read" && a.risk === "read") && gw.actions().some(a => a.action === "seal.use"));
  assert.equal(gw.members.isAdmin(actor("person", OWNER)), false, "no membership source configured");
  const svc = gw.serviceChain("memory");
  assert.equal(svc.hops[svc.hops.length - 1].actor.id, "memory");
});

// ---- once, rate and meter (K1-8c-b) ----
const limited = conditions => { const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], conditions })]; return grants; };

test("limits: a `once` grant carries one act, taken atomically", async () => {
  const { r, gw } = await withType(rig({ grants: limited({ once: true }), members: ["agent:kit"] }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  const results = await Promise.allSettled([r.get(agent(), "contact", c.id), r.get(agent(), "contact", c.id), r.get(agent(), "contact", c.id)]);
  assert.equal(results.filter(x => x.status === "fulfilled" && x.value).length, 1);
  assert.deepEqual(results.filter(x => x.status === "rejected").map(x => x.reason.code), ["used_up", "used_up"]);
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "used_up" });
  gw.limits.rebuild();
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "used_up" }, "the mark is in the log, so a restart does not give the use back");
});

test("limits: `rate` is a window per grant and actor", async () => {
  const { r } = await withType(rig({ grants: limited({ rate: { n: 2, per_seconds: 60 } }), members: ["agent:kit"] }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  assert.ok(await r.get(agent(), "contact", c.id));
  assert.ok(await r.get(agent(), "contact", c.id));
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "rate_limited" });
  await assert.rejects(() => r.query(agent(), "contact", { page: { limit: 1 } }), { code: "rate_limited" }, "a query is one counted act too");
  assert.ok(await r.get(owner(), "contact", c.id), "the owner has no rate");
  T += 61_000;
  assert.ok(await r.get(agent(), "contact", c.id), "the window moves on");
});

test("limits: a budget meter stops at its limit, reserves and settles with events, and survives a rebuild", async () => {
  const { r, log, gw } = await withType(rig({ grants: limited({ budget: { meter: "calls", limit: 2 } }), members: ["agent:kit"] }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  await r.get(agent(), "contact", c.id); await r.get(agent(), "contact", c.id);
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "budget_exhausted" });
  assert.equal(log.read({ type: "meter.reserved" }).length, 2);
  assert.equal(log.read({ type: "meter.settled" }).length, 2);
  gw.limits.rebuild();
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "budget_exhausted" });
});

test("limits: the model door's ai_spend and session hours reserve, settle the actual cost and refuse past the limit", async () => {
  const { gw, log } = rig();
  const L = gw.limits;
  const chain = owner();
  const b = L.doorBudget({ limitOf: () => 1000, estimate: () => 400, cost: (i, u) => u.cost_micro });
  const call1 = { chain }, call2 = { chain }, call3 = { chain };
  assert.equal(b.reserve(call1), null);
  assert.equal(b.reserve(call2), null);
  assert.equal(b.reserve(call3), "ai_spend", "two holds of 400 leave no room for a third of 400 against 1000");
  b.settle(call1, { cost_micro: 100 });
  assert.equal(b.reserve(call3), null, "the first call cost 100, not 400, so the room is back");
  assert.deepEqual(L.used(OWNER, "ai_spend"), { settled: 100, reserved: 800 });
  const id = L.sessionStart(chain, { person: OWNER, limit_hours: 10, max_hours: 6 });
  assert.throws(() => L.sessionStart(chain, { person: OWNER, limit_hours: 10, max_hours: 6 }), { code: "budget_exhausted" });
  L.sessionEnd(chain, id, 2);
  assert.deepEqual(L.used(OWNER, "session_hours"), { settled: 2, reserved: 0 });
  assert.ok(log.read({ type: "meter.settled" }).some(e => e.data.meter === "session_hours" && e.data.actual === 2));
});

test("fields: a grant with row predicates and a field allow-list still refuses filters on omitted fields", async () => {
  const where = [{ attr: "sensitivity", op: "ne", value: "privileged" }];
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*`, where, fields: ["name"] } })];
  const { r } = await withType(rig({ grants, members: ["agent:kit"] }));
  await r.create(owner(), "contact", { name: "Jane", age: 41 }, { attrs: { sensitivity: "internal" } });
  await assert.rejects(() => r.query(agent(), "contact", { filter: { field: "age", op: "eq", value: 41 }, page: { limit: 5 } }), { code: "bad_input" });
  await assert.rejects(() => r.query(agent(), "contact", { sort: [{ field: "age", dir: "asc" }], page: { limit: 5 } }), { code: "bad_input" });
  await assert.rejects(() => r.aggregate(agent(), "contact", { group_by: ["age"], measures: [{ fn: "count" }] }), { code: "bad_input" });
  assert.equal((await r.query(agent(), "contact", { filter: { field: "name", op: "eq", value: "Jane" }, page: { limit: 5 } })).rows.length, 1, "an allowed field still filters");
});

// ---- stage gates ----
import { parseExpr, evalExpr } from "../../records/language/expr.js";
const DEAL = { name: "deal", label: "Deal", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "signed", kind: "boolean", label: "Signed" }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Drafting", "Done"] }],
  stages: [{ name: "Intake", tasks: [{ title: "Research", required: true }, { title: "Optional chat" }] }, { name: "Drafting" }, { name: "Done" }],
  rules: [{ name: "signed_before_drafting", require: "stage < 'Drafting' or signed == true" }] };

test("stage gates: a record cannot enter a stage unless its rules hold, and cannot leave one while its required tasks are open", async () => {
  const done = new Set();
  const entered = [];
  const { r } = rig({ expr: { parseExpr, evalExpr }, stageTasks: (record, stage) => (stage === "Intake" ? [{ title: "Research", state: done.has(record) ? "done" : "working" }, { title: "Optional chat", state: "ready" }] : []), onStageEnter: e => { entered.push([e.stage, e.templates.map(t => t.title)]); } });
  await r.define(owner(), { add_types: [DEAL] });
  const d = await r.create(owner(), "deal", { title: "A", stage: "Intake", signed: false });
  assert.deepEqual(entered, [["Intake", ["Research", "Optional chat"]]], "entering a stage hands its task templates to the tasks side");
  // the rule: not signed, no Drafting
  await assert.rejects(() => r.update(owner(), "deal", d.id, { stage: "Drafting" }, d.version), { code: "rule_failed" });
  // signed, but the required Intake task is open
  const s = await r.update(owner(), "deal", d.id, { signed: true }, d.version);
  await assert.rejects(() => r.update(owner(), "deal", d.id, { stage: "Drafting" }, s.version), { code: "stage_tasks_open" });
  done.add(`vyre://${SPACE}/deal/${d.id}`);
  const moved = await r.update(owner(), "deal", d.id, { stage: "Drafting" }, s.version);
  assert.equal(moved.data.stage, "Drafting");
  // a non-stage edit never trips the gate
  assert.equal((await r.update(owner(), "deal", d.id, { title: "B" }, moved.version)).data.title, "B");
  // a create straight into Drafting is a new entry: the rule judges it
  await assert.rejects(() => r.create(owner(), "deal", { title: "C", stage: "Drafting", signed: false }), { code: "rule_failed" });
});

test("stage gates: fail closed when rules exist and no evaluator is wired", async () => {
  const { r } = rig();
  await r.define(owner(), { add_types: [DEAL] });
  await assert.rejects(() => r.create(owner(), "deal", { title: "A", stage: "Intake" }), { code: "unavailable" });
});
