import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import crypto from "node:crypto";
import { Presence } from "../seal/proof.js";
import { payloadHash, proofBytes, chainCtx } from "../seal/wire.js";
import { createTasks, TASK_ACTIONS, checkOutput } from "./tasks.js";
import { buildCard } from "./card.js";
import { createAuthorizer } from "../core/authorize.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { canonical, sha256 } from "../core/canonical.js";
import { ACTIONS as SEAL_ACTIONS } from "../seal/uses.js";
import { createApprovals } from "./approvals.js";
import { createSealing } from "../gateway/sealing.js";

const SPACE = "spc_aaaaaaaaaaaa";
let T = 1_800_000_000_000;
const clock = () => ++T;
const kp = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

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
  const grants = [G(actor("service", "tasks"), ["tasks.request", "tasks.read"]), ...people.map(p => G(actor("person", p), ["tasks.*", "seal.put", "seal.use", "seal.deliver"])), ...agents.map(a => G(actor("agent", a), ["tasks.work", "tasks.read", "seal.use", "email.send"]))];
  const members = new Set([...people.map(p => `person:${p}`), ...agents.map(a => `agent:${a}`), "service:tasks"]);
  const keys = {};
  // The one verifier is vault's Presence class (what the sealing process runs); the rig wraps it the way the process's presence.check does.
  const pr = new Presence(clock, { allowUnattested: true });
  for (const p of people) { const k = kp(); keys[p] = k.privateKey; pr.keys.set(`key-${p}`, { person: p, signer: "secure_enclave", attested: true, key: k.publicKey }); }
  const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof ? pr.refuse(proof, { op, space: SPACE, fields, ctx: chainCtx(chain) }) : "no_proof") };
  const log = over.wrapLog ? over.wrapLog(createEventLog({ space: SPACE, clock })) : createEventLog({ space: SPACE, clock });
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
    members: { has: a => members.has(`${a.kind}:${a.id}`), roleOf: a => (over.roleOf ? over.roleOf(a) : null) }, roleHolders: r => state.roles[r] || [], approver: () => actor("person", OWNER),
    responsible: (p, doer) => p.id === OWNER, responsibleFor: () => actor("person", OWNER),
    resolve: { template: async (id, v) => (v === 1 ? { body: "Hello {{sealed:ssn}}" } : null), contact: async (record, address) => address === "verified@example.com", sealed: async ref => (ref === "sv_1" ? { class: "us-ssn", record: `vyre://${SPACE}/contact/c1` } : null) },
    facts: { record: async () => ({ data: { size: 12, partner: "x", empty: "" } }), exists: async u => u.startsWith("vyre://") },
    release: async (t, body, by) => { if (over.releaseDelay) await new Promise(res => setTimeout(res, over.releaseDelay)); if (over.releaseFails) throw new Error("smtp down"); released.push({ id: t.id, body, by }); },
  });
  const sign = (chain, who, op, fields, over2 = {}) => {
    const base = { signer: "secure_enclave", key_id: `key-${who}`, payload_hash: payloadHash(op, SPACE, fields), decision: op, chain_hash: chainCtx(chain).chain_hash, issued_at: T, expires_at: T + 60_000, nonce: `n${Math.random()}`, ...over2 };
    return { ...base, signature: crypto.sign("sha256", proofBytes(base), { key: keys[who], dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
  const proof = (chain, who, t, over2 = {}) => sign(chain, who, "task.decide", { task: t.id, payload_hash: t.payload.payload_hash, decision: t.payload.decision }, over2);
  return { tasks, log, presence, released, state, proof, sign, authorizer, keys };
}
const draftTask = (over = {}) => ({ title: "Welcome email for Jane Doe", doer: actor("agent", "intake"), checker: actor("person", ALICE), output: { kind: "sent" }, record: `vyre://${SPACE}/contact/c1`, ...over });
const payload = (over = {}) => ({ what: "the welcome email", recipients: [{ address: "jane@example.com", verified: false, record: `vyre://${SPACE}/contact/c1` }], template: { id: `vyre://${SPACE}/template/welcome`, version: 1 }, account: "firm-mail", ...over });
const evidenceSent = (over = {}) => ({ payload: payload(), action: "email.send", resource: `vyre://${SPACE}/message/m1`, ...over });
const asIntake = () => agentChain("intake");
const kernelSvc = () => chains.fromFacts({ kind: "module", module: "tasks", first_party: true });

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
  assert.equal(t.payload.payload_hash, sha256(canonical({ action: "email.send", resource: `vyre://${SPACE}/message/m1`, payload: payload(), facts: { recipients: [{ address: "jane@example.com", record: `vyre://${SPACE}/contact/c1`, verified: false }], sealed: [], template: { id: `vyre://${SPACE}/template/welcome`, version: 1, hash: sha256("Hello {{sealed:ssn}}") } } })));
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
  assert.equal(r.released[0].body.payload.recipients[0].address, "jane@example.com");
  assert.equal(r.released[0].body.action, "email.send", "the egress is given the action and resource that were approved");
  assert.equal(r.released[0].body.resource, `vyre://${SPACE}/message/m1`);
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
  assert.equal((await r.tasks.observeDenial(kernelSvc(), k.id, d)).state, "working");
  assert.equal((await r.tasks.observeDenial(kernelSvc(), k.id, d)).state, "working");
  const fixed = await r.tasks.observeDenial(kernelSvc(), k.id, d);
  assert.equal(fixed.state, "stuck");
  assert.deepEqual(fixed.stuck.suggested_fix.action, { kind: "grant_request", resource: d.resource, action_name: d.action });
  await r.tasks.declineFix(owner(), k.id);
  await r.tasks.unblock(owner(), k.id, {});
  const k2 = await r.tasks.request(owner(), draftTask({ checker: undefined, output: { kind: "note" }, doer: actor("agent", "research") }));
  await r.tasks.start(agentChain("research"), k2.id);
  for (let i = 0; i < 3; i++) await r.tasks.observeDenial(kernelSvc(), k2.id, d);
  assert.equal((await r.tasks.get(owner(), k2.id)).stuck.suggested_fix, undefined, "declined: silence for the cool-down");
});

test("unblock: never the doer; the responsible person may, anyone else needs a proof over this; reassigning cannot make the checker the doer", async () => {
  const r = rig();
  const mk = async () => { const t = await r.tasks.request(owner(), draftTask({ checker: actor("person", ALICE), output: { kind: "decision" }, doer: actor("agent", "research") })); await r.tasks.start(agentChain("research"), t.id); return r.tasks.stuck(agentChain("research"), t.id, { reason: "x" }); };
  const t = await mk();
  await assert.rejects(() => r.tasks.unblock(agentChain("research"), t.id, {}), { code: "chain_not_person" });
  await assert.rejects(() => r.tasks.unblock(bob(), t.id, {}), { code: "needs_presence" });
  const p = r.sign(bob(), BOB, "task.unblock", { task: t.id, reassign_to: null });
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
  const c = await r.tasks.card(owner(), t.id);
  assert.equal(c.kind, "send");
  assert.equal(c.title, "send: the welcome email", "the title is the kernel's, from the action, not the doer's");
  assert.equal(c.unverified_recipients, 1);
  assert.deepEqual(c.sealed, [{ class: "unknown", slot: "ssn", masked: true, recipient: "jane@example.com", record: `vyre://${SPACE}/contact/c1` }], "the class is the kernel's: unresolved shows as unknown");
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
  const t = await toNeedsCheck(r, draftTask(), evidenceSent({ payload: payload({ sealed_slots: [{ class: "US SSN", slot: "ssn", use_hash: "use-1", record: `vyre://${SPACE}/contact/c1` }] }) }));
  assert.equal(r.tasks.approved(t.id, t.payload.payload_hash), false, "not before the checker approves");
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  assert.equal(r.tasks.approved(t.id, t.payload.payload_hash), true);
  assert.equal(r.tasks.approved(t.id, "use-1"), true);
  assert.equal(r.tasks.approved(t.id, "use-2"), false);
  assert.equal(r.tasks.approved("nope", "x"), false);
});

test("end to end: Intake drafts the welcome email with a sealed slot, Alice approves, and only then does seal.use run, from the approval's own facts", async () => {
  const r = rig();
  const REC = `vyre://${SPACE}/contact/c1`, TPL = `vyre://${SPACE}/template/welcome`;
  const calls = [];
  const sealer = { api: { use: async i => { calls.push(i); return { merged: true, output_ref: "out_1" }; } }, deliver: async i => { calls.push(i); return { delivered: true }; } };
  const sealing = createSealing({
    space: SPACE, sealer, authorizer: r.authorizer, log: r.log,
    approvals: createApprovals({ tasks: r.tasks }),
    templates: { get: async (u, v) => (u === TPL && v === 1 ? { body: "Hello {{sealed:ssn}}" } : null) },
    destinations: { resolve: async record => ({ kind: "contact_point", record, contact: "jane@example.com", verified: true }) },
  });
  const sealed = { class: "us-ssn", slot: "ssn", ref: "sv_1", recipient: "jane@example.com", record: REC };
  const t = await toNeedsCheck(r, draftTask(), evidenceSent({ payload: payload({ template: { id: TPL, version: 1 }, sealed_slots: [sealed] }) }));
  // before approval the plan cannot use the sealed value, even naming its own task
  await assert.rejects(() => sealing.use(asIntake(), { record: REC, approval: t.id }), { code: "not_found" });
  assert.equal(calls.length, 0);
  const alice_ = alice();
  const useProof = { signature: "signed-over-seal.use-by-alices-key", key_id: "key-per_alice", nonce: "n1", issued_at: T, expires_at: T + 60_000 };
  await r.tasks.decide(alice_, t.id, { outcome: "approved", proof: r.proof(alice_, ALICE, t), proofs: { use: useProof } });
  const res = await sealing.use(asIntake(), { record: REC, approval: t.id });
  assert.equal(res.merged, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].bindings, [{ slot: "ssn", ref: "sv_1" }]);
  assert.equal(calls[0].body, "Hello {{sealed:ssn}}");
  assert.equal(calls[0].proof, useProof);
  assert.equal(calls[0].approver_chain, alice_, "the approver is the person who approved, not the assistant");
  assert.equal(calls[0].destination.contact, "jane@example.com");
  // an approval for one record does not open another
  await assert.rejects(() => sealing.use(asIntake(), { record: `vyre://${SPACE}/contact/c2`, approval: t.id }), { code: "not_found" });
  assert.ok(!JSON.stringify(r.log.read()).includes("123-45"));
});


