import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createPresence, signProof } from "./presence.js";
import { createTasks, TASK_ACTIONS, checkOutput } from "./tasks.js";
import { buildCard } from "./card.js";
import { createAuthorizer } from "../core/authorize.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder, chainHash } from "../core/chain.js";
import { canonical, sha256 } from "../core/canonical.js";
import { createSealClient } from "../seal/client.js";
import { createSeal, SEAL_ACTIONS, sealUsePayloadHash } from "../seal/index.js";

const SPACE = "spc_aaaaaaaaaaaa";
let T = 1_800_000_000_000;
const clock = () => ++T;
const kp = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

// ---- presence ----
test("presence: a hardware signer's signature over this payload, this decision and this chain is accepted, once", () => {
  const presence = createPresence({ clock });
  const { publicKey, privateKey } = kp();
  presence.enroll("k1", { person: "per_alice", signer: "secure_enclave", public_key: publicKey });
  const f = (over = {}) => ({ signer: "secure_enclave", key_id: "k1", payload_hash: "ph", decision: "dec_1", chain_hash: "ch", issued_at: T, expires_at: T + 60_000, nonce: `n${Math.random()}`, ...over });
  const ctx = { person: "per_alice", payload_hash: "ph", decision: "dec_1", chain_hash: "ch" };
  const p = signProof(privateKey, f());
  assert.equal(presence.verify(p, ctx), true);
  assert.equal(presence.verify(p, { ...ctx, person: "per_bob" }), false, "another person's key");
  assert.equal(presence.verify(p, { ...ctx, payload_hash: "other" }), false);
  assert.equal(presence.verify(p, { ...ctx, decision: "dec_2" }), false);
  assert.equal(presence.verify(p, { ...ctx, chain_hash: "x" }), false);
  assert.equal(presence.verify({ ...p, payload_hash: "other" }, { ...ctx, payload_hash: "other" }), false, "a changed field breaks the signature");
  assert.equal(presence.verify(signProof(privateKey, f({ expires_at: T - 1 })), ctx), false, "expired");
  assert.equal(presence.verify(signProof(privateKey, f({ issued_at: T + 10 * 60_000, expires_at: T + 11 * 60_000 })), ctx), false, "from the future");
  assert.equal(presence.verify(signProof(privateKey, f({ expires_at: T + 3_600_000 })), ctx), false, "a long-lived proof");
  assert.equal(presence.verify(signProof(kp().privateKey, f()), ctx), false, "signed by a key that is not the enrolled one");
  assert.equal(presence.verify(signProof(privateKey, f({ signer: "tpm" })), ctx), false, "the signer type is the one attested at enrolment");
  assert.equal(presence.verify(signProof(privateKey, f({ key_id: "nope" })), ctx), false);
  assert.equal(presence.verify(p, ctx), true, "verify consumes nothing");
  assert.equal(presence.consume(p), true);
  assert.equal(presence.consume(p), false);
  assert.equal(presence.verify(p, ctx), false, "a used proof is no longer good");
  const q = signProof(privateKey, f());
  presence.revoke("k1");
  assert.equal(presence.verify(q, ctx), false, "a revoked key");
  assert.throws(() => presence.enroll("k2", { person: "per_alice", signer: "software", public_key: publicKey }));
});

