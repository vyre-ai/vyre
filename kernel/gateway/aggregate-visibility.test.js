// A total and a search must not show what a person may not see. The store may total rows itself (one GROUP BY) only when every row gets the caller's same answer; otherwise the
// gateway totals the rows it allowed, and the answer is what the reference store gives that person. Both stores, both kinds of caller.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createSqliteStore } from "../store/sqlite.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", MEMBER = "per_member";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const member = () => chains.fromFacts({ kind: "invitee", person: MEMBER, vouched: true });
const actor = (id) => ({ kind: "person", id, space: SPACE });
let n = 0;
const G = (who, over = {}) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor(who) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active", ...over });
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }, { name: "fee", kind: "number", label: "Fee" }] };

const stores = { memory: () => createMemoryStore({ clock }), sqlite: () => createSqliteStore({ db: new DatabaseSync(":memory:"), clock, hotRows: 10 }) };

for (const [name, make] of Object.entries(stores)) {
  test(`aggregate and search on ${name}: a row a person may not see is neither counted nor found`, async () => {
    const store = make();
    const log = createEventLog({ space: SPACE, clock });
    const proj = new Map();
    const grants = [G(OWNER), G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/matter/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } })];
    const all = new Map(grants.map(g => [g.id, g]));
    const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
    const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs: u => ({ project: proj.get(u) || "p9" }),
      grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
      members: { has: a => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
    const r = gw.records;
    await r.define(owner(), { add_types: [MATTER] });
    const stages = ["intake", "open", "closed"], seen = { intake: 0, open: 0, closed: 0 }, all3 = { intake: 0, open: 0, closed: 0 };
    for (let i = 0; i < 60; i++) {
      const stage = stages[i % 3], rec = await r.create(owner(), "matter", { title: `Harlow ${i}`, stage, fee: i });
      all3[stage]++;
      if (i % 4 === 0) { proj.set(rec.urn, "p1"); seen[stage]++; }
    }
    const by = rows => Object.fromEntries(rows.map(x => [x.group.stage, x.values.count]));
    const spec = { group_by: ["stage"], measures: [{ fn: "count" }, { fn: "sum", field: "fee" }] };
    const pushed = () => (store.stats ? store.stats().aggregate_pushed : 0);
    const before = pushed();
    // The owner reads everything: one statement on the built-in store.
    assert.deepEqual(by(await r.aggregate(owner(), "matter", spec)), all3);
    const afterOwner = pushed();
    if (name === "sqlite") assert.ok(afterOwner > before, "an unrestricted caller's total is one GROUP BY");
    // The member reads only project p1: the total is theirs, equal to what counting the rows they can read gives, and never the whole table.
    const mine = await r.aggregate(member(), "matter", spec);
    assert.deepEqual(by(mine), seen, "the total excludes rows the member cannot read");
    assert.notDeepEqual(by(mine), all3);
    assert.equal(mine.reduce((s, x) => s + x.values["sum:fee"], 0), [...Array(60).keys()].filter(i => i % 4 === 0).reduce((s, i) => s + i, 0));
    assert.equal(pushed(), afterOwner, "a restricted caller's total never goes through the GROUP BY");
    // Search: the member finds only their own rows, the owner finds all.
    const found = await r.search(member(), { text: "harlow", page: { limit: 100 } });
    assert.equal(found.rows.length, 15);
    assert.equal((await r.search(owner(), { text: "harlow", page: { limit: 100 } })).rows.length, 60);
    assert.equal((await r.search(member(), { text: "Harlow 1", page: { limit: 100 } })).rows.every(h => proj.get(h.urn ?? `vyre://${SPACE}/matter/${h.id}`) === "p1"), true);
  });
}

test("aggregate: a type holding a privileged record is totalled row by row, even for a caller with no row predicate", async () => {
  const store = stores.sqlite();
  const log = createEventLog({ space: SPACE, clock });
  const g = G(OWNER);
  const gw = createGateway({ space: SPACE, store, log, chains, clock, grants: { forSubject: a => (a.id === OWNER ? [g] : []), get: () => g }, members: { has: a => a.id === OWNER }, hasPresenceSession: () => true });
  const r = gw.records;
  await r.define(owner(), { add_types: [MATTER] });
  for (let i = 0; i < 5; i++) await r.create(owner(), "matter", { title: `A ${i}`, stage: "open" });
  const spec = { group_by: ["stage"], measures: [{ fn: "count" }] };
  await r.aggregate(owner(), "matter", spec);
  assert.equal(store.stats().aggregate_pushed, 1, "no privileged record: one GROUP BY");
  await r.create(owner(), "matter", { title: "Secret", stage: "open" }, { attrs: { sensitivity: "privileged" } });
  await r.aggregate(owner(), "matter", spec);
  assert.equal(store.stats().aggregate_pushed, 1, "a privileged record in the type turns the GROUP BY off for it");
});