// ---- K4 gate fixes (reviewer-2 probes) ----
test("K4-1: two concurrent decides with one proof release once", async () => {
  const slow = rig();
  const t = await toNeedsCheck(slow);
  const A = alice(), proof = slow.proof(A, ALICE, t);
  const results = await Promise.allSettled([slow.tasks.decide(A, t.id, { outcome: "approved", proof }), slow.tasks.decide(A, t.id, { outcome: "approved", proof })]);
  assert.equal(slow.released.length, 1);
  assert.deepEqual(results.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  // another valid proof, while the first is still releasing, is refused too
  const r = rig({ releaseDelay: 30 });
  const u = await toNeedsCheck(r);
  const [x, y] = await Promise.allSettled([r.tasks.decide(A, u.id, { outcome: "approved", proof: r.proof(A, ALICE, u) }), r.tasks.decide(A, u.id, { outcome: "approved", proof: r.proof(A, ALICE, u) })]);
  assert.equal(r.released.length, 1);
  assert.ok([x, y].some(z => z.status === "rejected"));
});

test("K4-2: the kernel's skip proposal has no doer to rewrite it, and its card says skip", async () => {
  const r = rig();
  const t = await r.tasks.request(owner(), draftTask({ output: { kind: "note" }, required: true }));
  const { proposal } = await r.tasks.skip(asIntake(), t.id, "not needed");
  await assert.rejects(() => r.tasks.revise(asIntake(), proposal.id, "x"), { code: "not_allowed" });
  await assert.rejects(() => r.tasks.start(asIntake(), proposal.id), { code: "not_allowed" });
  await assert.rejects(() => r.tasks.complete(asIntake(), proposal.id, { answer: "yes", reason: "x" }), { code: "not_allowed" });
  const c = await r.tasks.card(owner(), proposal.id);
  assert.equal(c.kind, "skip");
  assert.match(c.title, /^Skip this task: /);
});

test("K4-3: a doer-marked verified recipient or class shows as the kernel resolved it", async () => {
  const r = rig();
  const t = await toNeedsCheck(r, draftTask(), evidenceSent({ payload: payload({ recipients: [{ address: "evil@attacker.test", verified: true, record: `vyre://${SPACE}/contact/c1` }, { address: "verified@example.com", verified: false, record: `vyre://${SPACE}/contact/c1` }], sealed_slots: [{ class: "free", slot: "ssn", ref: "sv_1", record: `vyre://${SPACE}/contact/c1` }] }) }));
  const c = await r.tasks.card(owner(), t.id);
  assert.deepEqual(c.recipients.map(x => [x.address, x.verified]), [["evil@attacker.test", false], ["verified@example.com", true]]);
  assert.equal(c.unverified_recipients, 1);
  assert.equal(c.sealed[0].class, "us-ssn");
});

test("K4-4 and 5: action and resource are part of the hash, and the body is a frozen copy", async () => {
  const r = rig();
  const a = await toNeedsCheck(r, draftTask(), evidenceSent({ resource: `vyre://${SPACE}/message/m1` }));
  const b = await toNeedsCheck(r, draftTask(), evidenceSent({ resource: `vyre://${SPACE}/message/m2` }));
  assert.notEqual(a.payload.payload_hash, b.payload.payload_hash);
  const ev = evidenceSent();
  const t = await toNeedsCheck(r, draftTask(), ev);
  ev.payload.recipients[0].address = "changed@x.test";
  assert.equal((await r.tasks.card(owner(), t.id)).recipients[0].address, "jane@example.com");
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  assert.equal(r.released[r.released.length - 1].body.payload.recipients[0].address, "jane@example.com");
  const bad = await r.tasks.request(owner(), draftTask());
  await r.tasks.start(asIntake(), bad.id);
  await assert.rejects(() => r.tasks.complete(asIntake(), bad.id, evidenceSent({ action: "tasks.read" })), { code: "bad_input" }, "a send must name an outward action");
});

test("K4-8: a sealed slot on another record than the task's is refused at complete", async () => {
  const r = rig();
  const t = await r.tasks.request(owner(), draftTask());
  await r.tasks.start(asIntake(), t.id);
  await assert.rejects(() => r.tasks.complete(asIntake(), t.id, evidenceSent({ payload: payload({ sealed_slots: [{ slot: "ssn", ref: "sv_1", record: `vyre://${SPACE}/contact/c2` }] }) })), { code: "bad_input" });
});

test("K4-11: revise goes through the table (a doer row)", async () => {
  const r = rig();
  const t = await toNeedsCheck(r);
  await assert.rejects(() => r.tasks.revise(agentChain("research"), t.id, "x"), { code: "not_allowed" });
  assert.equal((await r.tasks.revise(asIntake(), t.id, "more")).state, "ready");
});

test("stageTasks: the kernel's view of a record's stage tasks is held beside the api, not on it", async () => {
  const { stageTasks } = await import("./tasks.js");
  const r = rig();
  const rec = `vyre://${SPACE}/deal/d1`;
  const t = await r.tasks.request(owner(), { title: "Research", doer: actor("agent", "research"), output: { kind: "note" }, record: rec, stage: "Intake", required: true });
  assert.deepEqual(stageTasks(r.tasks, rec, "Intake"), [{ title: "Research", state: "ready", required: true }]);
  assert.deepEqual(stageTasks(r.tasks, rec, "Drafting"), []);
  assert.equal("stageTasks" in r.tasks, false);
  assert.ok(t);
});


test("K4-10, 12 and template immutability: card and observeDenial are chain-gated, a malformed use proof is refused at decide, the approved body carries the template hash", async () => {
  const r = rig();
  const t = await toNeedsCheck(r, draftTask(), evidenceSent({ payload: payload({ template: { id: `vyre://${SPACE}/template/welcome`, version: 1 }, sealed_slots: [{ slot: "ssn", ref: "sv_1", record: `vyre://${SPACE}/contact/c1` }] }) }));
  await assert.rejects(() => r.tasks.card(agentChain("ghost"), t.id), { code: "not_found" }, "no tasks.read, no card");
  await assert.rejects(() => r.tasks.observeDenial(owner(), t.id, { action: "x", resource: "y" }), { code: "not_allowed" });
  await assert.rejects(() => r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t), proofs: { use: { garbage: true } } }), { code: "bad_input" });
  await assert.rejects(() => r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t), proofs: { use: { signature: "s", key_id: "k", nonce: "n", issued_at: 1, expires_at: 2 } } }), { code: "bad_input" }, "an expired use proof");
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  const ap = r.tasks.approvalFor(t.id);
  assert.equal(ap.body.facts.template.hash, sha256("Hello {{sealed:ssn}}"));
});


