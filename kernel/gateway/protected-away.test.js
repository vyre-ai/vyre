// While the record store's definitions cannot be read (the store is away, or fails for a moment) every type counts as protected for a member: she is served nothing of a type that carries the protected flag, whatever else
// the store answers. Owner, admin and keeper are served as ever, and nothing is remembered: once the definitions can be read again the real set stands.
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
test("definitions that cannot be read: a member is served nothing of a protected type, the owner still is; once they can be read the real set stands", async () => {
  let T = 1_800_000_000_000; const clock = () => ++T;
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const owner = chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const bob = chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const real = createSqliteStore({ db: new DatabaseSync(":memory:"), clock });
  const MEMO = { name: "memo", label: "Memo", protected: true, fields: [{ name: "body", kind: "text", label: "Body" }] };
  await real.define({ add_types: [MEMO] });
  const id = mintUuid(clock());
  await real.create("memo", id, { body: "kept" }, { attrs: { space: SPACE, created_by: `person:${OWNER}` }, urn: `vyre://${SPACE}/memo/${id}` });
  let away = true;
  const store = Object.create(real, { types: { value: async () => { if (away) throw new Error("the record store is away"); return real.types(); } } });
  const grants = [{ id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: actor(OWNER) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" },
    { id: "gr_0002", space: SPACE, subject: { kind: "actor", actor: actor(BOB) }, actions: ["records.*"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active" }];
  const gw = createGateway({ space: SPACE, store, log: createEventLog({ space: SPACE, clock }), chains, clock, attrs: () => ({}),
    grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ i) => grants.find(g => g.id === i) },
    members: { has: (/** @type {any} */ a) => a.id === OWNER || a.id === BOB, membership: (/** @type {any} */ a) => (a.id === OWNER ? { role: "owner" } : { role: "member" }) }, hasPresenceSession: () => false });
  const bobSees = async () => (await gw.records.get(bob, "memo", id).catch(() => null)) !== null;
  assert.equal(await bobSees(), false, "away: a member is served nothing of the protected type");
  away = false;
  assert.equal(await bobSees(), false, "once the definitions can be read the type is protected for her (nothing stale was kept)");
});
