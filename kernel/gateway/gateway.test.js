import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { isUuid, timeOf, mintUuid } from "../core/ids.js";
import { CONTACT } from "../conformance/suite.js";
import { CONTACT as CONTACT_CORE, ORGANIZATION as ORG_CORE, PARTICIPANT as PARTICIPANT_CORE } from "../../records/core-types.js";

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

test("gateway: a total has no row cap, and a row the caller may not read is not counted at any size", async () => {
  const hidden = new Set();
  const attrs = urn => ({ project: hidden.has(urn) ? "p9" : "p1" });
  const g = G({ resource: { prefix: `vyre://${SPACE}/contact/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } });
  const ownerAll = G({ actions: ["records.create", "records.define"] });
  const { r, store } = await withType(rig({ grants: [ownerAll, g], attrs }));
  const N = 20_700;
  for (let i = 0; i < N; i++) { const id = mintUuid(); await store.create("contact", id, { name: `n${i}`, age: 1, status: i % 2 ? "open" : "closed" }); if (i % 7 === 0) hidden.add(`vyre://${SPACE}/contact/${id}`); }
  const seen = N - hidden.size;
  const tot = await r.aggregate(owner(), "contact", { measures: [{ fn: "count" }, { fn: "sum", field: "age" }] });
  assert.deepEqual(tot[0].values, { count: seen, "sum:age": seen });
  const by = await r.aggregate(owner(), "contact", { group_by: ["status"], measures: [{ fn: "count" }] });
  assert.equal(by.reduce((a, x) => a + x.values.count, 0), seen);
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

test("BL-3: on the built-in store a record's attributes are the create event's, so editing kernel_attrs on disk changes nothing", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createSqliteStore } = await import("../store/sqlite.js");
  const { createSqliteEventLog } = await import("../store/sqlite-log.js");
  const where = [{ attr: "sensitivity", op: "ne", value: "privileged" }];
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*`, where } })];
  const db = new DatabaseSync(":memory:");
  const store = createSqliteStore({ db, clock });
  const log = createSqliteEventLog({ db, space: SPACE, clock });
  const gw = createGateway({ space: SPACE, store, log, chains, clock, grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => grants.find(g => g.id === id) }, members: { has: a => `${a.kind}:${a.id}` === `person:${OWNER}` || `${a.kind}:${a.id}` === "agent:kit" }, hasPresenceSession: () => true });
  const r = gw.records;
  await r.define(owner(), { add_types: [CONTACT] });
  const secret = await r.create(owner(), "contact", { name: "Secret" }, { attrs: { sensitivity: "privileged" } });
  assert.equal(await r.get(agent(), "contact", secret.id), null);
  // the write to the database: the record is now "internal" on disk
  db.prepare("UPDATE kernel_attrs SET attrs = json_set(attrs, '$.sensitivity', 'internal') WHERE urn = ?").run(secret.urn);
  assert.equal(JSON.parse(db.prepare("SELECT attrs FROM kernel_attrs WHERE urn = ?").get(secret.urn).attrs).sensitivity, "internal");
  // a fresh gateway over the same database (a restart, so no cache): the log wins and the disk copy is repaired
  const gw2 = createGateway({ space: SPACE, store: createSqliteStore({ db, clock }), log: createSqliteEventLog({ db, space: SPACE, clock }), chains, clock, grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => grants.find(g => g.id === id) }, members: { has: a => `${a.kind}:${a.id}` === `person:${OWNER}` || `${a.kind}:${a.id}` === "agent:kit" }, hasPresenceSession: () => true });
  assert.equal(await gw2.records.get(agent(), "contact", secret.id), null, "still hidden");
  assert.equal(gw2.records.attrsOf(secret.urn).sensitivity, "privileged");
  assert.equal(JSON.parse(db.prepare("SELECT attrs FROM kernel_attrs WHERE urn = ?").get(secret.urn).attrs).sensitivity, "privileged", "the disk copy was repaired from the log");
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
  const { r, gw } = await withType(rig({ grants: limited({ rate: { n: 2, per_seconds: 60 } }), members: ["agent:kit"] }));
  const c = await r.create(owner(), "contact", { name: "Jane" });
  assert.ok(await r.get(agent(), "contact", c.id));
  assert.ok(await r.get(agent(), "contact", c.id));
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "rate_limited" });
  await assert.rejects(() => r.query(agent(), "contact", { page: { limit: 1 } }), { code: "rate_limited" }, "a query is one counted act too");
  assert.ok(await r.get(owner(), "contact", c.id), "the owner has no rate");
  gw.limits.rebuild();
  await assert.rejects(() => r.get(agent(), "contact", c.id), { code: "rate_limited" }, "a restart does not reset the window");
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

test("search: a caller with a field limit cannot find a record by text in a field outside the limit", async () => {
  const grants = [G(), G({ subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*`, fields: ["name"] } })];
  const { r } = await withType(rig({ grants, members: ["agent:kit"] }));
  await r.create(owner(), "contact", { name: "Jane Harlow", status: "closed" });
  assert.equal((await r.search(agent(), { text: "harlow", page: { limit: 5 } })).rows.length, 1, "an allowed field finds it");
  assert.equal((await r.search(agent(), { text: "closed", page: { limit: 5 } })).rows.length, 0, "a field outside the limit does not");
  assert.equal((await r.search(owner(), { text: "closed", page: { limit: 5 } })).rows.length, 1, "the unlimited owner still does");
});