test("N1 and N2: delivery recipients are the ones on the card, the sink is shown, and a slot must belong to the record its ref names", async () => {
  const r = rig();
  const rec = `vyre://${SPACE}/contact/c1`;
  const mk = async over => { const t = await r.tasks.request(owner(), draftTask()); await r.tasks.start(asIntake(), t.id); return [t, over]; };
  const ev = over => evidenceSent({ payload: payload({ template: { id: `vyre://${SPACE}/template/welcome`, version: 1 }, sealed_slots: [{ slot: "ssn", ref: "sv_1", record: rec }], ...over }) });
  let [t] = await mk();
  await assert.rejects(() => r.tasks.complete(asIntake(), t.id, ev({ delivery: { sink: "mail", to: ["attacker@evil.test"] } })), { code: "bad_input" }, "a hidden address");
  await assert.rejects(() => r.tasks.complete(asIntake(), t.id, ev({ delivery: { sink: "mail", bcc: ["x@y.test"] } })), { code: "bad_input" });
  const done = await r.tasks.complete(asIntake(), t.id, ev({ delivery: { sink: "mail", to: ["jane@example.com"] } }));
  assert.equal((await r.tasks.card(owner(), done.id)).sink, "mail");
  await r.tasks.decide(alice(), done.id, { outcome: "approved", proof: r.proof(alice(), ALICE, done) });
  const ap = r.tasks.approvalFor(done.id);
  assert.deepEqual(ap.body.facts.recipients.map(x => x.address), ["jane@example.com"]);
  [t] = await mk();
  await assert.rejects(() => r.tasks.complete(asIntake(), t.id, evidenceSent({ payload: payload({ sealed_slots: [{ slot: "ssn", ref: "sv_1", record: `vyre://${SPACE}/contact/c2` }] }) })), { code: "bad_input" });
  const t2 = await r.tasks.request(owner(), draftTask({ record: `vyre://${SPACE}/contact/c2` }));
  await r.tasks.start(asIntake(), t2.id);
  await assert.rejects(() => r.tasks.complete(asIntake(), t2.id, evidenceSent({ payload: payload({ sealed_slots: [{ slot: "ssn", ref: "sv_1", record: `vyre://${SPACE}/contact/c2` }] }) })), { code: "bad_input" }, "the ref belongs to c1, the slot says c2");
});

