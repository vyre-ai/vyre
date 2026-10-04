// The owner's approval of a Kit's install card is the presence for that install and nothing else (the lead's ruling, 5 Oct): kernel/tasks/kit-apply.js, records.define with a waiver.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice";
const used = new Set();
let NOW = Date.now();
const clock = () => NOW;
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const PET = { name: "pet", label: "Pet", fields: [{ name: "name", kind: "text", label: "Name" }] };
const KIT = Object.freeze({ id: "estate", name: "Estate", version: 1, types: [CONTACT, PET] });

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, clock });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[ALICE, "admin"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const alice = k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: ALICE, path: "direct" });
  // The chain a Kit's install runs under: the person who approved it with the Kit's own module behind them. Such a chain is not "exactly one person", so a session is no presence for it.
  const kitActor = { kind: "service", id: "kits", space: SPACE };
  await g.addActor(owner, kitActor, { presence: proof("grants.role", { actor: kitActor }, `vyre://${SPACE}/member/kits`) });
  const gi = { subject: { kind: "actor", actor: kitActor }, actions: ["records.define"], resource: { prefix: `vyre://${SPACE}/*` }, conditions: {}, source: "test" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  const kitChain = k.chains.fromFacts({ kind: "module", inbound: owner, module: "kits", first_party: true });
  /** An install card task, taken through the checker's approval (the owner signs over the task, its payload and the form). */
  const approved = async (kit = KIT, form = { kind: "kit_install", proposal: "kp_1", kit_hash: sha256(canonical(kit)) }) => {
    const t = await k.gateway.ask.request(owner, { title: "Install Estate?", output: { kind: "decision" }, source: "manual", doer: { kind: "person", id: ALICE, space: SPACE }, checker: { kind: "person", id: OWNER, space: SPACE }, form });
    await k.gateway.ask.start(alice, t.id);
    const w = await k.gateway.ask.complete(alice, t.id, { answer: "yes", reason: "ready" });
    const p = { op: "task.decide", fields: { task: t.id, payload_hash: w.payload.payload_hash, decision: w.payload.decision }, n: Math.random() };
    await k.gateway.ask.decide(owner, t.id, { outcome: "approved", proof: p });
    return t.id;
  };
  return { k, owner, alice, approved, g, kitChain };
}

test("an approved Kit installs: the approval is the presence for exactly the Kit's types, the event comes first, and without it the same define still needs presence", async () => {
  const { k, owner, approved, kitChain } = await rig();
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [CONTACT] }), e => e.code === "needs_presence", "no presence, no define");
  const task = await approved();
  const waiver = await k.gateway.kits.begin({ chain: kitChain, task, kit: KIT });
  assert.ok(k.log.read({ type: "kit.applying" }).length === 1 && k.log.read({ type: "kit.applying" })[0].data.task === task, "the event is written before anything is defined");
  const r = await k.gateway.records.define(kitChain, { add_types: [CONTACT] }, { waiver });
  assert.equal(r.applied, true);
  await k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver });
  assert.deepEqual((await k.store.types()).map(t => t.name).sort(), ["contact", "pet"]);
  k.gateway.kits.end(waiver);
});

