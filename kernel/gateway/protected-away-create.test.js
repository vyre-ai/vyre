// A service that sets a type up at start (the agents roster, the Personal project) is refused as "unavailable", not "not_allowed", while the record store's definitions cannot be read: the callers
// retry only "the store is away" (core/work/retry-away.js, core/agents/mirror.js), so a refusal worded as a permission was given up on for good in a real install (0.5.7).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGateway } from "./index.js";
import { createSqliteStore } from "../store/sqlite.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { mintUuid } from "../core/ids.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
test("while the definitions cannot be read a refused create says the store is starting (retryable); once they can be read it is the permission refusal", async () => {
  let T = 1_800_000_000_000; const clock = () => ++T;
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const bob = chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const real = createSqliteStore({ db: new DatabaseSync(":memory:"), clock });
  await real.define({ add_types: [{ name: "memo", label: "Memo", protected: true, fields: [{ name: "body", kind: "text", label: "Body" }] }] });
  let away = true;
  const store = Object.create(real, { types: { value: async () => { if (away) throw new Error("the record store is away"); return real.types(); } } });
  const grants = [{ id: "gr_0002", space: SPACE, subject: { kind: "actor", actor: actor(BOB) }, actions: ["records.*"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" }];
  const gw = createGateway({ space: SPACE, store, log: createEventLog({ space: SPACE, clock }), chains, clock, attrs: () => ({}),
    grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ i) => grants.find(g => g.id === i) },
    members: { has: (/** @type {any} */ a) => a.id === OWNER || a.id === BOB, membership: (/** @type {any} */ a) => (a.id === OWNER ? { role: "owner" } : { role: "member" }) }, hasPresenceSession: () => false });
  await assert.rejects(() => gw.records.create(bob, "memo", { body: "x" }), (/** @type {any} */ e) => e.code === "unavailable", "away: retryable, not a permission refusal");
  away = false;
  await assert.rejects(() => gw.records.create(bob, "memo", { body: "x" }), (/** @type {any} */ e) => e.code === "not_allowed", "once readable it is the permission refusal");
});
