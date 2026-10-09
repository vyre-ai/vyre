// @ts-check
// R031-83: a Space bundle carries the grants and memberships as plain data (`state`), and a restored Space takes them back with `adopt`: onto an empty Space only, written as a snapshot under the new seal,
// and still there after a rebuild from the log.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../gateway/index.js";
import { createGrantsStore } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { containsDims } from "../core/authorize.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice", BOB = "per_bob", CAROL = "per_carol";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const personChain = (/** @type {string} */ who) => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
const assistantOf = (/** @type {string} */ who, name = "kit") => chains.fromFacts({ kind: "agent_session", agent: name, person: who, session: "s", thread: "t", vouched: true });
const actor = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, space: SPACE });

const used = new Set();
const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) && !used.has(proof.n) && (used.add(proof.n), true) ? null : "wrong_payload") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const P = {
  create: (/** @type {any} */ input) => ({ presence: proof("grants.create", input, `vyre://${SPACE}/grant/new`) }),
  role: (/** @type {any} */ m) => ({ presence: proof("grants.role", m, `vyre://${SPACE}/member/${m.person || m.remove}`) }),
  actor: (/** @type {any} */ a) => ({ presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${a.id}`) }),
};
async function space(key, bootstrap = true) {
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, key: Buffer.alloc(32, key), presence });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true });
  if (bootstrap) await gs.bootstrap({ owner: OWNER });
  return { gs, gw, log };
}

test("a Space's grants and memberships go onto an empty Space under its own seal, and survive a rebuild", async () => {
  const a = await space(5);
  for (const [who, role] of [[ALICE, "member"], [BOB, "admin"]]) await a.gw.grants.setRole(owner(), { person: who, role }, P.role({ person: who, role }));
  const state = JSON.parse(JSON.stringify(a.gs.state()));
  assert.ok(state.memberships.length >= 3);
  // a fresh Space with another key: it knows only its owner
  const b = await space(9);
  assert.equal(b.gs.roleOf({ kind: "person", id: ALICE, space: SPACE }), null);
  await b.gs.adopt(state);
  assert.equal(b.gs.roleOf({ kind: "person", id: ALICE, space: SPACE }), "member");
  assert.equal(b.gs.roleOf({ kind: "person", id: BOB, space: SPACE }), "admin");
  await b.gs.rebuild();
  assert.equal(b.gs.roleOf({ kind: "person", id: BOB, space: SPACE }), "admin", "written as a snapshot this seal made: a rebuild reads it back");
  await assert.rejects(() => b.gs.adopt(state), { code: "bad_input" }, "only while the Space has no members but its owner");
});