// ---- tasks ----
const key = Buffer.alloc(32, 5);
const chains = createChainBuilder({ space: SPACE, owner: "per_owner", owner_uid: 501, key, clock, is_person: () => true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
const personChain = who => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
const agentChain = (name = "research") => chains.fromFacts({ kind: "agent_session", agent: name, session: "s", thread: "t", vouched: true });
const OWNER = "per_owner", ALICE = "per_alice", BOB = "per_bob";
const owner = () => personChain(OWNER), alice = () => personChain(ALICE), bob = () => personChain(BOB);
let gid = 0;
const G = (a, actions) => ({ id: `gr_${String(++gid).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: a }, actions, action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0 });

function rig(over = {}) {
  const people = [OWNER, ALICE, BOB];
  const agents = ["research", "intake", "rogue"];
  const grants = [...people.map(p => G(actor("person", p), ["tasks.*", "seal.*"])), ...agents.map(a => G(actor("agent", a), ["tasks.work", "tasks.read", "seal.*"]))];
  const members = new Set([...people.map(p => `person:${p}`), ...agents.map(a => `agent:${a}`), "service:tasks"]);
  const keys = {};
  const presence = createPresence({ clock });
  for (const p of people) { const k = kp(); keys[p] = k.privateKey; presence.enroll(`key-${p}`, { person: p, signer: "secure_enclave", public_key: k.publicKey }); }
  const log = createEventLog({ space: SPACE, clock });
  const authorizer = createAuthorizer({
    space: SPACE, actions: [...TASK_ACTIONS, ...SEAL_ACTIONS, { action: "email.send", resource_type: "message", risk: "outward.send", label: "send", gloss: "" }], clock,
    grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id).concat(a.kind === "person" ? [G(a, ["email.send"])] : []), get: () => undefined },
    members: { has: a => members.has(`${a.kind}:${a.id}`) },
    hasPresenceSession: () => true, verifyPresence: () => true,
  });
  const released = [];
  const roles = { attorney: [actor("person", ALICE), actor("agent", "intake")] };
  const state = { roles };
  const tasks = createTasks({
    space: SPACE, authorizer, log, presence, chains, clock,
    members: { has: a => members.has(`${a.kind}:${a.id}`) }, roleHolders: r => state.roles[r] || [], approver: () => actor("person", OWNER),
    responsible: (p, doer) => p.id === OWNER, responsibleFor: () => actor("person", OWNER),
    facts: { record: async () => ({ data: { size: 12, partner: "x", empty: "" } }), exists: async u => u.startsWith("vyre://") },
    release: async (t, body, by) => { if (over.releaseFails) throw new Error("smtp down"); released.push({ id: t.id, body, by }); },
  });
  const proof = (chain, who, t, over2 = {}) => signProof(keys[who], { signer: "secure_enclave", key_id: `key-${who}`, payload_hash: t.payload.payload_hash, decision: t.payload.decision, chain_hash: chainHash(chain), issued_at: T, expires_at: T + 60_000, nonce: `n${Math.random()}`, ...over2 });
  return { tasks, log, presence, released, state, proof, authorizer, keys };
}
const draftTask = (over = {}) => ({ title: "Welcome email for Jane Doe", doer: actor("agent", "intake"), checker: actor("person", ALICE), output: { kind: "sent" }, record: `vyre://${SPACE}/matter/m1`, ...over });
const payload = (over = {}) => ({ what: "the welcome email", recipients: [{ address: "jane@example.com", verified: false, record: `vyre://${SPACE}/contact/c1` }], template: { id: `vyre://${SPACE}/template/welcome`, version: 1 }, account: "firm-mail", ...over });
const evidenceSent = (over = {}) => ({ payload: payload(), action: "email.send", resource: `vyre://${SPACE}/message/m1`, ...over });
const asIntake = () => agentChain("intake");

async function toNeedsCheck(r, spec = draftTask(), ev = evidenceSent()) {
  const t = await r.tasks.request(owner(), spec);
  await r.tasks.start(asIntake(), t.id);
  return r.tasks.complete(asIntake(), t.id, ev);
}

test("request: only the allowed fields; the kernel writes state, outcome, payload and who assigned it", async () => {
  const r = rig();
  for (const k of ["state", "outcome", "payload", "labels", "assigned_by", "id", "stuck"]) await assert.rejects(() => r.tasks.request(owner(), { ...draftTask(), [k]: "x" }), { code: "bad_input" }, k);
  await assert.rejects(() => r.tasks.request(owner(), { ...draftTask(), source: "gate_hold" }), { code: "bad_input" });
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ doer: actor("agent", "ghost") })), { code: "not_a_member" });
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ output: { kind: "wish" } })), { code: "bad_input" });
  const t = await r.tasks.request(owner(), draftTask());
  assert.equal(t.state, "ready");
  assert.equal(t.assigned_by.id, OWNER);
  assert.equal(t.labels.trust, "member");
  assert.ok(Object.isFrozen(t));
  assert.equal(r.log.read({ type: "task.created" }).length, 1);
});