test("sessions bug: a required task with no checker completes on the kernel's output check; required only makes a skip a proposal", async () => {
  const r = rig();
  const t = await r.tasks.request(owner(), { title: "Research", doer: actor("agent", "research"), output: { kind: "note" }, required: true });
  await r.tasks.start(agentChain("research"), t.id);
  const done = await r.tasks.complete(agentChain("research"), t.id, { note: "found it", sources: ["https://x"] });
  assert.equal(done.state, "done", "no checker, no outward output: nothing to wait for");
  const s = await r.tasks.request(owner(), { title: "Optional", doer: actor("agent", "research"), output: { kind: "note" }, required: true });
  const sk = await r.tasks.skip(agentChain("research"), s.id, "not needed");
  assert.ok(sk.proposal, "a skip of a required task is still a proposal for a person");
});

test("continue_in_space is a task source only from a service chain; flow and form travel as opaque, capped data", async () => {
  const r = rig();
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ source: "continue_in_space" })), { code: "bad_input" }, "not a person's");
  await assert.rejects(() => r.tasks.request(asIntake(), draftTask({ source: "continue_in_space" })), /./, "not a model's");
  const svc = chains.fromFacts({ kind: "module", module: "tasks", first_party: true });
  const made = await r.tasks.request(svc, { title: "Continue in the Space", doer: actor("agent", "research"), output: { kind: "note" }, source: "continue_in_space" });
  assert.equal(made.source, "continue_in_space");
  const t = await r.tasks.request(owner(), draftTask({ flow: "fl_welcome", form: { fields: [{ name: "x", label: "X" }] } }));
  assert.equal(t.flow, "fl_welcome");
  assert.deepEqual(t.form, { fields: [{ name: "x", label: "X" }] });
  assert.ok(Object.isFrozen(t.form));
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ form: { big: "x".repeat(9000) } })), { code: "bad_input" });
});

