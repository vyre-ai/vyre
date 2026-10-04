// Containment on EVERY dimension (reviewer-2's DL-1): a delegate can never hold more than the grant it was cut from. For each dimension a child that is equal passes, a tighter one
// passes, a looser one is refused, and a dimension the function does not know is a refusal, never a pass.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { contains, containsDims, clampTo } from "./authorize.js";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "./canonical.js";

const S = "spc_aaaaaaaaaaaa";
const grant = (over = {}, cond = {}, res = {}) => ({ id: "gr_x", space: S, subject: { kind: "actor", actor: { kind: "agent", id: "kit", space: S } }, actions: ["records.read", "records.update"], action_set_version: 1, resource: { prefix: `vyre://${S}/contact/*`, ...res }, conditions: { delegate: { allowed: true, max_depth: 2 }, ...cond }, issuer: { kind: "person", id: "per_o", space: S }, source: "t", status: "active", created_at: 1, ...over });
const child = (parent, over = {}, cond, res) => ({ ...parent, id: "gr_c", parent: "gr_x", conditions: { ...(cond === undefined ? parent.conditions : { delegate: { allowed: false, max_depth: 0 }, ...cond }) }, resource: { ...parent.resource, ...(res || {}) }, ...over });
const riskOf = a => (a.startsWith("records.read") ? "read" : "write");

/** [dimension, how the parent holds it, [children that are equal], [tighter], [looser]] each child is { cond?, res?, over? } */
const TABLE = [
  ["actions", {}, [{ over: { actions: ["records.read", "records.update"] } }], [{ over: { actions: ["records.read"] } }], [{ over: { actions: ["records.read", "records.remove"] } }, { over: { actions: ["*"] } }]],
  ["resource prefix", {}, [{}], [{ res: { prefix: `vyre://${S}/contact/c1` } }], [{ res: { prefix: `vyre://${S}/*/*` } }, { res: { prefix: `vyre://${S}/matter/*` } }]],
  ["row predicates", { res: { where: [{ attr: "sensitivity", op: "ne", value: "privileged" }] } }, [{ res: { where: [{ attr: "sensitivity", op: "ne", value: "privileged" }] } }], [{ res: { where: [{ attr: "sensitivity", op: "ne", value: "privileged" }, { attr: "project", op: "eq", value: "p1" }] } }], [{ res: { where: [] } }, { res: { where: [{ attr: "sensitivity", op: "ne", value: "public" }] } }, { res: { where: undefined } }]],
  ["field list", { res: { fields: ["name", "email"] } }, [{ res: { fields: ["name", "email"] } }], [{ res: { fields: ["name"] } }], [{ res: { fields: ["name", "ssn"] } }, { res: { fields: undefined } }]],
  ["surfaces", { cond: { where: { surfaces: ["deck", "cli"] } } }, [{ cond: { where: { surfaces: ["deck", "cli"] } } }], [{ cond: { where: { surfaces: ["deck"] } } }], [{ cond: { where: { surfaces: ["deck", "mobile"] } } }, { cond: {} }]],
  ["nodes", { cond: { where: { nodes: ["n1", "n2"] } } }, [{ cond: { where: { nodes: ["n1", "n2"] } } }], [{ cond: { where: { nodes: ["n1"] } } }], [{ cond: { where: { nodes: ["n3"] } } }, { cond: {} }]],
  ["residency", { cond: { where: { residency: ["eu"] } } }, [{ cond: { where: { residency: ["eu"] } } }], [{ cond: { where: { residency: [] } } }], [{ cond: { where: { residency: ["eu", "us"] } } }, { cond: {} }]],
  ["not before", { cond: { when: { not_before: 1000 } } }, [{ cond: { when: { not_before: 1000 } } }], [{ cond: { when: { not_before: 2000 } } }], [{ cond: { when: { not_before: 500 } } }, { cond: {} }]],
  ["expiry", { cond: { when: { expires: 5000 } } }, [{ cond: { when: { expires: 5000 } } }], [{ cond: { when: { expires: 4000 } } }], [{ cond: { when: { expires: 6000 } } }, { cond: {} }]],
  ["schedule", { cond: { when: { schedule: "mon-fri 09:00-17:00" } } }, [{ cond: { when: { schedule: "mon-fri 09:00-17:00" } } }], [], [{ cond: { when: { schedule: "mon-sun 00:00-24:00" } } }, { cond: { when: { schedule: "mon-fri 09:00-17:01" } } }, { cond: {} }]],
  ["presence", { cond: { how: { presence: "fresh" } } }, [{ cond: { how: { presence: "fresh" } } }], [], [{ cond: { how: { presence: "session" } } }, { cond: { how: { presence: "none" } } }, { cond: {} }]],
  ["presence (session)", { cond: { how: { presence: "session" } } }, [{ cond: { how: { presence: "session" } } }], [{ cond: { how: { presence: "fresh" } } }], [{ cond: { how: { presence: "none" } } }, { cond: {} }]],
  ["approval", { cond: { how: { approval: { by: "owner" } } } }, [{ cond: { how: { approval: { by: "owner" } } } }], [{ cond: { how: { approval: { by: "owner", once: true } } } }], [{ cond: {} }, { cond: { how: { approval: null } } }, { cond: { how: { approval: { by: "anyone" } } } }]],
  ["approval once", { cond: { how: { approval: { by: "owner", once: true } } } }, [{ cond: { how: { approval: { by: "owner", once: true } } } }], [], [{ cond: { how: { approval: { by: "owner" } } } }, { cond: { how: { approval: { by: "owner", once: false } } } }]],
  ["budget", { cond: { budget: { meter: "ai", limit: 100 } } }, [{ cond: { budget: { meter: "ai", limit: 100 } } }], [{ cond: { budget: { meter: "ai", limit: 50 } } }], [{ cond: { budget: { meter: "ai", limit: 200 } } }, { cond: { budget: { meter: "money", limit: 10 } } }, { cond: {} }]],
  ["rate", { cond: { rate: { n: 10, per_seconds: 60 } } }, [{ cond: { rate: { n: 10, per_seconds: 60 } } }], [{ cond: { rate: { n: 5, per_seconds: 60 } } }, { cond: { rate: { n: 10, per_seconds: 120 } } }], [{ cond: { rate: { n: 20, per_seconds: 60 } } }, { cond: { rate: { n: 10, per_seconds: 30 } } }, { cond: {} }]],
  ["once", { cond: { once: true } }, [{ cond: { once: true } }], [], [{ cond: {} }, { cond: { once: false } }]],
  ["audience", { cond: { audience: ["svc1", "svc2"] } }, [{ cond: { audience: ["svc1", "svc2"] } }], [{ cond: { audience: ["svc1"] } }], [{ cond: { audience: ["svc1", "svc3"] } }, { cond: {} }]],
];