test("a Kit whose content differs by a byte from the one approved is refused; so is an approval used twice, one that nobody approved, another person's, and an assistant's chain", async () => {
  const { k, owner, alice, approved, kitChain } = await rig();
  const task = await approved();
  const changed = { ...KIT, types: [CONTACT, { ...PET, label: "Pets" }] };
  await assert.rejects(() => k.gateway.kits.begin({ chain: kitChain, task, kit: changed }), { code: "not_allowed" });
  assert.equal(k.log.read({ type: "kit.applying" }).length, 0, "a refused begin spends nothing");
  const asst = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "assistant", session: "s1" });
  await assert.rejects(() => k.gateway.kits.begin({ chain: asst, task, kit: KIT }), { code: "not_allowed" }, "an assistant never applies");
  await assert.rejects(() => k.gateway.kits.begin({ chain: alice, task, kit: KIT }), { code: "not_allowed" }, "only the approver applies it");
  // a task nobody approved
  const t = await k.gateway.ask.request(owner, { title: "x", output: { kind: "decision" }, source: "manual", doer: { kind: "person", id: ALICE, space: SPACE }, checker: { kind: "person", id: OWNER, space: SPACE }, form: { kind: "kit_install", kit_hash: sha256(canonical(KIT)) } });
  await assert.rejects(() => k.gateway.kits.begin({ chain: kitChain, task: t.id, kit: KIT }), { code: "not_allowed" });
  // used once
  const w = await k.gateway.kits.begin({ chain: kitChain, task, kit: KIT });
  k.gateway.kits.end(w);
  await assert.rejects(() => k.gateway.kits.begin({ chain: kitChain, task, kit: KIT }), { code: "not_allowed" }, "the approval is spent");
  // a card whose form does not name the Kit
  const noKit = await approved(KIT, { kind: "proposal", proposal: "p" });
  await assert.rejects(() => k.gateway.kits.begin({ chain: kitChain, task: noKit, kit: KIT }), { code: "not_allowed" });
});

test("the waiver is no presence for anything else: a define outside the Kit, the same type twice, another chain, an ended waiver, and no waiver", async () => {
  const { k, owner, alice, approved, kitChain } = await rig();
  const task = await approved();
  const waiver = await k.gateway.kits.begin({ chain: kitChain, task, kit: KIT });
  const OTHER = { name: "secret", label: "Secret", fields: [{ name: "x", kind: "text", label: "X" }] };
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [OTHER] }, { waiver }), { code: "not_allowed" }, "a type the Kit does not list");
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [{ ...PET, label: "Pets" }] }, { waiver }), { code: "not_allowed" }, "a listed type changed by a byte");
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [PET], remove_types: ["contact"] }, { waiver }), { code: "not_allowed" }, "a diff that also removes");
  await assert.rejects(() => k.gateway.records.define(alice, { add_types: [PET] }, { waiver }), { code: "not_allowed" }, "another chain cannot use it");
  await k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver });
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver }), { code: "not_allowed" }, "once");
  // the waiver is no presence on any other act
  const d = await k.gateway.authorize({ chain: kitChain, action: "grants.role", resource: `vyre://${SPACE}/member/per_x`, waiver });
  assert.notEqual(d.effect, "allow", "not for a role change");
  const d2 = await k.gateway.authorize({ chain: kitChain, action: "records.define", resource: `vyre://${SPACE}/definition/types` });
  assert.equal(d2.reason, "needs_presence", "and an ordinary define still needs presence");
  k.gateway.kits.end(waiver);
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [CONTACT] }, { waiver }), { code: "not_allowed" }, "an ended waiver");
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [CONTACT] }, { waiver: {} }), { code: "not_allowed" }, "a made-up waiver");
});

test("KW-A: a refused define spends nothing; KW-B: another chain of the same person (another device) cannot use the waiver", async () => {
  const { k, owner, approved, kitChain } = await rig();
  const BAD = { name: "Bad Name", label: "Broken", fields: [{ name: "x", kind: "text", label: "X" }] };
  const kit = { ...KIT, types: [BAD, PET] };
  const task = await approved(kit);
  const waiver = await k.gateway.kits.begin({ chain: kitChain, task, kit });
  const first = await k.gateway.records.define(kitChain, { add_types: [BAD] }, { waiver }).catch(e => e);
  assert.equal(first.code, "bad_input", "the Kit lists it, so the waiver covered it and the define itself failed");
  const again = await k.gateway.records.define(kitChain, { add_types: [BAD] }, { waiver }).catch(e => e);
  assert.equal(again.code, "bad_input", "the failed define stranded nothing");
  await k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver });
  // another chain of the same person: same actors, another device
  const owner2 = k.chains.fromFacts({ kind: "device", device_key_id: "d-other", person: OWNER, path: "direct", session: "s2" });
  const other = k.chains.fromFacts({ kind: "module", inbound: owner2, module: "kits", first_party: true });
  const task2 = await approved();
  const w2 = await k.gateway.kits.begin({ chain: kitChain, task: task2, kit: KIT });
  await assert.rejects(() => k.gateway.records.define(other, { add_types: [CONTACT] }, { waiver: w2 }), { code: "not_allowed" }, "same person, another device");
  await k.gateway.records.define(kitChain, { add_types: [CONTACT] }, { waiver: w2 });
});

