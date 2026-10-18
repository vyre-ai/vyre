// A record store that is still starting says so through the gateway: the type list keeps the store's own words ("the record store is still starting: <phase> (N so far)"), so the app can tell "Records is setting up" from a failure.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const grant = { id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: { kind: "person", id: OWNER, space: SPACE } }, actions: ["records.*", "records.define", "records.read"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, conditions: {}, issuer: { kind: "person", id: OWNER, space: SPACE }, source: "test", status: "active", created_at: 0 };

function gatewayOver(/** @type {any} */ store) {
  const log = createEventLog({ space: SPACE, clock });
  return createGateway({ space: SPACE, store, log, chains, clock, attrs: () => ({}),
    grants: { forSubject: (/** @type {any} */ a) => (a.kind === "person" && a.id === OWNER ? [grant] : []), get: (/** @type {string} */ id) => (id === grant.id ? grant : undefined) },
    members: { has: (/** @type {any} */ a) => a.id === OWNER }, hasPresenceSession: () => true });
}

test("definitions: a store still starting keeps its own words and the unavailable code; any other store failure is the plain sentence", async () => {
  const starting = createMemoryStore({ clock });
  starting.types = async () => { throw Object.assign(new Error("the record store is still starting: downloading it (the first time only) (12 seconds so far)"), { code: "unavailable" }); };
  await assert.rejects(() => gatewayOver(starting).definitions(owner()), (/** @type {any} */ e) => e.code === "unavailable" && /the record store is still starting: downloading it/.test(e.message));
  const broken = createMemoryStore({ clock });
  broken.types = async () => { throw new Error("connection reset by 10.0.0.7"); };
  await assert.rejects(() => gatewayOver(broken).definitions(owner()), (/** @type {any} */ e) => e.code === "unavailable" && e.message === "the store could not list its types" && !/10\.0\.0\.7/.test(e.message));
});