test("containment holds on every dimension: equal passes, tighter passes, looser is refused", () => {
  for (const [dim, held, equal, tighter, looser] of TABLE) {
    const parent = grant({}, { ...(held.cond || {}) }, held.res || {});
    const make = c => child(parent, c.over || {}, { ...(parent.conditions), ...(c.cond || {}), delegate: { allowed: false, max_depth: 0 } }, c.res);
    // the child's conditions replace the parent's for the dimension under test (so an absent one is really absent)
    const mk = c => { const g = make(c); const cond = { delegate: { allowed: false, max_depth: 0 }, ...(c.cond || {}) }; return { ...g, conditions: cond }; };
    for (const c of equal) assert.equal(containsDims(parent, mk(c), () => 0, riskOf), true, `${dim}: equal passes ${JSON.stringify(c)}`);
    for (const c of tighter) assert.equal(containsDims(parent, mk(c), () => 0, riskOf), true, `${dim}: tighter passes ${JSON.stringify(c)}`);
    for (const c of looser) assert.equal(containsDims(parent, mk(c), () => 0, riskOf), false, `${dim}: looser is refused ${JSON.stringify(c)}`);
  }
});

test("delegation depth: the parent must allow it and the child must go shallower; a different space is never inside", () => {
  const p = grant({}, {});
  assert.equal(contains(p, child(p, {}, { delegate: { allowed: true, max_depth: 1 } })), true);
  assert.equal(contains(p, child(p, {}, { delegate: { allowed: true, max_depth: 2 } })), false, "as deep as its parent");
  assert.equal(contains(p, child(p, {}, { delegate: { allowed: true, max_depth: 3 } })), false);
  assert.equal(contains(p, child(p, {}, { delegate: { allowed: false, max_depth: 0 } })), true);
  assert.equal(contains(grant({}, { delegate: { allowed: false, max_depth: 0 } }), child(p, {}, { delegate: { allowed: false, max_depth: 0 } })), false, "a parent that may not delegate");
  assert.equal(contains(p, child(p, { space: "spc_bbbbbbbbbbbb" }, {})), false);
});