test("KT-4 kits.resume (repeatable, one approval): a define that fails leaves the install resumable; each resume writes kit.resumed with its attempt number and defines only what is missing; three resumes in a row leave one install; a Kit that changed since the approval is refused; an update is never resumed", async () => {
  const { k, owner, approved, kitChain } = await rig();
  const task = await approved();
  await assert.rejects(() => k.gateway.kits.resume({ chain: kitChain, task, kit: KIT }), { code: "not_allowed" }, "an approval never applied cannot be resumed");
  const w = await k.gateway.kits.begin({ chain: kitChain, task, kit: KIT });
  await k.gateway.records.define(kitChain, { add_types: [CONTACT] }, { waiver: w });
  assert.equal(k.log.read({ type: "kit.installed" }).length, 0, "not installed yet: PET is missing");
  // the process stops here, or the next define fails: the waiver lapses
  NOW += 5 * 60_000;
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver: w }), { code: "not_allowed" }, "the first attempt fails (the waiver lapsed)");
  const asst = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "assistant", session: "s1" });
  await assert.rejects(() => k.gateway.kits.resume({ chain: asst, task, kit: KIT }), { code: "not_allowed" }, "an assistant never resumes");
  await assert.rejects(() => k.gateway.kits.resume({ chain: kitChain, task, kit: { ...KIT, types: [CONTACT, { ...PET, label: "Pets" }] } }), { code: "not_allowed" }, "a Kit that is not the approved one");
  // attempt 1 defines nothing either (the process dies again); attempt 2 finishes
  const r1 = await k.gateway.kits.resume({ chain: kitChain, task, kit: KIT });
  assert.equal(k.log.read({ type: "kit.resumed" })[0].data.attempt, 1);
  assert.deepEqual(k.log.read({ type: "kit.resumed" })[0].data.types, ["pet"], "only what is missing");
  NOW += 5 * 60_000;
  const r2 = await k.gateway.kits.resume({ chain: kitChain, task, kit: KIT });
  assert.equal(k.log.read({ type: "kit.resumed" })[1].data.attempt, 2);
  await assert.rejects(() => k.gateway.records.define(kitChain, { change_types: [{ ...CONTACT, label: "Changed" }] }, { waiver: r2 }), { code: "not_allowed" }, "a defined type is not part of a resume: an update is a new approval");
  await assert.rejects(() => k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver: r1 }), { code: "not_allowed" }, "the lapsed waiver of attempt 1 is dead");
  await k.gateway.records.define(kitChain, { add_types: [PET] }, { waiver: r2 });
  assert.equal(k.log.read({ type: "kit.installed" }).length, 1, "installed once, when nothing is missing");
  // three more resumes in a row: nothing missing, nothing defined, one install
  for (let n = 0; n < 3; n++) assert.deepEqual({ ...(await k.gateway.kits.resume({ chain: kitChain, task, kit: KIT })) }, { already_installed: true });
  assert.equal(k.log.read({ type: "kit.installed" }).length, 1);
  assert.equal(k.log.read({ type: "kit.resumed" }).length, 2, "no resume was written when nothing was missing");
  assert.deepEqual((await k.store.types()).map(t => t.name).sort(), ["contact", "pet"]);
  // the Kit changed since the approval: refused, even with nothing missing
  await assert.rejects(() => k.gateway.kits.resume({ chain: kitChain, task, kit: { ...KIT, types: [CONTACT, PET, { name: "extra", label: "E", fields: [] }] } }), { code: "not_allowed" });
  // a Kit with no types begins and is installed at once
  const bare = { id: "bare", name: "Bare", version: 1, types: [] };
  const t2 = await approved(bare);
  assert.ok(await k.gateway.kits.begin({ chain: kitChain, task: t2, kit: bare }));
  assert.equal(k.log.read({ type: "kit.installed" }).length, 2);
  void owner;
});
