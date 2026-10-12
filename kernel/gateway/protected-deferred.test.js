// A record store that is not there yet (stores/twenty/deferred-store.js): while its definitions cannot be read, every type counts as protected for a member (nothing is remembered); the definitions made
// meanwhile are played onto the real store when it attaches, and a type defined PROTECTED there is protected for a member from the first read after, not when some cache happens to be rebuilt.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGateway } from "./index.js";
import { createSqliteStore } from "../store/sqlite.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { createDeferredStore } from "../../stores/twenty/deferred-store.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
test("store away: a member reads nothing and nothing is cached; the replay on attach defines a protected type and a member reads none of it from the first read after", async () => {
  let T = 1_800_000_000_000; const clock = () => ++T;
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const owner = chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const bob = chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const real = createSqliteStore({ db: new DatabaseSync(":memory:"), clock });
  const away = createDeferredStore({ reason: () => "the record store is starting", waitMs: 0 });
  const grants = [{ id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: actor(OWNER) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" },
    { id: "gr_0002", space: SPACE, subject: { kind: "actor", actor: actor(BOB) }, actions: ["records.*"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" }];
  const gw = createGateway({ space: SPACE, store: away, log: createEventLog({ space: SPACE, clock }), chains, clock, attrs: () => ({}),
    grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ id) => grants.find(g => g.id === id) },
    members: { has: (/** @type {any} */ a) => a.id === OWNER || a.id === BOB, membership: (/** @type {any} */ a) => (a.id === OWNER ? { role: "owner" } : { role: "member" }) }, hasPresenceSession: () => false });
  const MEMO = { name: "memo", label: "Memo", protected: true, fields: [{ name: "body", kind: "text", label: "Body" }] };
  // the definition is made while the store is away: it is kept and played when the store attaches
  await away.define({ add_types: [MEMO] });   // kept with the store while it is away, played when it attaches (the way a module's declared types reach it at start)
  away.bootDone();
  const seen = async () => (await gw.records.query(bob, "memo", { page: { limit: 5 } }).then(r => r.rows.length, () => -1));
  assert.ok([-1, 0].includes(await seen()), "away: a member reads nothing of it");
  // the real store joins; its replay is slow, and a member reads in the middle of it
  /** @type {() => void} */ let release = () => {};
  const slowReal = Object.create(real, { define: { value: async (/** @type {any} */ d) => { await new Promise(r => { release = /** @type {any} */ (r); }); return real.define(d); } } });
  const attaching = away.attach(slowReal);
  await new Promise(r => setTimeout(r, 30));
  assert.ok([-1, 0].includes(await seen()), "during the replay: still nothing");
  release(); await attaching;
  const row = await gw.records.create(owner, "memo", { body: "kept" });
  assert.equal(await gw.records.get(bob, "memo", row.id), null, "after the attach a member reads none of the protected type, by id");
  assert.equal(await seen(), 0, "nor by list");
  assert.ok(await gw.records.get(owner, "memo", row.id), "the owner still reads it");
});