test("a dimension this file does not know is a refusal, never a pass", () => {
  const p = grant({}, {});
  const base = child(p, {}, {});
  assert.equal(containsDims(p, base, () => 0, riskOf), true);
  assert.equal(containsDims(p, { ...base, conditions: { ...base.conditions, geofence: { km: 5 } } }, () => 0, riskOf), false, "a condition it cannot compare");
  assert.equal(containsDims({ ...p, conditions: { ...p.conditions, geofence: { km: 5 } } }, base, () => 0, riskOf), false, "a parent that carries one");
  assert.equal(containsDims(p, { ...base, resource: { ...base.resource, tier: "gold" } }, () => 0, riskOf), false, "a resource key it cannot compare");
  assert.equal(containsDims(p, { ...base, quota: 5 }, () => 0, riskOf), false, "a top-level key it cannot compare");
  assert.equal(containsDims(p, { ...base, conditions: { ...base.conditions, when: { expires: 1, timezone: "utc" } } }, () => 0, riskOf), false, "an unknown key inside a known dimension");
  assert.equal(containsDims(p, { ...base, conditions: { ...base.conditions, how: { presence: "fresh", factor: "two" } } }, () => 0, riskOf), false);
});

test("clampTo cuts an over-wide child to its parent's limits on every dimension, and what it returns is contained", () => {
  const parent = grant({}, { how: { presence: "fresh", approval: { by: "owner" } }, budget: { meter: "ai", limit: 100 }, rate: { n: 10, per_seconds: 60 }, when: { expires: 5000, schedule: "mon-fri" }, once: true, audience: ["svc1"], where: { surfaces: ["deck"] } }, { fields: ["name"], where: [{ attr: "sensitivity", op: "ne", value: "privileged" }] });
  const wide = child(parent, { actions: ["records.read", "records.remove"] }, { how: { presence: "none" }, budget: { meter: "ai", limit: 900 }, when: { schedule: "all" }, audience: ["svc9"] }, { prefix: `vyre://${S}/*/*`, fields: ["name", "ssn"], where: [] });
  assert.equal(contains(parent, wide, () => 0, riskOf), false);
  const cut = clampTo(parent, wide, () => 0, riskOf);
  assert.ok(cut);
  assert.equal(contains(parent, cut, () => 0, riskOf), true);
  assert.deepEqual(cut.actions, ["records.read"], "the action it was not inside is gone");
  assert.equal(cut.resource.prefix, parent.resource.prefix);
  assert.deepEqual(cut.resource.fields, ["name"]);
  assert.deepEqual([cut.conditions.how.presence, cut.conditions.how.approval.by, cut.conditions.budget.limit, cut.conditions.rate.n, cut.conditions.when.expires, cut.conditions.when.schedule, cut.conditions.once], ["fresh", "owner", 100, 10, 5000, "mon-fri", true]);
  assert.equal(clampTo(parent, { ...wide, actions: ["records.remove"] }, () => 0, riskOf), null, "nothing of it was inside: it cannot be cut down");
});

// ---- on the real kernel: reviewer-2's four probes through grants.create, and the check at boot ----
const OWNER = "per_owner";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

