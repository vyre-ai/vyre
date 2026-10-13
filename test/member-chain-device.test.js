// @ts-check
// A member's device that came in on her identity chain (design B) acts as HER, never as the owner: callerFacts gives it her person facts only while she is a member right now, the kernel then reads her role live, and every
// owner-only gate still refuses it. Against a real kernel.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../kernel/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";
import { CONTACT } from "../kernel/conformance/suite.js";
import { callerFacts, deviceIsOwner } from "../core/daemon/index.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", AMY = "per_amy";
const key = Buffer.alloc(32, 7);
const proofFor = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const boot = () => createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key, presence: { check: async () => null }, hasPresenceSession: () => true });
/** What the daemon passes callerFacts as the kernel: its identity (the real kernel is used for roles and chains). */
const D = { id: { owner: OWNER, space: SPACE } };
const policy = { caller: "device:abcdefghijklmnop" };
/** The device row the daemon builds: the relay's row with the chain fact, and the live membership role. */
const row = (/** @type {Record<string, any>} */ o = {}) => ({ kind: "app", removed: false, ownerPaired: false, homeOwner: false, person: null, viaChain: { identity: BOB, limited: false }, memberRole: "member", ...o });

async function world() {
  const k = await boot();
  const o = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(o, { add_types: [CONTACT] });
  for (const p of [BOB, AMY]) { const role = { person: p, role: "member" }; await k.gateway.grants.setRole(o, role, { presence: proofFor("grants.role", role, `vyre://${SPACE}/member/${p}`) }); }
  await k.gateway.records.create(o, "contact", { name: "Owner's contact" });
  return { k, o };
}

test("(a) a member's chain device gets HER person facts and the kernel reads her role: she can work, and the owner's own acts are not hers", async () => {
  const { k } = await world();
  const f = callerFacts("device:abcdefghijklmnop", policy, null, D, false, row());
  assert.equal(f?.kind, "device");
  assert.equal(f?.person, BOB);
  assert.equal(k.grants.roleOf({ kind: "person", id: BOB, space: SPACE }), "member");
  const chain = k.chains.fromFacts(/** @type {any} */ (f));
  assert.equal((await k.gateway.records.create(chain, "contact", { name: "Made on her laptop" })).data.name, "Made on her laptop");
  assert.equal(deviceIsOwner(row(), OWNER), false, "never the owner's");
  const ownerOnly = { person: AMY, role: "admin" };
  await assert.rejects(() => k.gateway.grants.setRole(chain, ownerOnly, { presence: proofFor("grants.role", ownerOnly, `vyre://${SPACE}/member/${AMY}`) }), /./, "an owner-only act is refused to her");
});

test("(c) a member who was removed gets no facts at all, even with the same chain device", async () => {
  const { k } = await world();
  assert.equal(callerFacts("device:abcdefghijklmnop", policy, null, D, false, row({ memberRole: null })), null);
});

test("(f) a device's facts name only the identity stored when it was admitted: A's device never produces B's facts", async () => {
  const { k } = await world();
  const a = callerFacts("device:aaaaaaaaaaaaaaaa", { caller: "device:aaaaaaaaaaaaaaaa" }, null, D, false, row({ viaChain: { identity: BOB } }));
  const b = callerFacts("device:bbbbbbbbbbbbbbbb", { caller: "device:bbbbbbbbbbbbbbbb" }, null, D, false, row({ viaChain: { identity: AMY } }));
  assert.equal(a?.person, BOB);
  assert.equal(b?.person, AMY);
  assert.notEqual(a?.device_key_id, b?.device_key_id);
  // nothing the caller sends picks the person: a row with no chain fact and no owner standing gives none
  assert.equal(callerFacts("device:cccccccccccccccc", { caller: "device:cccccccccccccccc" }, null, D, false, row({ viaChain: undefined })), null);
});

test("the owner's chain device is still the owner's, and the owner's identity never goes through the member branch", async () => {
  const { k } = await world();
  const f = callerFacts("device:abcdefghijklmnop", policy, null, D, false, row({ viaChain: { identity: OWNER, limited: false }, memberRole: null }));
  assert.equal(f?.person, OWNER);
  assert.equal(deviceIsOwner(row({ viaChain: { identity: OWNER } }), OWNER), true);
});

test("a removed or web device never gets facts, member or not", async () => {
  const { k } = await world();
  assert.equal(callerFacts("device:abcdefghijklmnop", policy, null, D, false, row({ removed: true })), null);
  assert.equal(callerFacts("device:abcdefghijklmnop", policy, null, D, false, row({ kind: "web" })), null);
  assert.equal(callerFacts("device:abcdefghijklmnop", policy, null, D, false, null), null);
});

test("the limited flag rides in her facts so the registry's gate can see it", async () => {
  const { k } = await world();
  assert.equal(callerFacts("device:abcdefghijklmnop", policy, null, D, false, row({ viaChain: { identity: BOB, limited: true } }))?.limited, true);
  assert.equal(callerFacts("device:abcdefghijklmnop", policy, null, D, false, row())?.limited, false);
});
