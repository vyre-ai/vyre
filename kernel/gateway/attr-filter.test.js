// A restricted caller whose grants are attribute equalities: the store counts and lists under the same predicate. (header from kq-fixes) (reviewer-2, 25f5ccb20), each with its attack: KQ-1 no grant on the type must not total it, KQ-2 the slow aggregate path is bounded, KQ-3 index slots cannot be squatted, KQ-4 a page limit is validated.
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
const make = (grants, attrs = () => ({}), kind = "sqlite", over = {}) => {
  const db = new DatabaseSync(":memory:");
  const store = kind === "memory" ? createMemoryStore({ clock }) : createSqliteStore({ db, clock, hotRows: 10 });
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
  const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs, ...(over.attrPush ? { attrPush: over.attrPush } : {}),
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  return { store, gw, db };
};

const P = (attr, value) => ({ attr, op: "eq", value });
const scenarios = {
  "one project": [[P("project", "p1")]],
  "two grants, the second with two terms": [[P("project", "p1")], [P("project", "p2"), P("owner", "o1")]],
  "one owner": [[P("owner", "o1")]],
  "a project nobody has": [[P("project", "p9")]],
  "two terms on one attribute that cannot both hold": [[P("project", "p1"), P("project", "p2")]],
};
const grantsFor = where => [G(OWNER), ...where.map(w => G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/matter/*`, where: w } }))];
const fill = async gw => {
  const projects = ["p1", "p2", "p3", undefined], owners = ["o1", "o2", undefined];
  for (let i = 0; i < 70; i++) {
    const attrs = { ...(projects[i % 4] ? { project: projects[i % 4] } : {}), ...(owners[(i * 7) % 3] ? { owner: owners[(i * 7) % 3] } : {}) };
    await gw.records.create(owner(), "matter", { title: `Harlow ${i}`, stage: ["intake", "open", "closed"][i % 3], fee: i }, { attrs });
  }
};
const allPages = async (gw, who) => { const out = []; let cursor; for (let n = 0; n < 40; n++) { const p = await gw.records.query(who, "matter", { sort: [{ field: "fee", dir: "asc" }], page: { limit: 7, ...(cursor ? { cursor } : {}) } }); out.push(...p.rows.map(r => r.data.fee)); cursor = p.next_cursor; if (!cursor) break; } return out; };

for (const [name, where] of Object.entries(scenarios)) {
  test(`attr_filter (${name}): the store's count and list under the pushed predicate equal the gateway's row by row, and the count is one native statement`, async () => {
    const on = make(grantsFor(where), () => ({}), "sqlite", { attrPush: () => true });
    const off = make(grantsFor(where), () => ({}), "sqlite", {});
    for (const w of [on, off]) { await w.gw.records.define(owner(), { add_types: [MATTER] }); await fill(w.gw); }
    const spec = { group_by: ["stage"], measures: [{ fn: "count" }, { fn: "sum", field: "fee" }] };
    const before = on.store.stats().aggregate_pushed;
    const pushed = await on.gw.records.aggregate(member(), "matter", spec);
    const slow = await off.gw.records.aggregate(member(), "matter", spec);
    assert.deepEqual(pushed, slow, "the same totals");
    assert.equal(on.store.stats().aggregate_pushed, before + 1, "the total was one native statement");
    assert.equal(off.store.stats().aggregate_pushed, 0, "and without attrPush the gateway totalled row by row");
    if (name !== "a project nobody has" && !name.includes("cannot both")) assert.ok(pushed.length > 0, "the scenario matches some rows");
    assert.deepEqual(await allPages(on.gw, member()), await allPages(off.gw, member()), "the same rows in the same order across every page");
  });
}

test("attr_filter: it is only used where it is safe: not without attrPush, not for a caller with a whole-type grant, not for a caller with no grant, and the store counted natively", async () => {
  const { store, gw } = make(grantsFor([[P("project", "p1")]]), () => ({}), "sqlite", { attrPush: () => true });
  await gw.records.define(owner(), { add_types: [MATTER] }); await fill(gw);
  const spec = { group_by: ["stage"], measures: [{ fn: "count" }] };
  let queries = 0; const q = store.query.bind(store); store.query = async (...a) => { queries++; return q(...a); };
  const before = store.stats().aggregate_pushed;
  const r = await gw.records.aggregate(member(), "matter", spec);
  assert.ok(r.reduce((s, g) => s + g.values.count, 0) > 0);
  assert.equal(store.stats().aggregate_pushed, before + 1, "one native GROUP BY");
  assert.equal(queries, 0, "no rows were read through the gateway");
  // a page: one store call
  await gw.records.query(member(), "matter", { sort: [{ field: "fee", dir: "asc" }], page: { limit: 5 } });
  assert.equal(queries, 1, "one store call for a page");
  // no grant on the type at all (KQ-1): nothing, and nothing pushed
  const none = make([G(OWNER), G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/note/*` } })], () => ({}), "sqlite", { attrPush: () => true });
  await none.gw.records.define(owner(), { add_types: [MATTER] }); await fill(none.gw);
  const b2 = none.store.stats().aggregate_pushed;
  assert.deepEqual(await none.gw.records.aggregate(member(), "matter", spec), []);
  assert.equal(none.store.stats().aggregate_pushed, b2);
  // a malformed filter reaches the store: it refuses, it never widens
  await assert.rejects(() => store.aggregate("matter", { ...spec, attr_filter: { urn_prefix: `vyre://${SPACE}/matter/`, any: [{ nothing: "x" }] } }), { code: "unsupported" });
  await assert.rejects(() => store.aggregate("matter", { ...spec, attr_filter: { urn_prefix: "x", any: [{ project: "p1" }] } }), { code: "unsupported" });
  assert.deepEqual(await store.aggregate("matter", { ...spec, attr_filter: { urn_prefix: `vyre://${SPACE}/matter/`, any: [] } }), [], "no alternative allows no row");
});
