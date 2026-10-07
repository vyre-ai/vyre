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

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", MEMBER = "per_member", THIRD = "per_third";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, is_person: p => [OWNER, MEMBER, THIRD].includes(p), key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const member = () => chains.fromFacts({ kind: "invitee", person: MEMBER, vouched: true });
const third = () => chains.fromFacts({ kind: "invitee", person: THIRD, vouched: true });
const assistantOf = (person) => chains.fromFacts({ kind: "agent_session", vouched: true, person, agent: "assistant", session: "s1" });
const actor = (id) => ({ kind: "person", id, space: SPACE });
let n = 0;
const G = (who) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor(who) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" });
const EVENT = { name: "event", label: "Event", fields: [{ name: "title", kind: "text", label: "Title" }] };
const make = (kind, roles) => {
  const store = kind === "memory" ? createMemoryStore({ clock }) : createSqliteStore({ db: new DatabaseSync(":memory:"), clock, hotRows: 10 });
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map([G(OWNER), G(MEMBER), G(THIRD), { ...G("assistant"), subject: { kind: "actor", actor: { kind: "agent", id: "assistant", space: SPACE } } }, { ...G("planner"), subject: { kind: "actor", actor: { kind: "service", id: "planner", space: SPACE } } }].map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, `person:${MEMBER}`, `person:${THIRD}`, `agent:assistant`, `service:planner`]);
  const members = { has: a => known.has(`${a.kind}:${a.id}`), ...(roles ? { membership: a => ({ role: roles[a.id] || "member" }) } : {}) };
  const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs: () => ({}),
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members, hasPresenceSession: () => true });
  lastGateway = gw;
  return gw.records;
};
/** @type {any} */ let lastGateway;
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

for (const kind of ["memory", "sqlite"]) {
  test(`bin (${kind}): the person on the chain owns what their assistant removed; another person through the shared assistant id, and an agent with no person, see none`, async () => {
    const r = make(kind);
    await r.define(owner(), { add_types: [EVENT] });
    const byAssistant = await r.create(assistantOf(MEMBER), "event", { title: "assistant made it for member" });
    const direct = await r.create(member(), "event", { title: "member made it" });
    await r.remove(assistantOf(MEMBER), "event", byAssistant.id, byAssistant.version);
    await r.remove(member(), "event", direct.id, direct.version);
    const bin = async (who) => titles((await q(r, who, { include_deleted: true })).rows);
    assert.deepEqual(await bin(member), ["assistant made it for member", "member made it"], "the member's own chain sees the row their assistant made");
    assert.deepEqual(await bin(() => assistantOf(MEMBER)), ["assistant made it for member", "member made it"], "and so does their assistant acting for them");
    assert.deepEqual(await bin(third), [], "another person sees neither");
    assert.deepEqual(await bin(() => assistantOf(THIRD)), [], "another person's assistant (the same shared agent id) sees neither");
    const bare = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 999, pid: 1, inside_model_process: true });
    let seen = [];
    try { seen = await bin(bare); } catch { seen = []; }
    assert.deepEqual(seen, [], "an agent with no person on its chain sees none");
  });
}

for (const kind of ["memory", "sqlite"]) {
  test(`bin (${kind}): a module's own chain writes on a person's behalf with that person's chain; no other caller can name created_for`, async () => {
    const r = make(kind);
    await r.define(owner(), { add_types: [EVENT] });
    const svc = lastGateway.serviceChain("planner");
    const forMember = await r.create(svc, "event", { title: "planner made it for member" }, { on_behalf: member() });
    const forNobody = await r.create(svc, "event", { title: "planner made it alone" });
    await r.remove(svc, "event", forMember.id, forMember.version);
    await r.remove(svc, "event", forNobody.id, forNobody.version);
    const bin = async (who) => titles((await q(r, who, { include_deleted: true })).rows);
    assert.deepEqual(await bin(member), ["planner made it for member"], "the person it was made for finds it in their Bin");
    assert.deepEqual(await bin(() => assistantOf(MEMBER)), ["planner made it for member"], "and so does their assistant");
    assert.deepEqual(await bin(third), [], "another person does not");
    // Forging: a plain chain naming someone else, a service chain handed something that is not a chain, and a chain-shaped object the kernel did not build.
    await assert.rejects(() => r.create(third(), "event", { title: "forged" }, { on_behalf: member() }), { code: "denied" });
    await assert.rejects(() => r.create(owner(), "event", { title: "forged" }, { on_behalf: member() }), { code: "denied" });
    await assert.rejects(() => r.create(svc, "event", { title: "forged" }, { on_behalf: { hops: [{ actor: actor(MEMBER) }] } }), { code: "bad_input" });
    await assert.rejects(() => r.create(svc, "event", { title: "forged" }, { attrs: { created_for: `person:${MEMBER}` } }), { code: "bad_input" });
    await assert.rejects(() => r.create(third(), "event", { title: "forged" }, { attrs: { created_for: `person:${MEMBER}` } }), { code: "bad_input" });
    assert.deepEqual(await bin(member), ["planner made it for member"], "nothing a caller typed changed whose row it is");
  });
}