test("request: the checker is a person, never the doer; a role expands to the humans who hold it; a send always has one", async () => {
  const r = rig();
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ checker: actor("agent", "research") })), { code: "same_actor" }, "an assistant is not a checker");
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ doer: actor("person", ALICE), checker: actor("person", ALICE) })), { code: "same_actor" });
  const viaRole = await r.tasks.request(owner(), draftTask({ checker: { role: "attorney" } }));
  assert.deepEqual(viaRole.checker, { role: "attorney" });
  r.state.roles.attorney = [actor("agent", "intake")];
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ checker: { role: "attorney" } })), { code: "no_checker" }, "a role held only by an assistant has no checker");
  const none = await r.tasks.request(owner(), draftTask({ checker: undefined }));
  assert.deepEqual(none.checker, actor("person", OWNER), "a send with no checker gets the approver");
  const r2 = createTasks({ space: SPACE, authorizer: r.authorizer, log: r.log, presence: r.presence, chains, clock, members: { has: () => true } });
  await assert.rejects(() => r2.request(owner(), draftTask({ checker: undefined })), { code: "no_checker" });
});

test("work: only the doer moves its task, an assistant's chain carries its assigner, and every move follows the table", async () => {
  const r = rig();
  const t = await r.tasks.request(owner(), draftTask());
  await assert.rejects(() => r.tasks.start(owner(), t.id), { code: "not_allowed" }, "the assigner is not the doer");
  await assert.rejects(() => r.tasks.start(alice(), t.id), { code: "not_allowed" });
  await assert.rejects(() => r.tasks.start(agentChain("rogue"), t.id), { code: "not_allowed" }, "an assistant cannot move a task it does not own");
  const sneaky = chains.fromFacts({ kind: "agent_session", agent: "intake", session: "s", thread: "t", vouched: true });
  const byBob = createChainBuilder({ space: SPACE, owner: BOB, owner_uid: 502, key, clock }).fromFacts({ kind: "agent_session", agent: "intake", session: "s", thread: "t", vouched: true });
  await assert.rejects(() => r.tasks.start(byBob, t.id), { code: "not_allowed" }, "intake working for Bob is not intake working for the person who assigned it");
  const w = await r.tasks.start(sneaky, t.id);
  assert.equal(w.state, "working");
  await assert.rejects(() => r.tasks.start(sneaky, t.id), { code: "bad_state" });
  await assert.rejects(() => r.tasks.decide(alice(), t.id, { outcome: "approved" }), { code: "bad_state" }, "a working task is not waiting for a check");
});