test("idempotency: a repeated key returns the first task and makes one; the same key with other input is a conflict", async () => {
  const r = rig();
  const a = await r.tasks.request(owner(), draftTask(), { idem: "step-1" });
  const b = await r.tasks.request(owner(), draftTask(), { idem: "step-1" });
  assert.equal(a.id, b.id);
  assert.equal(r.log.read({ type: "task.created" }).length, 1);
  await assert.rejects(() => r.tasks.request(owner(), draftTask({ title: "Another" }), { idem: "step-1" }), { code: "idem_conflict" });
  const c = await r.tasks.request(owner(), draftTask(), { idem: "step-2" });
  assert.notEqual(c.id, a.id);
});

test("approval on authorize: an approved held-act task allows exactly that act by its doer once, and nothing else", async () => {
  const r = rig();
  const t = await toNeedsCheck(r);
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  const act = { chain: asIntake(), action: "email.send", resource: `vyre://${SPACE}/message/m1` };
  assert.equal((await r.authorizer.authorize(act)).effect, "ask", "without the approval an outward act asks");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act }), true);
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, resource: `vyre://${SPACE}/message/other` }), false, "another resource");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, chain: agentChain("rogue") }), false, "another doer");
  assert.equal(r.tasks.approvedAct({ id: "nope", ...act }), false);
  // A-4: the approval is spent by the decision that uses it, whoever asked, and it has a day to live
  assert.equal(r.tasks.useApproval({ id: t.id, ...act }), true);
  assert.equal(r.tasks.useApproval({ id: t.id, ...act }), false, "once");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act }), false);
  const t2 = await toNeedsCheck(r);
  await r.tasks.decide(alice(), t2.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t2) });
  T += 25 * 3600_000;
  assert.equal(r.tasks.useApproval({ id: t2.id, ...act }), false, "an approval older than 24 hours is no approval");
});

