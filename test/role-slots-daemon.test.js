// @ts-check
// A role named on a task means the Space members who hold that role NOW, on a REAL vyred with the kernel on (not the rig): a reviewer or approver role, quorum all, a group task, and the moment a member's role
// changes or a member is removed. Run it on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CAT = "per_" + "defghijklmnopqrstuvwxyzabc", DAN = "per_" + "efghijklmnopqrstuvwxyzabcd";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const evidence = () => ({ note: "done", sources: ["https://example.test/a"] });

test("a role slot is held by the members who hold the role now: reviewer and approver roles, quorum all, a group task, and a changed or removed member stops holding at once", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space, ask = K.gateway.ask;
  const chainOf = (/** @type {string} */ person) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const setRole = (/** @type {string} */ person, /** @type {string} */ role) => K.gateway.grants.setRole(ownerChain, { person, role }, { presence: proof() });
  for (const [p, r] of [[ANA, "manager"], [BEN, "manager"], [CAT, "member"], [DAN, "manager"]]) await setRole(p, r);
  const me = { kind: "person", id: OWNER, space };
  const given = (/** @type {any} */ over) => ask.request(ownerChain, { title: "Write the letter", doer: me, output: { kind: "note" }, ...over });
  const finish = async (/** @type {string} */ id) => { await ask.start(ownerChain, id); return ask.complete(ownerChain, id, evidence()); };

  // reviewer role with quorum all: every manager must pass; a plain member is not a reviewer
  const a = await given({ reviewer: { role: "manager" }, reviewer_quorum: "all" });
  assert.equal((await finish(a.id)).state, "in_review");
  await assert.rejects(ask.review(chainOf(CAT), a.id, { result: "pass" }), { code: "not_allowed" });
  assert.equal((await ask.review(chainOf(ANA), a.id, { result: "pass" })).state, "in_review", "one manager is not enough");
  assert.equal((await ask.review(chainOf(BEN), a.id, { result: "pass" })).state, "in_review", "all three managers must pass");
  assert.equal((await ask.review(chainOf(DAN), a.id, { result: "pass" })).state, "done");

  // approver role: a manager is the approver (the proof is the next gate), a member is not
  const b = await given({ checker: { role: "manager" } });
  assert.equal((await finish(b.id)).state, "needs_check");
  await assert.rejects(ask.decide(chainOf(CAT), b.id, { outcome: "approved" }), { code: "not_allowed" });
  await assert.rejects(ask.decide(chainOf(ANA), b.id, { outcome: "approved" }), { code: "needs_presence" }, "a manager is past the role check and stops at the proof");

  // a group task: the first manager to start it takes it
  const g = await ask.request(ownerChain, { title: "Anyone", pool: { role: "manager" }, output: { kind: "note" } });
  await assert.rejects(ask.start(chainOf(CAT), g.id), { code: "not_allowed" });
  assert.equal((await ask.start(chainOf(ANA), g.id)).state, "working");
  await assert.rejects(ask.start(chainOf(BEN), g.id), { code: "already_taken" });

  // a changed role stops holding the slot at once
  const c = await given({ reviewer: { role: "manager" } });
  await finish(c.id);
  await setRole(ANA, "member");
  await assert.rejects(ask.review(chainOf(ANA), c.id, { result: "pass" }), { code: "not_allowed" });
  // a removed member stops holding it at once
  await K.gateway.grants.removeMember(ownerChain, { person: BEN }, { presence: proof() });
  await assert.rejects(ask.review(chainOf(BEN), c.id, { result: "pass" }));
  assert.equal((await ask.review(chainOf(DAN), c.id, { result: "pass" })).state, "done", "the manager who is still one can");
});