test("complete: the kernel checks the declared output first; an assistant cannot mark a task done while the check fails", async () => {
  const r = rig();
  const mk = async (output, check) => { const t = await r.tasks.request(owner(), { title: "t", doer: actor("agent", "research"), output, record: `vyre://${SPACE}/matter/m1`, ...(check ? { checker: undefined } : {}) }); await r.tasks.start(agentChain("research"), t.id); return t; };
  const run = (t, ev) => r.tasks.complete(agentChain("research"), t.id, ev);
  const f = await mk({ kind: "fields", target: ["size", "empty"] });
  await assert.rejects(() => run(f, {}), { code: "output_check_failed" });
  assert.equal((await r.tasks.get(owner(), f.id)).state, "working");
  const f2 = await mk({ kind: "fields", target: ["size", "partner"] });
  assert.equal((await run(f2, {})).state, "done");
  const n = await mk({ kind: "note" });
  await assert.rejects(() => run(n, { note: "found it", sources: [] }), { code: "output_check_failed" });
  assert.equal((await run(n, { note: "found it", sources: ["https://x"] })).state, "done");
  const d = await mk({ kind: "decision" });
  await assert.rejects(() => run(d, { answer: "maybe", reason: "x" }), { code: "output_check_failed" });
  await assert.rejects(() => run(d, { answer: "yes", reason: " " }), { code: "output_check_failed" });
  assert.equal((await run(d, { answer: "no", reason: "conflict" })).state, "done");
  const dr = await mk({ kind: "draft" });
  await assert.rejects(() => run(dr, { draft: "nope" }), { code: "output_check_failed" });
  assert.equal((await run(dr, { draft: `vyre://${SPACE}/message/d1` })).state, "done");
  const fl = await mk({ kind: "file" });
  assert.equal((await run(fl, { file: `vyre://${SPACE}/file/f1` })).state, "done");
  assert.deepEqual(await checkOutput({ output: { kind: "wish" } }, {}, {}), { ok: false, why: "unknown output kind" });
});

test("complete: a guarded task waits for its checker with a payload the kernel hashed; the log carries hashes, never the draft", async () => {
  const r = rig();
  const t = await toNeedsCheck(r);
  assert.equal(t.state, "needs_check");
  assert.equal(t.payload.payload_hash, sha256(canonical(payload())));
  assert.match(t.payload.decision, /^dec_/);
  const ev = r.log.read({ type: "task.needs-check" })[0];
  assert.equal(ev.data.payload_hash, t.payload.payload_hash);
  assert.ok(!JSON.stringify(r.log.read()).includes("jane@example.com"));
  await assert.rejects(() => r.tasks.complete(asIntake(), t.id, evidenceSent()), { code: "bad_state" });
  const bad = await r.tasks.request(owner(), draftTask());
  await r.tasks.start(asIntake(), bad.id);
  await assert.rejects(() => r.tasks.complete(asIntake(), bad.id, { payload: payload() }), { code: "output_check_failed" }, "a send without its action and resource");
});

test("decide: human-only. One person, the checker, not the doer, a signer's proof over this payload and chain, once", async () => {
  const r = rig();
  const t = await toNeedsCheck(r);
  const A = alice();
  // not a person on their own
  const alicesAgent = chains.fromFacts({ kind: "module", module: "tasks", first_party: true, inbound: A });
  await assert.rejects(() => r.tasks.decide(alicesAgent, t.id, { outcome: "approved", proof: r.proof(alicesAgent, ALICE, t) }), { code: "chain_not_person" });
  await assert.rejects(() => r.tasks.decide(agentChain("intake"), t.id, { outcome: "approved", proof: r.proof(A, ALICE, t) }), { code: "chain_not_person" }, "the doer assistant cannot approve its own work");
  // a person who is not the checker
  await assert.rejects(() => r.tasks.decide(bob(), t.id, { outcome: "approved", proof: r.proof(bob(), BOB, t) }), { code: "not_allowed" });
  // proofs that do not cover exactly this
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved" }), { code: "needs_presence" });
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved", proof: r.proof(A, ALICE, t, { payload_hash: "other" }) }), { code: "needs_presence" });
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved", proof: r.proof(A, ALICE, t, { decision: "dec_other" }) }), { code: "needs_presence" });
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved", proof: r.proof(bob(), ALICE, t) }), { code: "needs_presence" }, "a proof for another chain");
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved", proof: r.proof(A, BOB, t) }), { code: "needs_presence" }, "another person's key");
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved", proof: r.proof(A, ALICE, t, { expires_at: 1 }) }), { code: "needs_presence" });
  assert.equal(r.released.length, 0);
  const good = r.proof(A, ALICE, t);
  const done = await r.tasks.decide(A, t.id, { outcome: "approved", proof: good });
  assert.deepEqual([done.state, done.outcome], ["done", "approved"]);
  assert.equal(r.released.length, 1);
  assert.equal(r.released[0].body.recipients[0].address, "jane@example.com");
  assert.equal(r.released[0].by.person, ALICE);
  await assert.rejects(() => r.tasks.decide(A, t.id, { outcome: "approved", proof: good }), { code: "bad_state" });
  const ev = r.log.read({ type: "task.approved" })[0];
  assert.equal(ev.actor, `person:${ALICE}@${SPACE}`);
  assert.equal(ev.data.payload_hash, t.payload.payload_hash);
});

