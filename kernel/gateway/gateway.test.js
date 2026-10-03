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
const G = (over = {}) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor("person", OWNER) }, actions: ["records.*"], action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0, ...over });

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
  assert.deepEqual(await r.recover(), { completed: 1, compensated: 1, still_open: 0 });
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
