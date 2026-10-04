// The owner's approval of a Kit's install card is the presence for that install and nothing else (the lead's ruling, 5 Oct): kernel/tasks/kit-apply.js, records.define with a waiver.
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const PET = { name: "pet", label: "Pet", fields: [{ name: "name", kind: "text", label: "Name" }] };
const KIT = Object.freeze({ id: "estate", name: "Estate", version: 1, types: [CONTACT, PET] });

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
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