test("kind: a type may say it holds work (project), nothing else, and the definition returns it", async () => {
  const { r, gw } = await withType(rig());
  const t = { name: "campaign", label: "Campaign", kind: "project", fields: [{ name: "title", kind: "text", label: "Title" }] };
  await assert.rejects(() => r.define(owner(), { add_types: [{ ...t, name: "other", kind: "board" }] }), { code: "bad_input" });
  await r.define(owner(), { add_types: [t] });
  assert.equal((await gw.definitions(owner())).find(x => x.name === "campaign").kind, "project");
});

test("linked: the reverse of a link, across types, only what the caller may read, capped by limit", async () => {
  const hidden = new Set();
  const attrs = urn => ({ project: hidden.has(urn) ? "p9" : "p1" });
  const g = G({ resource: { prefix: `vyre://${SPACE}/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } });
  const { r } = await withType(rig({ grants: [G({ actions: ["records.create", "records.define"] }), g], attrs }));
  await r.define(owner(), { add_types: [roleType("client"), { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "client", kind: "link", to: "contact", label: "Client" }] }] });
  const jane = await r.create(owner(), "contact", { name: "Jane" }), bob = await r.create(owner(), "contact", { name: "Bob" });
  const m1 = await r.create(owner(), "matter", { title: "A", client: { urn: jane.urn } }), m2 = await r.create(owner(), "matter", { title: "B", client: { urn: jane.urn } });
  await r.create(owner(), "matter", { title: "C", client: { urn: bob.urn } });
  const c1 = await r.create(owner(), "client", { contact: { urn: jane.urn }, stage: "Active" });
  const all = await r.linked(owner(), jane.urn);
  assert.deepEqual(all.rows.map(x => `${x.type}.${x.field}`).sort(), ["client.contact", "matter.client", "matter.client"]);
  assert.equal(all.truncated, false);
  assert.deepEqual((await r.linked(owner(), jane.urn, { type: "matter" })).rows.map(x => x.record.id).sort(), [m1.id, m2.id].sort());
  const cut = await r.linked(owner(), jane.urn, { limit: 2 });
  assert.equal(cut.rows.length, 2); assert.equal(cut.truncated, true);
  hidden.add(m2.urn);
  assert.deepEqual((await r.linked(owner(), jane.urn, { type: "matter" })).rows.map(x => x.record.id), [m1.id], "a record the caller may not read is not listed");
  await assert.rejects(() => r.linked(owner(), "not-a-urn"), { code: "bad_input" });
});

// ---- roles: what a contact is to the Space ----
const roleType = (name, extra = {}) => ({ name, label: name, role: { link: "contact", ended: ["Ended"] }, fields: [
  { name: "contact", kind: "link", to: "contact", label: "Contact", required: true },
  { name: "stage", kind: "stage", label: "Stage", options: ["New", "Active", "Ended"] },
  { name: "note", kind: "text", label: "Note" },
], stages: [{ name: "New" }, { name: "Active" }, { name: "Ended" }], ...extra });

test("roles: a role type needs its link, required, to a contact or organization, and ended stages that exist", async () => {
  const { r } = await withType(rig());
  const bad = async (t, why) => assert.rejects(() => r.define(owner(), { add_types: [t] }), { code: "bad_input" }, why);
  await bad({ ...roleType("prospect"), role: {} }, "no link named");
  await bad({ ...roleType("prospect"), fields: roleType("x").fields.filter(f => f.name !== "contact") }, "link field missing");
  await bad({ ...roleType("prospect"), fields: roleType("x").fields.map(f => (f.name === "contact" ? { ...f, required: false } : f)) }, "link not required");
  await bad({ ...roleType("prospect"), fields: roleType("x").fields.map(f => (f.name === "contact" ? { ...f, to: "matter" } : f)) }, "links to something else");
  await bad({ ...roleType("prospect"), role: { link: "contact", ended: ["Gone"] } }, "ended stage that does not exist");
  await r.define(owner(), { add_types: [roleType("prospect")] });
});

test("roles: roles of a contact and holders of a role at a stage, current first, only what the caller may read", async () => {
  const hidden = new Set();
  const attrs = urn => ({ project: hidden.has(urn) ? "p9" : "p1" });
  const g = G({ resource: { prefix: `vyre://${SPACE}/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } });
  const ownerAll = G({ actions: ["records.create", "records.define"] });
  const { r } = await withType(rig({ grants: [ownerAll, g], attrs }));
  await r.define(owner(), { add_types: [roleType("prospect"), roleType("client"), roleType("ambassador")] });
  const jane = await r.create(owner(), "contact", { name: "Jane" }), bob = await r.create(owner(), "contact", { name: "Bob" });
  const mk = (type, c, stage) => r.create(owner(), type, { contact: { urn: c.urn }, stage });
  const p1 = await mk("prospect", jane, "Ended"), c1 = await mk("client", jane, "Active"), a1 = await mk("ambassador", jane, "New");
  const pb = await mk("prospect", bob, "New"), cb = await mk("client", bob, "Active");
  const mine = await r.roles(owner(), jane.urn);
  assert.deepEqual(mine.map(x => [x.role, x.current]).sort(), [["ambassador", true], ["client", true], ["prospect", false]]);
  assert.equal(mine.at(-1).current, false, "ended roles come last");
  assert.ok(mine.every(x => x.holder === jane.urn));
  assert.deepEqual((await r.roles(owner(), jane.urn, { include_ended: false })).map(x => x.role).sort(), ["ambassador", "client"]);
  const act = await r.holders(owner(), { role: "client", stage: "Active", page: { limit: 10 } });
  assert.deepEqual(act.rows.map(x => x.holder).sort(), [jane.urn, bob.urn].sort());
  assert.deepEqual((await r.holders(owner(), { role: "prospect", page: { limit: 10 } })).rows.map(x => x.holder), [bob.urn], "ended prospects are left out");
  assert.equal((await r.holders(owner(), { role: "prospect", include_ended: true, page: { limit: 10 } })).rows.length, 2);
  await assert.rejects(() => r.holders(owner(), { role: "contact", page: { limit: 1 } }), { code: "bad_input" }, "a plain type is not a role");
  // a role record the caller may not read is not listed, and a holder the caller may not read has no roles to show
  hidden.add(c1.urn);
  assert.deepEqual((await r.roles(owner(), jane.urn)).map(x => x.role).sort(), ["ambassador", "prospect"]);
  assert.equal((await r.holders(owner(), { role: "client", stage: "Active", page: { limit: 10 } })).rows.length, 1);
  hidden.add(bob.urn);
  assert.deepEqual(await r.roles(owner(), bob.urn), []);
  void p1; void a1; void pb; void cb;
});

test("merge: two contacts that are one person become one, everything moves, the log says so, and unmerge puts it all back", async () => {
  const { r, log } = await rig();
  await r.define(owner(), { add_types: [CONTACT_CORE, ORG_CORE, PARTICIPANT_CORE, roleType("client")] });
  const org = await r.create(owner(), "organization", { name: "Harlow Legal", domain: "harlow.test" });
  const a = await r.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test", other_emails: ["j@old.test"] });
  const b = await r.create(owner(), "contact", { name: "J. Doe", email: "jane@gmail.test", phone: "+15550100", organization: { urn: org.urn }, other_emails: ["j@old.test", "jd@x.test"], notes: "second" });
  const role = await r.create(owner(), "client", { contact: { urn: b.urn }, stage: "Active" });
  const part = await r.create(owner(), "participant", { communication: { urn: `vyre://${SPACE}/communication/${mintUuid()}` }, contact: { urn: b.urn }, how: "to" });
  await assert.rejects(() => r.merge(owner(), "contact", a.id, a.id), { code: "bad_input" });
  const res = await r.merge(owner(), "contact", a.id, b.id);
  assert.equal(res.relinked, 2);
  assert.deepEqual(res.conflicts, { name: "J. Doe" }, "a different name is reported and the kept one stands; the other email had a place to go");
  const m = (await r.get(owner(), "contact", a.id)).data;
  assert.equal(m.name, "Jane Doe", "the kept record's own value stands");
  assert.deepEqual([m.phone, m.organization.urn, m.notes], ["+15550100", org.urn, "second"], "empty fields take the other's value");
  assert.deepEqual(m.other_emails.sort(), ["j@old.test", "jane@gmail.test", "jd@x.test"], "lists join and the other main email is kept");
  assert.equal(await r.get(owner(), "contact", b.id), null, "the dropped record is in the bin");
  assert.equal((await r.get(owner(), "client", role.id)).data.contact.urn, a.urn);
  assert.equal((await r.get(owner(), "participant", part.id)).data.contact.urn, a.urn);
  assert.deepEqual((await r.roles(owner(), a.urn)).map(x => x.role), ["client"]);
  assert.equal(log.read({ type: "records.merged" }).length, 1);
  assert.equal(log.read({ type: "records.merged" })[0].data.drop, b.id);
  // undo
  const back = await r.unmerge(owner(), res.merge_id);
  assert.equal(back.relinked, 2);
  const a2 = (await r.get(owner(), "contact", a.id)).data;
  assert.deepEqual([a2.phone ?? null, a2.organization ?? null, a2.notes ?? null, a2.other_emails], [null, null, null, ["j@old.test"]]);
  assert.equal((await r.get(owner(), "contact", b.id)).data.email, "jane@gmail.test");
  assert.equal((await r.get(owner(), "client", role.id)).data.contact.urn, b.urn);
  await assert.rejects(() => r.unmerge(owner(), res.merge_id), { code: "invalid" }, "once");
});

test("merge: a record that links to the dropped one and may not be changed stops the merge before anything moves", async () => {
  const grants = [
    G({ actions: ["records.define"] }),
    G({ actions: ["records.read", "records.create", "records.update", "records.remove"], resource: { prefix: `vyre://${SPACE}/contact/*` } }),
    G({ actions: ["records.read", "records.create"], resource: { prefix: `vyre://${SPACE}/client/*` } }),
  ];
  const { r } = await rig({ grants });
  await r.define(owner(), { add_types: [CONTACT_CORE, ORG_CORE, roleType("client")] });
  const a = await r.create(owner(), "contact", { name: "A", email: "a@x.test" }), b = await r.create(owner(), "contact", { name: "B", phone: "+1555" });
  await r.create(owner(), "client", { contact: { urn: b.urn } });
  await assert.rejects(() => r.merge(owner(), "contact", a.id, b.id), { code: "not_allowed" });
  assert.equal((await r.get(owner(), "contact", b.id)).data.name, "B", "the dropped record is still there");
  assert.equal((await r.get(owner(), "contact", a.id)).version, 1, "the kept record is untouched");
});

test("remove a field softly: nothing shows, writes, filters or finds it, the data is kept, and bringing it back shows the data again", async () => {
  const { r } = await rig();
  const def = hidden => ({ name: "memo", label: "Memo", fields: [{ name: "title", kind: "text", label: "Title", required: true }, { name: "secret", kind: "text", label: "Secret", required: true, ...(hidden ? { hidden: true } : {}) }] });
  await r.define(owner(), { add_types: [def(false)] });
  const m = await r.create(owner(), "memo", { title: "Plan", secret: "needle" });
  assert.equal((await r.search(owner(), { text: "needle", page: { limit: 5 } })).rows.length, 1);
  await r.define(owner(), { change_types: [def(true)] });
  assert.equal("secret" in (await r.get(owner(), "memo", m.id)).data, false, "not shown");
  assert.equal("secret" in (await r.query(owner(), "memo", { page: { limit: 5 } })).rows[0].data, false, "not listed");
  await assert.rejects(() => r.update(owner(), "memo", m.id, { secret: "x" }, 1), { code: "bad_input" });
  await assert.rejects(() => r.query(owner(), "memo", { filter: { field: "secret", op: "eq", value: "needle" }, page: { limit: 5 } }), { code: "bad_input" });
  assert.equal((await r.search(owner(), { text: "needle", page: { limit: 5 } })).rows.length, 0, "not found by its text");
  const n = await r.create(owner(), "memo", { title: "No secret needed" });
  assert.equal(n.version, 1, "a removed field is never required");
  await r.define(owner(), { change_types: [{ ...def(false), fields: def(false).fields.map(f => ({ ...f, required: false })) }] });
  assert.equal((await r.get(owner(), "memo", m.id)).data.secret, "needle", "the data was kept");
});

test("seal a field in place: values move into a sealed field, no plaintext is left in the store, its change log or the event log, and the audit chain still verifies", async () => {
  let refs = 0;
  const sealer = { api: { put: async i => ({ ref: { sealed: i.class, ref: `sv_${++refs}`, present: true, valid_format: true, set_at: 1 } }) } };
  const { r, gw, log, store } = rig({ grants: [G({ actions: ["records.*", "records.define", "seal.put", "events.read"] })], sealer });
  await r.define(owner(), { add_types: [{ name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "ssn", kind: "text", label: "SSN", required: true }] }] });
  const a = await r.create(owner(), "person", { name: "Jane", ssn: "123-45-6789" });
  const b = await r.create(owner(), "person", { name: "Bob", ssn: "987-65-4321" });
  await r.update(owner(), "person", b.id, { ssn: "987-65-4322" }, 1);
  const gone = await r.create(owner(), "person", { name: "Binned", ssn: "555-55-5555" });
  await r.remove(owner(), "person", gone.id, 1);
  const out = await gw.migrate.sealField(owner(), { type: "person", field: "ssn", class: "us-ssn" });
  assert.equal(out.moved, 3, "the binned record too");
  assert.equal(out.sealed_field, "ssn_sealed");
  const all = JSON.stringify(await store.query("person", { include_deleted: true, page: { limit: 50 } }));
  for (const plain of ["123-45-6789", "987-65-4321", "987-65-4322", "555-55-5555"]) assert.equal(all.includes(plain), false, `${plain} is not in the store`);
  assert.equal(JSON.stringify((await store.changes(null, 1000)).entries).includes("123-45-6789"), false, "not in the store's change log");
  const events = JSON.stringify(log.read());
  for (const plain of ["123-45-6789", "987-65-4321", "987-65-4322", "555-55-5555"]) assert.equal(events.includes(plain), false, `${plain} is not in the event log`);
  const got = (await r.get(owner(), "person", a.id)).data;
  assert.equal(got.ssn_sealed.sealed, "us-ssn");
  assert.equal("ssn" in got, false, "the plain field is removed from view");
  assert.equal(await r.get(owner(), "person", gone.id), null, "the binned record is back in the bin");
  assert.equal((await gw.audit.verify()).ok, true, "an erased event keeps the chain verifiable");
  assert.equal(log.read({ type: "records.field-sealed" }).length, 1);
  await assert.rejects(() => gw.migrate.sealField(owner(), { type: "person", field: "ssn", class: "us-ssn" }), { code: "bad_input" }, "a field that is already removed from view is refused");
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

test("stage gates: the kernel's own evaluator is the default, and with it switched off the gate fails closed", async () => {
  const dflt = rig();
  await dflt.r.define(owner(), { add_types: [DEAL] });
  assert.equal((await dflt.r.create(owner(), "deal", { title: "A", stage: "Intake" })).data.stage, "Intake", "no evaluator to wire: the rule holds for Intake");
  await assert.rejects(() => dflt.r.create(owner(), "deal", { title: "B", stage: "Drafting", signed: false }), { code: "rule_failed" });
  const { r } = rig({ expr: null });
  await r.define(owner(), { add_types: [DEAL] });
  await assert.rejects(() => r.create(owner(), "deal", { title: "A", stage: "Intake" }), { code: "unavailable" });
});

test("K5: audit.verify also checks the signed checkpoints when the Space's key is given", async () => {
  const { createCheckpointer, ed25519Signer } = await import("../audit/index.js");
  const { generateKeyPairSync } = await import("node:crypto");
  const k = generateKeyPairSync("ed25519");
  const { r, gw, log } = await withType(rig({ checkpointKey: k.publicKey }));
  await r.create(owner(), "contact", { name: "Jane" });
  const cp = createCheckpointer({ space: SPACE, log, chains, sign: ed25519Signer(k.privateKey), key_id: "space-key-1", clock });
  await cp.sign();
  const ok = await gw.audit.verify();
  assert.deepEqual([ok.ok, ok.checkpoints], [true, 1]);
  const forged = createCheckpointer({ space: SPACE, log, chains, sign: ed25519Signer(generateKeyPairSync("ed25519").privateKey), key_id: "space-key-1", clock });
  await forged.sign();
  assert.equal((await gw.audit.verify()).ok, false);
});

test("sessions gaps: idempotency keys on record writes, corr under a flow chain, record.stage-entered", async () => {
  const { r, log } = rig({ expr: { parseExpr, evalExpr } });
  await r.define(owner(), { add_types: [DEAL] });
  const a = await r.create(owner(), "deal", { title: "A", stage: "Intake" }, { idem: "k1" });
  const b = await r.create(owner(), "deal", { title: "A", stage: "Intake" }, { idem: "k1" });
  assert.equal(a.id, b.id);
  assert.equal(log.read({ type: "deal.created" }).length, 1, "one write for one key");
  await assert.rejects(() => r.create(owner(), "deal", { title: "Other", stage: "Intake" }, { idem: "k1" }), { code: "idem_conflict" });
  const entered = log.read({ type: "record.stage-entered" });
  assert.equal(entered.length, 1);
  assert.deepEqual([entered[0].data.stage, entered[0].data.id, entered[0].subject], ["Intake", a.id, `vyre://${SPACE}/deal/${a.id}`]);
  const u = await r.update(owner(), "deal", a.id, { signed: true }, a.version, { idem: "k2" });
  const u2 = await r.update(owner(), "deal", a.id, { signed: true }, a.version, { idem: "k2" });
  assert.equal(u.version, u2.version, "the repeat returns the first result, not a version conflict");
  assert.equal(log.read({ type: "record.stage-entered" }).length, 1, "an update that keeps the stage is not an entry");
  // under a flow chain every event carries the run id as corr
  const flow = chains.forFlow({ flow: "fl_x", approver: owner(), run: "run_77" });
  const g2 = rig({ grants: [G(), G({ subject: { kind: "actor", actor: actor("automation", "fl_x") }, actions: ["records.*"] })], members: ["automation:fl_x"], expr: { parseExpr, evalExpr } });
  await g2.r.define(owner(), { add_types: [DEAL] });
  await g2.r.create(flow, "deal", { title: "From a flow" });
  assert.ok(g2.log.read({ type: "deal.created" }).every(e => e.corr === "run_77"));
});