async function rig() {
  const k = await createKernel({ space: S, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const kit = { kind: "agent", id: "kit", space: S };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${S}/member/kit`) });
  const make = (i, p) => g.create(owner, i, { presence: proof("grants.create", i, `vyre://${S}/grant/new`) });
  const parentIn = { subject: { kind: "actor", actor: { kind: "person", id: OWNER, space: S } }, actions: ["records.read", "records.update"], resource: { prefix: `vyre://${S}/contact/*`, where: [{ attr: "sensitivity", op: "ne", value: "privileged" }] }, conditions: { delegate: { allowed: true, max_depth: 2 }, how: { presence: "fresh", approval: { by: "owner" } }, budget: { meter: "ai", limit: 100 }, when: { schedule: "mon-fri 09:00-17:00" } }, source: "test" };
  const parent = await make(parentIn);
  const childIn = (cond, res = {}) => ({ subject: { kind: "actor", actor: kit }, actions: ["records.read"], resource: { prefix: `vyre://${S}/contact/*`, where: parentIn.resource.where, ...res }, conditions: { delegate: { allowed: false, max_depth: 0 }, how: parentIn.conditions.how, budget: parentIn.conditions.budget, when: parentIn.conditions.when, ...cond }, source: "test", parent: parent.id });
  return { k, owner, g, make, parent, childIn, kit };
}

test("DL-1 probes on the real kernel: a child cannot drop presence, drop or loosen approval, widen the schedule, widen where, or widen the budget", async () => {
  const { make, childIn, g, parent, owner } = await rig();
  assert.ok((await make(childIn({}))).id, "an equal child is accepted");
  for (const [what, cond, res] of [
    ["presence none", { how: { presence: "none", approval: { by: "owner" } } }],
    ["no approval", { how: { presence: "fresh" } }],
    ["approval by anyone", { how: { presence: "fresh", approval: { by: "anyone" } } }],
    ["a seven-day all-day schedule", { when: { schedule: "mon-sun 00:00-24:00" } }],
    ["no schedule", { when: {} }],
    ["a larger budget", { budget: { meter: "ai", limit: 1000 } }],
    ["no budget", { budget: undefined }],
    ["where dropped", {}, { where: [] }],
    ["where changed", {}, { where: [{ attr: "sensitivity", op: "ne", value: "public" }] }],
  ]) await assert.rejects(() => make(childIn(cond, res)), { code: "not_contained" }, what);
  void g; void parent; void owner;
});

test("a stored child found wider than its parent at boot is cut to its parent's limits, and the cut is in the log", async () => {
  const { k, make, childIn, g, parent, owner } = await rig();
  const c = await make(childIn({ when: { schedule: "mon-fri 09:00-17:00", expires: Date.now() + 1e9 } }));
  // the parent is narrowed in place afterwards: it now ends sooner than the child it was cut from
  const soon = Date.now() + 1000;
  await g.narrow(owner, parent.id, { expires: soon }, { presence: proof("grants.narrow", { id: parent.id, patch: { expires: soon } }, `vyre://${S}/grant/${parent.id}`) });
  const before = (await g.list(owner)).find(x => x.id === c.id);
  assert.ok(before.conditions.when.expires > soon, "the child outlives its parent's new end");
  const r = await k.grants.containmentPass();
  assert.equal(r.clamped, 1);
  const after = (await g.list(owner)).find(x => x.id === c.id);
  assert.equal(after.conditions.when.expires, soon, "cut to the parent's expiry");
  assert.ok(k.log.read({ type: "grant.narrowed" }).some(e => e.data.why === "wider than its parent" && e.data.grant.id === c.id), "the cut is a logged event");
  assert.deepEqual(await k.grants.containmentPass(), { clamped: 0, revoked: 0 }, "and it is not cut twice");
});

test("CN-1: a schedule is compared by value, not by identity: a value-equal clone is contained, and a boot pass does not re-cut it", async () => {
  const sched = () => ({ days: ["mon"], from: "09:00", to: "10:00" });
  const parent = grant({}, { when: { schedule: sched() } });
  const same = child(parent, {}, { when: { schedule: sched() } });
  assert.equal(containsDims(parent, same, () => 0, riskOf), true, "a clone with the same fields");
  assert.equal(containsDims(parent, child(parent, {}, { when: { schedule: { ...sched(), to: "10:30" } } }), () => 0, riskOf), false, "a different one");
  const cut = clampTo(parent, child(parent, { actions: ["records.read", "records.remove"] }, { when: { schedule: sched() } }), () => 0, riskOf);
  assert.deepEqual(cut.conditions.when.schedule, sched());
  assert.equal(containsDims(parent, cut, () => 0, riskOf), true);
});

test("CN-1 on the real kernel: a delegate with an object schedule survives a rebuild from the log untouched, and still decides as its parent's equal", async () => {
  const { k, owner, g, kit } = await (async () => {
    const k = await createKernel({ space: S, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
    const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
    const g = k.gateway.grants;
    const kit = { kind: "agent", id: "kit", space: S };
    await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${S}/member/kit`) });
    return { k, owner, g, kit };
  })();
  const sched = () => ({ days: ["mon", "tue"], from: "09:00", to: "17:00" });
  const mk = i => g.create(owner, i, { presence: proof("grants.create", i, `vyre://${S}/grant/new`) });
  const parent = await mk({ subject: { kind: "actor", actor: { kind: "person", id: OWNER, space: S } }, actions: ["records.read"], resource: { prefix: `vyre://${S}/contact/*` }, conditions: { delegate: { allowed: true, max_depth: 2 }, when: { schedule: sched() } }, source: "t" });
  const kid = await mk({ subject: { kind: "actor", actor: kit }, actions: ["records.read"], resource: { prefix: `vyre://${S}/contact/*` }, conditions: { delegate: { allowed: false, max_depth: 0 }, when: { schedule: sched() } }, source: "t", parent: parent.id });
  await g.rebuild();                                         // the grants are now separate objects, read back from the sealed log
  assert.deepEqual(await k.grants.containmentPass(), { clamped: 0, revoked: 0 }, "nothing is re-cut");
  const after = (await g.list(owner)).find(x => x.id === kid.id);
  assert.deepEqual(after.conditions.when.schedule, sched());
  assert.equal(after.status, "active");
  const chain = k.chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", person: OWNER, vouched: true });
  const d = await k.gateway.authorize({ chain, action: "records.read", resource: `vyre://${S}/contact/c1` });
  assert.notEqual(d.reason, "not_contained", "the child is still inside its parent");
  assert.ok(d.obligations.some(o => o.type === "unknown:schedule"), "and the schedule it carries is never met silently");
  assert.equal(d.obligations.filter(o => o.type === "unknown:schedule").length, 1, "once, not once per grant in the chain");
});
