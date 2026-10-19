// @ts-check
// The kernel's remote path (kernel/core/authorize.js presenceNotNeeded): the walk's log showed grants.invites.create refused as needs_presence by the kernel itself, which never asked the module floor. With no counted presence
// device the home's owner as one person passes it; a member, an agent chain and the ownership acts never do; once a phone counts the proof is asked again. The same Presence answers both layers.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { createKernel } from "../../kernel/index.js";
import { noPresenceForChain } from "./index.js";
import { tempHome, enrolDevice } from "../../test/helpers.js";

const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");

test("the kernel's remote path: the owner as one person passes an invite with no counted device, and not once a phone counts; an agent, another person and the ownership acts never pass", { timeout: 120_000 }, async () => {
  const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", ADA = "per_ada";
  let device = false;
  const fake = { hasPresenceDevice: () => device };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence: { check: async () => "wrong_proof" }, presenceNotNeeded: (/** @type {any} */ q) => noPresenceForChain({ presence: fake, owner: () => OWNER }, q) });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct", session: `s-${id}` });
  const g = k.gateway.grants;
  const owner = dev(OWNER, "d-o");
  const card = await g.invites.create(owner, { role: "member" });
  assert.ok(card && card.id, "the owner makes an invite with no counted device: " + JSON.stringify(card));
  // the people and agents that never pass
  await g.setRole(owner, { person: BOB, role: "admin" }).catch(() => {});
  await assert.rejects(() => g.invites.create(dev(BOB, "d-b"), { role: "member" }), /./, "another person is refused");
  const asst = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s-k" });
  await assert.rejects(() => g.invites.create(asst, { role: "member" }), /./, "an assistant is refused");
  // the ownership acts keep asking
  await assert.rejects(() => g.setRole(owner, { person: ADA, role: "owner" }), e => e.code === "needs_presence" || /presence/i.test(e.message));
  await assert.rejects(() => g.transferOwner(owner, { to: ADA }), e => e.code === "needs_presence" || /presence/i.test(e.message));
  // a phone counts: the proof is asked again
  device = true;
  await assert.rejects(() => g.invites.create(owner, { role: "member" }), e => e.code === "needs_presence" || /presence/i.test(e.message), "with a counted phone the proof is asked");
});

test("with the walk's box (two device keys, no relay rows) the real Presence says no counted device, and a hardware phone makes it count", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => d.stop());
  const p = /** @type {any} */ (d.registry.deps.presence);
  const chainOf = (/** @type {string} */ id) => ({ viewer: false, hops: [{ actor: { kind: "person", id } }] });
  const ask = (/** @type {any} */ chain, action = "grants.invite") => noPresenceForChain({ presence: p, owner: () => d.kernel.id.owner }, { chain, action });
  p.enroll({ kind: "device", name: "first-run browser", public_key: key(), alg: -7 });
  p.enroll({ kind: "device", name: "in-page host", public_key: key(), alg: -7 });
  assert.equal(p.keys().length, 2);
  assert.equal(ask(chainOf(d.kernel.id.owner)), true, "the owner passes with the walk's two bare device keys");
  assert.equal(ask(chainOf("per_" + "x".repeat(26))), false, "another person does not");
  assert.equal(ask(chainOf(d.kernel.id.owner), "grants.transferOwner"), false, "ownership asks");
  assert.equal(ask({ viewer: false, hops: [{ actor: { kind: "agent", id: "kit" } }] }), false, "an agent does not");
  enrolDevice(d);
  assert.equal(ask(chainOf(d.kernel.id.owner)), false, "a hardware phone makes the proof required again");
});
