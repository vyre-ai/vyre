// The Bin: records.query with include_deleted lists removed rows under the same read rules, and only the caller's own (an owner or admin sees all). On both stores the kernel builds on.
import "../../scripts/mac-test-guard.mjs";
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
const G = (who) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor(who) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" });
const EVENT = { name: "event", label: "Event", fields: [{ name: "title", kind: "text", label: "Title" }] };
const make = (kind, roles) => {
  const store = kind === "memory" ? createMemoryStore({ clock }) : createSqliteStore({ db: new DatabaseSync(":memory:"), clock, hotRows: 10 });
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map([G(OWNER), G(MEMBER)].map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
  const members = { has: a => known.has(`${a.kind}:${a.id}`), ...(roles ? { membership: a => ({ role: roles[a.id] || "member" }) } : {}) };
  const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs: () => ({}),
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members, hasPresenceSession: () => true });
  return gw.records;
};
const q = (r, who, extra = {}) => r.query(who(), "event", { page: { limit: 50 }, ...extra });
const titles = rows => rows.map(x => x.data.title).sort();

for (const kind of ["memory", "sqlite"]) {
  test(`bin (${kind}): include_deleted lists a person's own removed rows, never another's; the default query still hides them`, async () => {
    const r = make(kind);
    await r.define(owner(), { add_types: [EVENT] });
    const mine = await r.create(owner(), "event", { title: "mine" });
    const keep = await r.create(owner(), "event", { title: "kept" });
    const theirs = await r.create(member(), "event", { title: "theirs" });
    await r.remove(owner(), "event", mine.id, mine.version);
    await r.remove(member(), "event", theirs.id, theirs.version);
    assert.deepEqual(titles((await q(r, owner)).rows), ["kept"], "removed rows are hidden by default");
    const bin = await q(r, owner, { include_deleted: true });
    assert.deepEqual(titles(bin.rows), ["kept", "mine"], "the owner's bin holds the owner's removed row, not the member's");
    assert.ok(bin.rows.find(x => x.id === mine.id).deleted_at > 0, "a removed row says when");
    assert.equal(bin.rows.find(x => x.id === keep.id).deleted_at ?? null, null);
    assert.deepEqual(titles((await q(r, member, { include_deleted: true })).rows), ["kept", "theirs"], "the member sees live rows too and their own removed one, not the owner's");
    assert.deepEqual(titles((await q(r, owner, { include_deleted: false })).rows), ["kept"]);
    await r.restore(owner(), "event", mine.id);
    assert.deepEqual(titles((await q(r, owner, { include_deleted: true })).rows), ["kept", "mine"]);
    assert.equal((await q(r, owner, { include_deleted: true, filter: { field: "title", op: "eq", value: "mine" } })).rows.length, 1, "a filter still applies");
  });

  test(`bin (${kind}): an owner or admin sees every removed row; include_deleted must be true or false`, async () => {
    const r = make(kind, { [OWNER]: "owner" });
    await r.define(owner(), { add_types: [EVENT] });
    const theirs = await r.create(member(), "event", { title: "theirs" });
    await r.remove(member(), "event", theirs.id, theirs.version);
    assert.deepEqual(titles((await q(r, owner, { include_deleted: true })).rows), ["theirs"]);
    await assert.rejects(() => q(r, owner, { include_deleted: "yes" }), { code: "bad_input" });
  });
}