test("decide: the doer is never the checker, whatever device they use, and a role is resolved again at approval", async () => {
  const r = rig();
  const t = await toNeedsCheck(r, draftTask({ checker: { role: "attorney" } }));
  r.state.roles.attorney = [actor("person", BOB)];
  await assert.rejects(() => r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) }), { code: "not_allowed" }, "no longer holds the role");
  const done = await r.tasks.decide(bob(), t.id, { outcome: "approved", proof: r.proof(bob(), BOB, t) });
  assert.equal(done.state, "done");
  const mine = await r.tasks.request(owner(), { title: "mine", doer: actor("person", ALICE), checker: actor("person", BOB), output: { kind: "decision" } });
  await r.tasks.start(alice(), mine.id);
  const w = await r.tasks.complete(alice(), mine.id, { answer: "yes", reason: "ok" });
  assert.equal(w.state, "needs_check");
  const second = personChain(ALICE);
  await assert.rejects(() => r.tasks.decide(second, mine.id, { outcome: "approved", proof: r.proof(second, ALICE, w) }), { code: "not_allowed" }, "one human on two devices is one actor");
});

test("decide: a failed release is not an approval; a changed draft voids it; a new payload needs a new proof", async () => {
  const bad = rig({ releaseFails: true });
  const t = await toNeedsCheck(bad);
  const A = alice(), p = bad.proof(A, ALICE, t);
  await assert.rejects(() => bad.tasks.decide(A, t.id, { outcome: "approved", proof: p }), { code: "unavailable" });
  assert.equal((await bad.tasks.get(owner(), t.id)).state, "needs_check");
  const r = rig();
  const n = await toNeedsCheck(r);
  const old = r.proof(A, ALICE, n);
  const v = await r.tasks.revise(asIntake(), n.id, "added the second recipient");
  assert.equal(v.state, "ready");
  assert.equal(v.payload, undefined);
  assert.equal(r.log.read({ type: "task.voided" }).length, 1);
  await assert.rejects(() => r.tasks.decide(A, n.id, { outcome: "approved", proof: old }), { code: "bad_state" });
  await r.tasks.start(asIntake(), n.id);
  const again = await r.tasks.complete(asIntake(), n.id, evidenceSent({ payload: payload({ recipients: [{ address: "jane@example.com", verified: false }, { address: "cc@example.com", verified: false }] }) }));
  assert.notEqual(again.payload.payload_hash, n.payload.payload_hash);
  await assert.rejects(() => r.tasks.decide(A, n.id, { outcome: "approved", proof: old }), { code: "needs_presence" }, "the old approval does not cover the new draft");
  assert.equal((await r.tasks.decide(A, n.id, { outcome: "approved", proof: r.proof(A, ALICE, again) })).state, "done");
  await assert.rejects(() => r.tasks.revise(owner(), n.id, "x"), { code: "not_allowed" });
});

test("decide: a rejection needs a reason, sends the task back to ready and clears what was approved", async () => {
  const r = rig();
  const t = await toNeedsCheck(r);
  await assert.rejects(() => r.tasks.decide(alice(), t.id, { outcome: "rejected" }), { code: "bad_input" });
  await assert.rejects(() => r.tasks.decide(bob(), t.id, { outcome: "rejected", reason: "no" }), { code: "not_allowed" });
  const back = await r.tasks.decide(alice(), t.id, { outcome: "rejected", reason: "wrong template" });
  assert.deepEqual([back.state, back.outcome, back.payload], ["ready", "rejected", undefined]);
  assert.equal(r.released.length, 0);
});