test("approval under an always-ask rule: only the named approver's approval stands", async () => {
  const r = rig();
  const t = await toNeedsCheck(r);
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  const act = { chain: asIntake(), action: "email.send", resource: `vyre://${SPACE}/message/m1` };
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, rule: { id: "r1", approver: { person: ALICE } } }), true, "approved by the named person");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, rule: { id: "r1", approver: { person: "per_someone_else" } } }), false, "approved by someone else");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, rule: { id: "r1", approver: { role: "owner" } } }), false, "no role lookup wired here: a role approver cannot be confirmed, so it fails closed");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act }), true, "no rule: any approval stands");
});

test("approval under an always-ask rule that names a ROLE: it stands only when the approver holds that role now", async () => {
  let roles = { [ALICE]: "owner" };
  const r = rig({ roleOf: a => roles[a.id] ?? null });
  const t = await toNeedsCheck(r);
  await r.tasks.decide(alice(), t.id, { outcome: "approved", proof: r.proof(alice(), ALICE, t) });
  const act = { chain: asIntake(), action: "email.send", resource: `vyre://${SPACE}/message/m1` };
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, rule: { id: "r1", approver: { role: "owner" } } }), true, "the approver is an owner");
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, rule: { id: "r1", approver: { role: "admin" } } }), false, "another role");
  roles = { [ALICE]: "member" };                                    // the role is read when the act is checked: she is no longer an owner
  assert.equal(r.tasks.approvedAct({ id: t.id, ...act, rule: { id: "r1", approver: { role: "owner" } } }), false, "a role the approver no longer holds");
  roles = { [ALICE]: "owner" };
  assert.equal(r.tasks.useApproval({ id: t.id, ...act, rule: { id: "r1", approver: { role: "owner" } } }), true);
  assert.equal(r.tasks.useApproval({ id: t.id, ...act, rule: { id: "r1", approver: { role: "owner" } } }), false, "once");
});

