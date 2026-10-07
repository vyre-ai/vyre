// Look-ahead skipped for a row-uniform caller (records asked). (header from kq-fixes) (reviewer-2, 25f5ccb20), each with its attack: KQ-1 no grant on the type must not total it, KQ-2 the slow aggregate path is bounded, KQ-3 index slots cannot be squatted, KQ-4 a page limit is validated.
import "../../scripts/mac-test-guard.mjs";
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

for (const kind of ["memory", "sqlite"]) {
  test(`list and search (${kind}): a caller whose answer is the same for every row costs one store call per page, a restricted one still looks ahead, and both return the same rows`, async () => {
    const proj = { prefix: `vyre://${SPACE}/matter/*`, where: [{ attr: "project", op: "eq", value: "p1" }] };
    const { store, gw } = make([G(OWNER), G(MEMBER, { actions: ["records.read"], resource: proj })], () => ({ project: "p1" }), kind);
    await gw.records.define(owner(), { add_types: [MATTER] });
    for (let i = 0; i < 12; i++) await gw.records.create(owner(), "matter", { title: `Harlow ${i}`, stage: "open", fee: i });
    let queries = 0, searches = 0;
    const q = store.query.bind(store), s = store.search.bind(store);
    store.query = async (...a) => { queries++; return q(...a); };
    store.search = async (...a) => { searches++; return s(...a); };
    // the owner: one store call for a page, the store's cursor is the answer, and the next page continues
    const page1 = await gw.records.query(owner(), "matter", { sort: [{ field: "fee", dir: "asc" }], page: { limit: 5 } });
    assert.equal(queries, 1, "no look-ahead for the owner");
    assert.equal(page1.rows.length, 5); assert.ok(page1.next_cursor);
    const page2 = await gw.records.query(owner(), "matter", { sort: [{ field: "fee", dir: "asc" }], page: { limit: 5, cursor: page1.next_cursor } });
    const page3 = await gw.records.query(owner(), "matter", { sort: [{ field: "fee", dir: "asc" }], page: { limit: 5, cursor: page2.next_cursor } });
    assert.deepEqual([...page1.rows, ...page2.rows, ...page3.rows].map(r => r.data.fee), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(page3.next_cursor, undefined, "the last page has no cursor");
    // the restricted member: the same rows, and the gateway still asks about every row and looks ahead (more than one store call per page)
    queries = 0;
    const m1 = await gw.records.query(member(), "matter", { sort: [{ field: "fee", dir: "asc" }], page: { limit: 5 } });
    assert.ok(queries >= 2, `a restricted caller looks ahead (${queries} store calls)`);
    assert.deepEqual(m1.rows.map(r => r.data.fee), [0, 1, 2, 3, 4]);
    // search
    searches = 0;
    const found = await gw.records.search(owner(), { text: "Harlow", types: ["matter"], page: { limit: 5 } });
    assert.equal(searches, 1, "no look-ahead for the owner's search");
    assert.equal(found.rows.length, 5); assert.ok(found.next_cursor);
    searches = 0;
    const mf = await gw.records.search(member(), { text: "Harlow", types: ["matter"], page: { limit: 5 } });
    assert.ok(searches >= 2, `a restricted search looks ahead (${searches})`);
    assert.deepEqual(mf.rows.map(r => r.id).sort(), found.rows.map(r => r.id).sort());
  });
}
