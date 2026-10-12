// A type's `protected` flag is read from the definitions once and cached (records.js isProtectedType). The cache is emptied when a define STARTS; a read that builds it while the define is still running (on
// Twenty a define takes minutes) caches the OLD definitions for good. A kernel whose store's define is slow: a member's read in the middle of a define that makes a type protected must not leave the type open afterwards.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGateway } from "./index.js";
import { createSqliteStore } from "../store/sqlite.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
test("a define that makes a type protected, read in the middle of by a member, leaves the type protected once it has finished", async () => {
  let T = 1_800_000_000_000; const clock = () => ++T;
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const owner = chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const bob = chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const real = createSqliteStore({ db: new DatabaseSync(":memory:"), clock });
  /** @type {() => void} */ let release = () => {};
  let slow = false;
  const store = Object.create(real, { define: { value: async (/** @type {any} */ diff) => { if (slow) await new Promise(r => { release = /** @type {any} */ (r); }); return real.define(diff); } } });
  const grants = [{ id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: actor(OWNER) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" },
    { id: "gr_0002", space: SPACE, subject: { kind: "actor", actor: actor(BOB) }, actions: ["records.*"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" }];
  const gw = createGateway({ space: SPACE, store, log: createEventLog({ space: SPACE, clock }), chains, clock, attrs: () => ({}),
    grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ id) => grants.find(g => g.id === id) },
    members: { has: (/** @type {any} */ a) => a.id === OWNER || a.id === BOB, membership: (/** @type {any} */ a) => (a.id === OWNER ? { role: "owner" } : { role: "member" }) }, hasPresenceSession: () => false });
  const NOTE = { name: "memo", label: "Memo", fields: [{ name: "body", kind: "text", label: "Body" }] };
  await gw.records.define(owner, { add_types: [NOTE] });
  assert.ok(await gw.records.create(bob, "memo", { body: "open type: a member may write" }), "control: before it is protected a member writes it");
  slow = true;
  const defining = gw.records.define(owner, { change_types: [{ ...NOTE, protected: true }] });
  await new Promise(r => setTimeout(r, 50));
  await gw.records.query(bob, "memo", { page: { limit: 5 } });   // a read in the middle of the define builds the cache from the OLD definitions
  release(); await defining;
  slow = false;
  await assert.rejects(() => gw.records.create(bob, "memo", { body: "after: protected" }), { code: "not_allowed" }, "once the define has finished the type is protected for a member");
});