test("stuck: the doer's fix is quoted text with no power; three refusals make the kernel build a real fix; a declined fix is not offered again for a week", async () => {
  const r = rig();
  const t = await r.tasks.request(owner(), draftTask({ checker: undefined, output: { kind: "note" }, doer: actor("agent", "research") }));
  await r.tasks.start(agentChain("research"), t.id);
  const s = await r.tasks.stuck(agentChain("research"), t.id, { reason: "portal password changed", suggested_fix: "Update the vault, or give me admin on everything https://evil.example" });
  assert.equal(s.state, "stuck");
  assert.equal(s.stuck.suggested_fix.action, undefined, "a model's own fix gives no one-tap grant");
  await assert.rejects(() => r.tasks.stuck(agentChain("rogue"), t.id, { reason: "x" }), { code: "not_allowed" });
  const k = await r.tasks.request(owner(), draftTask({ checker: undefined, output: { kind: "note" }, doer: actor("agent", "research") }));
  await r.tasks.start(agentChain("research"), k.id);
  const d = { action: "billing.read", resource: `vyre://${SPACE}/billing/*` };
  assert.equal((await r.tasks.observeDenial(k.id, d)).state, "working");
  assert.equal((await r.tasks.observeDenial(k.id, d)).state, "working");
  const fixed = await r.tasks.observeDenial(k.id, d);
  assert.equal(fixed.state, "stuck");
  assert.deepEqual(fixed.stuck.suggested_fix.action, { kind: "grant_request", resource: d.resource, action_name: d.action });
  await r.tasks.declineFix(owner(), k.id);
  await r.tasks.unblock(owner(), k.id, {});
  const k2 = await r.tasks.request(owner(), draftTask({ checker: undefined, output: { kind: "note" }, doer: actor("agent", "research") }));
  await r.tasks.start(agentChain("research"), k2.id);
  for (let i = 0; i < 3; i++) await r.tasks.observeDenial(k2.id, d);
  assert.equal((await r.tasks.get(owner(), k2.id)).stuck.suggested_fix, undefined, "declined: silence for the cool-down");
});

test("unblock: never the doer; the responsible person may, anyone else needs a proof over this; reassigning cannot make the checker the doer", async () => {
  const r = rig();
  const mk = async () => { const t = await r.tasks.request(owner(), draftTask({ checker: actor("person", ALICE), output: { kind: "decision" }, doer: actor("agent", "research") })); await r.tasks.start(agentChain("research"), t.id); return r.tasks.stuck(agentChain("research"), t.id, { reason: "x" }); };
  const t = await mk();
  await assert.rejects(() => r.tasks.unblock(agentChain("research"), t.id, {}), { code: "chain_not_person" });
  await assert.rejects(() => r.tasks.unblock(bob(), t.id, {}), { code: "needs_presence" });
  const want = sha256(canonical({ op: "unblock", task: t.id, reassign_to: null }));
  const p = signProof(r.keys[BOB], { signer: "secure_enclave", key_id: `key-${BOB}`, payload_hash: want, decision: "d", chain_hash: chainHash(bob()), issued_at: T, expires_at: T + 60_000, nonce: "u1" });
  assert.equal((await r.tasks.unblock(bob(), t.id, { proof: p })).state, "ready");
  const t2 = await mk();
  await assert.rejects(() => r.tasks.unblock(owner(), t2.id, { reassign_to: actor("person", ALICE) }), { code: "same_actor" });
  const re = await r.tasks.unblock(owner(), t2.id, { reassign_to: actor("agent", "intake") });
  assert.deepEqual(re.doer, actor("agent", "intake"));
  assert.equal(re.stuck, undefined);
  await assert.rejects(() => r.tasks.unblock(owner(), t2.id, {}), { code: "bad_state" });
});