test("a task's answer reaches whoever asked: stored on done and carried on task.completed (by hash, never in the clear) for decision, fields and note outputs (a Flow's ask and agent steps read it back); capped, and none for other kinds", async () => {
  const r = rig();
  const t = await r.tasks.request(owner(), { title: "Send the engagement letter?", doer: actor("agent", "research"), output: { kind: "decision" } });
  await r.tasks.start(agentChain("research"), t.id);
  const done = await r.tasks.complete(agentChain("research"), t.id, { answer: "yes", reason: "the fee was agreed" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.answer, { answer: "yes", reason: "the fee was agreed" });
  assert.deepEqual((await r.tasks.get(owner(), t.id)).answer, { answer: "yes", reason: "the fee was agreed" });
  const ev = r.log.read({ type: "task.completed" }).find(e => e.subject.endsWith(`/${t.id}`));
  assert.equal(ev.data.answer, undefined, "free text is never in the log in the clear");
  assert.match(ev.data.answer_hash, /^[A-Za-z0-9_-]{43}$/, "the log carries its hash instead");
  assert.ok(Object.isFrozen(done.answer));
  const f = await r.tasks.request(owner(), { title: "Research", doer: actor("agent", "research"), output: { kind: "note" } });
  await r.tasks.start(agentChain("research"), f.id);
  assert.deepEqual((await r.tasks.complete(agentChain("research"), f.id, { note: "found it", sources: ["https://x"] })).answer, { note: "found it", sources: ["https://x"] });
  const big = await r.tasks.request(owner(), { title: "Big", doer: actor("agent", "research"), output: { kind: "note" } });
  await r.tasks.start(agentChain("research"), big.id);
  await assert.rejects(() => r.tasks.complete(agentChain("research"), big.id, { note: "x".repeat(9000), sources: ["https://x"] }), { code: "bad_input" });
});

test("list: filtered by record, doer, checker and state, oldest first; a hand-made chain is refused", async () => {
  const r = rig();
  const a = await r.tasks.request(owner(), draftTask());
  const b = await r.tasks.request(owner(), draftTask({ record: `vyre://${SPACE}/contact/c2` }));
  assert.deepEqual((await r.tasks.list(owner())).map(t => t.id), [a.id, b.id].sort());
  assert.deepEqual((await r.tasks.list(owner(), { record: `vyre://${SPACE}/contact/c2` })).map(t => t.id), [b.id]);
  assert.equal((await r.tasks.list(owner(), { doer: "intake" })).length, 2);
  assert.equal((await r.tasks.list(owner(), { doer: "nobody" })).length, 0);
  assert.equal((await r.tasks.list(owner(), { checker: ALICE })).length, 2);
  assert.equal((await r.tasks.list(owner(), { state: ["working"] })).length, 0);
  await r.tasks.start(asIntake(), a.id);
  assert.deepEqual((await r.tasks.list(owner(), { state: ["working"] })).map(t => t.id), [a.id]);
  await assert.rejects(() => r.tasks.list({ hops: [], space: SPACE }), { code: "bad_input" });
});

test("WF-1 on tasks: a change whose event cannot be written does not stay in memory (a failed start, an approval the log refused, a refused creation)", async () => {
  let fail = false;
  const r = rig({ wrapLog: real => ({ ...real, append: (...a) => { if (fail) throw new Error("log refused"); return real.append(...a); } }) });
  const down = async f => { fail = true; try { await assert.rejects(f, /log refused/); } finally { fail = false; } };
  const count = async () => (await r.tasks.list(owner())).length;
  // a creation that cannot be logged leaves no task
  const before = await count();
  await down(() => r.tasks.request(owner(), draftTask()));
  assert.equal(await count(), before, "no task without its event");
  // a start that cannot be logged leaves the task ready
  const t = await r.tasks.request(owner(), draftTask());
  await down(() => r.tasks.start(asIntake(), t.id));
  assert.equal((await r.tasks.get(owner(), t.id)).state, "ready", "still ready");
  assert.equal((await r.tasks.start(asIntake(), t.id)).state, "working", "and it can be started again");
  // an approval that cannot be logged is not an approval: the task still waits and nothing was released
  const w = await toNeedsCheck(r);
  const A = alice();
  await down(() => r.tasks.decide(A, w.id, { outcome: "approved", proof: r.proof(A, ALICE, w) }));
  assert.equal((await r.tasks.get(owner(), w.id)).state, "needs_check", "still waiting for its check");
  assert.equal(r.released.length, 1, "the send ran once before the event was refused");
  const done = await r.tasks.decide(A, w.id, { outcome: "approved", proof: r.proof(A, ALICE, w) });
  assert.equal(done.state, "done");
  assert.equal(r.released.length, 1, "WF-2: the second approval did not send again");
});

test("PR-2: the form a Flow sent with a task is bound into what the checker's proof covers: same evidence under another form is another payload hash, and a proof for the other form does not approve", async () => {
  const r = rig();
  const A = alice();
  const evidence = { answer: "yes", reason: "the diff is fine" };
  const mk = async form => {
    const t = await r.tasks.request(owner(), draftTask({ checker: actor("person", ALICE), output: { kind: "decision" }, doer: actor("agent", "research"), flow: "fl_proposal", form }));
    await r.tasks.start(agentChain("research"), t.id);
    return r.tasks.complete(agentChain("research"), t.id, evidence);
  };
  const one = await mk({ kind: "proposal", diff: "add a stage" });
  const two = await mk({ kind: "proposal", diff: "add a stage and delete a type" });
  assert.equal(one.state, "needs_check");
  assert.notEqual(one.payload.payload_hash, two.payload.payload_hash, "another form, another hash");
  assert.equal(one.payload.form_hash, sha256(canonical({ kind: "proposal", diff: "add a stage" })), "the task row names the form hash the proof covers");
  assert.notEqual(one.payload.form_hash, two.payload.form_hash);
  // a proof over the other form's hash, for this task and decision, is not a proof for this task
  const forTwo = r.sign(A, ALICE, "task.decide", { task: two.id, payload_hash: one.payload.payload_hash, decision: two.payload.decision });
  await assert.rejects(() => r.tasks.decide(A, two.id, { outcome: "approved", proof: forTwo }), { code: "needs_presence" });
  assert.equal((await r.tasks.get(owner(), two.id)).state, "needs_check", "nothing was approved");
  const good = r.proof(A, ALICE, two);
  assert.equal((await r.tasks.decide(A, two.id, { outcome: "approved", proof: good })).state, "done");
});
