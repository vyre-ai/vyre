// Fixes for the kernel-query gate (reviewer-2, 25f5ccb20), each with its attack: KQ-1 no grant on the type must not total it, KQ-2 the slow aggregate path is bounded, KQ-3 index slots cannot be squatted, KQ-4 a page limit is validated.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
const NOTE = { name: "note", label: "Note", fields: [{ name: "body", kind: "text", label: "Body" }] };
const make = (grants, attrs = () => ({}), kind = "sqlite") => {
  const db = new DatabaseSync(":memory:");
  const store = kind === "memory" ? createMemoryStore({ clock }) : createSqliteStore({ db, clock, hotRows: 10 });
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
  const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs,
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  return { store, gw, db };
};

const kqIndexes = (db, type) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ?").all(`kq_${type}_%`).map(r => r.name);
const NOTE_ONLY = G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/note/*` } });
const SPEC = { group_by: ["stage"], measures: [{ fn: "count" }, { fn: "sum", field: "fee" }] };

for (const kind of ["memory", "sqlite"]) {
  test(`KQ-1 (${kind}): a member whose grants cover only another type totals nothing, and the store never ran a GROUP BY for them`, async () => {
    const { store, gw } = make([G(OWNER), NOTE_ONLY], () => ({}), kind);
    await gw.records.define(owner(), { add_types: [MATTER, NOTE] });
    for (let i = 0; i < 9; i++) await gw.records.create(owner(), "matter", { title: `Harlow ${i}`, stage: ["intake", "open", "closed"][i % 3], fee: 100 + i });
    const pushed = () => (typeof store.stats === "function" ? store.stats().aggregate_pushed || 0 : 0);
    const before = pushed();
    assert.deepEqual(await gw.records.aggregate(member(), "matter", SPEC), []);
    assert.equal(pushed(), before, "no GROUP BY ran");
    assert.equal((await gw.records.aggregate(owner(), "matter", SPEC)).length, 3, "the owner still totals it");
  });

  test(`KQ-2 (${kind}): a restricted caller's total over more rows than the cap is refused, and a group-by on a unique field is refused, not held in memory`, async () => {
    const proj = { prefix: `vyre://${SPACE}/matter/*`, where: [{ attr: "project", op: "eq", value: "p1" }] };
    const { store, gw } = make([G(OWNER), G(MEMBER, { actions: ["records.read"], resource: proj })], () => ({ project: "p1" }), kind);
    await gw.records.define(owner(), { add_types: [MATTER] });
    for (let i = 0; i < 20_600; i++) await store.create("matter", randomUUID(), { title: `Harlow ${i}`, stage: ["intake", "open", "closed"][i % 3], fee: i });
    let pages = 0; const q = store.query.bind(store); store.query = async (...a) => { pages++; return q(...a); };
    await assert.rejects(() => gw.records.aggregate(member(), "matter", SPEC), { code: "unsupported" });
    assert.ok(pages <= 40, `the scan stopped at the page cap (${pages} pages)`);
    store.query = q;
    // a narrower filter fits under the cap and is exact
    const few = await gw.records.aggregate(member(), "matter", { ...SPEC, filter: { field: "fee", op: "lt", value: 3000 } });
    assert.equal(few.reduce((s, g) => s + g.values.count, 0), 3000);
    // a group-by on a unique field is refused at 10,000 groups
    await assert.rejects(() => gw.records.aggregate(member(), "matter", { group_by: ["title"], measures: [{ fn: "count" }], filter: { field: "fee", op: "lt", value: 10_500 } }), { code: "unsupported" });
  });

  test(`KQ-4 (${kind}): a bad page limit is a bad_input, a large one is a page of 500`, async () => {
    const { gw } = make([G(OWNER)], () => ({}), kind);
    await gw.records.define(owner(), { add_types: [MATTER] });
    for (let i = 0; i < 3; i++) await gw.records.create(owner(), "matter", { title: `H${i}`, stage: "open", fee: i });
    const q = page => gw.records.query(owner(), "matter", { page });
    for (const limit of ["5; select 1", NaN, -1, 0, 2.5, undefined, null, Infinity]) await assert.rejects(() => q({ limit }), { code: "bad_input" }, String(limit));
    await assert.rejects(() => gw.records.query(owner(), "matter", {}), { code: "bad_input" }, "a missing page");
    await assert.rejects(() => q({ limit: 5, cursor: 7 }), { code: "bad_input" });
    assert.equal((await q({ limit: 10 ** 9 })).rows.length, 3);
  });
}

test("KQ-3: one caller trying many shapes cannot take every slot or stall a build every call; the first hot index stays, and a caller denied the type builds none", async () => {
  const { gw, db } = make([G(OWNER), NOTE_ONLY]);
  await gw.records.define(owner(), { add_types: [MATTER, NOTE] });
  for (let i = 0; i < 30; i++) await gw.records.create(owner(), "matter", { title: `H${i}`, stage: ["intake", "open", "closed"][i % 3], fee: i });
  const sorts = ["title", "fee", "stage"], dirs = ["asc", "desc"];
  const shapes = [];
  for (const f of ["title", "fee", "stage"]) for (const s of sorts) for (const d of dirs) shapes.push({ filter: { field: f, op: "eq", value: f === "fee" ? 1 : "x" }, sort: [{ field: s, dir: d }] });
  await gw.records.query(owner(), "matter", { filter: { field: "stage", op: "eq", value: "open" }, sort: [{ field: "fee", dir: "desc" }], page: { limit: 5 } });
  const first = kqIndexes(db, "matter");
  assert.equal(first.length, 1, "the hot shape built its index");
  for (const s of shapes) await gw.records.query(owner(), "matter", { ...s, page: { limit: 5 } });
  const now = kqIndexes(db, "matter");
  assert.ok(now.length <= 8, `a type holds at most 8 on-demand indexes (${now.length})`);
  assert.ok(now.includes(first[0]), "the first hot index is still there");
  // a caller with no read on the type builds nothing
  const before = kqIndexes(db, "matter").length;
  await gw.records.query(member(), "matter", { filter: { field: "title", op: "eq", value: "z" }, sort: [{ field: "stage", dir: "asc" }, { field: "title", dir: "desc" }], page: { limit: 5 } }).catch(() => {});
  assert.equal(kqIndexes(db, "matter").length, before, "a denied caller built no index");
});