test("skip: the doer may skip an unguarded task; a guarded one raises a proposal only a person with presence can approve", async () => {
  const r = rig();
  const free = await r.tasks.request(owner(), draftTask({ checker: undefined, output: { kind: "note" }, doer: actor("agent", "research") }));
  assert.equal((await r.tasks.skip(agentChain("research"), free.id, "not needed")).state, "skipped");
  const g = await r.tasks.request(owner(), draftTask({ doer: actor("agent", "research"), output: { kind: "decision" }, checker: actor("person", ALICE) }));
  const res = await r.tasks.skip(agentChain("research"), g.id, "not needed");
  assert.ok(res.proposal);
  assert.equal((await r.tasks.get(owner(), g.id)).state, "ready", "the doer's own skip changes nothing");
  const p = res.proposal;
  await assert.rejects(() => r.tasks.decide(agentChain("research"), p.id, { outcome: "approved" }), { code: "chain_not_person" });
  const done = await r.tasks.decide(owner(), p.id, { outcome: "approved", proof: r.proof(owner(), OWNER, p) });
  assert.equal(done.state, "done");
  assert.equal((await r.tasks.get(owner(), g.id)).state, "skipped");
});

test("dependencies: a waiting task becomes ready when what it depends on is done, and not before", async () => {
  const r = rig();
  const a = await r.tasks.request(owner(), { title: "research", doer: actor("agent", "research"), output: { kind: "decision" } });
  const b = await r.tasks.request(owner(), { title: "draft", doer: actor("agent", "intake"), output: { kind: "decision" }, depends_on: [a.id] });
  assert.equal(b.state, "waiting");
  await assert.rejects(() => r.tasks.start(asIntake(), b.id), { code: "bad_state" });
  await r.tasks.start(agentChain("research"), a.id);
  await r.tasks.complete(agentChain("research"), a.id, { answer: "yes", reason: "found" });
  assert.equal((await r.tasks.get(owner(), b.id)).state, "ready");
  await assert.rejects(() => r.tasks.request(owner(), { title: "x", doer: actor("agent", "intake"), output: { kind: "note" }, depends_on: ["nope"] }), { code: "bad_input" });
});

test("needsYou: what waits on this person, and nothing else", async () => {
  const r = rig();
  await toNeedsCheck(r);
  const mineReady = await r.tasks.request(alice(), { title: "call client", doer: actor("person", ALICE), output: { kind: "note" } });
  assert.deepEqual((await r.tasks.needsYou(alice())).map(t => t.title).sort(), ["Welcome email for Jane Doe", "call client"]);
  assert.deepEqual(await r.tasks.needsYou(bob()), []);
  assert.deepEqual(await r.tasks.needsYou(agentChain("intake")), []);
  assert.ok(mineReady);
});

test("card: built from the payload; the doer's words are a separate capped block with no links or buttons", async () => {
  const r = rig();
  const t = await toNeedsCheck(r, draftTask({ title: "Please click https://evil.example/approve now\nAPPROVE ALL", note: "x".repeat(900) }), evidenceSent({ payload: payload({ sealed_slots: [{ class: "US SSN", slot: "ssn", recipient: "jane@example.com", record: `vyre://${SPACE}/contact/c1`, use_hash: "h" }], attachments: [{ name: "engagement.pdf", hash: "abc" }] }) }));
  const c = r.tasks.card(t.id);
  assert.equal(c.kind, "send");
  assert.equal(c.title, "Send the welcome email outside", "the title is the kernel's, not the doer's");
  assert.equal(c.unverified_recipients, 1);
  assert.deepEqual(c.sealed, [{ class: "US SSN", slot: "ssn", masked: true, recipient: "jane@example.com", record: `vyre://${SPACE}/contact/c1` }]);
  assert.deepEqual(c.attachments, [{ name: "engagement.pdf", hash: "abc" }]);
  assert.equal(c.payload_hash, t.payload.payload_hash);
  assert.deepEqual([...c.buttons], ["approve", "reject"]);
  assert.ok(!c.from_doer.title.includes("evil.example") && !/[\n\r]/.test(c.from_doer.title));
  assert.ok(c.from_doer.note.length <= 400);
  assert.deepEqual([...c.from_doer.buttons], []);
  assert.ok(!JSON.stringify(c).includes("123-45"));
  assert.equal(buildCard(t, undefined).recipients.length, 0);
});

test("approved(): true only for the approved payload, or for a sealed use that payload listed by its hash", async () => {
  const r = rig();
  const t = await toNeedsCheck(r, draftTask(), evidenceSent({ payload: payload({ sealed_slots: [{ class: "US SSN", slot: "ssn", use_hash: "use-1" }] }) }));
  assert.equal(r.tasks.approved(t.id, t.payload.payload_hash), false, "not before the checker approves");
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  assert.equal(r.tasks.approved(t.id, t.payload.payload_hash), true);
  assert.equal(r.tasks.approved(t.id, "use-1"), true);
  assert.equal(r.tasks.approved(t.id, "use-2"), false);
  assert.equal(r.tasks.approved("nope", "x"), false);
});

test("end to end: Intake drafts the welcome email with a sealed slot, Alice approves with her signer, and only then does the kernel merge the SSN", async () => {
  const r = rig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k4-seal-"));
  const client = createSealClient({ vault_key: Buffer.alloc(32, 8), dir: path.join(dir, "v"), egress_dir: path.join(dir, "out"), clock });
  const REC = `vyre://${SPACE}/contact/c1`;
  const seal = createSeal({
    space: SPACE, client, authorizer: r.authorizer, log: r.log, clock,
    templates: async (u, v) => ({ id: u, version: v, body: "Hello Jane. SSN on file: {{ssn}}.", slots: ["ssn"], headers: { subject: "Welcome" } }),
    approvedTask: (task, hash) => r.tasks.approved(task, hash),
    verifyPresence: p => Boolean(p),
  });
  const { ref } = await seal.put({ chain: owner(), record: REC, field: "ssn", class: "us-ssn", value: "123-45-6789" });
  const use = { ref: ref.ref, template: `vyre://${SPACE}/template/welcome`, template_version: 1, slot: "ssn", destination: { kind: "contact_point", record: REC, contact: "jane@example.com", verified: false } };
  const useHash = sealUsePayloadHash(use);
  const t = await toNeedsCheck(r, draftTask(), evidenceSent({ payload: payload({ sealed_slots: [{ class: "US SSN", slot: "ssn", recipient: "jane@example.com", record: REC, use_hash: useHash }] }) }));
  // before approval, the model's plan cannot use the sealed value, even naming its own task
  await assert.rejects(() => seal.use({ chain: asIntake(), ...use, task: t.id }), { code: "needs_approval" });
  assert.equal(fs.existsSync(path.join(dir, "out")) ? fs.readdirSync(path.join(dir, "out")).length : 0, 0);
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  // after approval of exactly this payload, the kernel merges at the egress boundary and nothing returns the value
  const res = await seal.use({ chain: asIntake(), ...use, task: t.id });
  assert.equal(res.merged, true);
  assert.ok(!JSON.stringify(res).includes("6789"));
  assert.equal(fs.readFileSync(path.join(dir, "out", fs.readdirSync(path.join(dir, "out"))[0]), "utf8"), "Hello Jane. SSN on file: 123-45-6789.");
  // a different destination was never approved
  await assert.rejects(() => seal.use({ chain: asIntake(), ...use, destination: { ...use.destination, contact: "evil@example.com" }, task: t.id }), { code: "needs_approval" });
  assert.ok(!JSON.stringify(r.log.read()).includes("6789"));
  assert.ok(!JSON.stringify(r.log.read()).includes("123-45"));
  await client.close();
});
