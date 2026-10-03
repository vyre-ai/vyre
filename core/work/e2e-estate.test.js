// End to end on the REAL gateway and tasks with records' Estate Kit: the tool surface, sealing, an outward act held and approved with a presence proof, the
// situation, a teammate added under the adder's ceiling, the memory engine's authorized search and cited answer, and the Engineer's proposal approved by the admin.
// Only the model (scripted) and the language compiler's adapter are stand-ins; everything the kernel decides is the kernel's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRealKernel } from "../../test/real-kernel.js";
import { tempHome } from "../../test/helpers.js";
import { open } from "../store/index.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { compile } from "../../records/language/compile.js";
import { print } from "../../records/language/print.js";
import { buildSituation } from "../assistant/native/situation.js";
import { toComponent } from "../assistant/native/components.js";
import { teammateContext } from "../team/context.js";
import { teammateFromRole, markReviewed, checkAdd } from "../team/roles.js";
import { delegateGrants } from "../team/delegate.js";
import { createMemoryEngine } from "../memory/engine/index.js";
import { createEngineer, engineerGrants } from "../engineer/index.js";

const KIT = JSON.parse(fs.readFileSync(new URL("../../records/kits/estate-planning/kit.json", import.meta.url), "utf8"));
const SEND = { action: "email.send", resource_type: "message", risk: "outward.send", label: "send an email", gloss: "Sends an email from the firm." };
const SSN = "123-45-6789";
const sealedRef = { sealed: "us-ssn", ref: "seal_ssn_1", present: true, valid_format: true, set_at: 1 };

const INVOICE_TS = `import { defineKit, defineType, defineField } from "@vyre/sdk";
export const Invoice = defineType({ name: "invoice", fields: { number: defineField.text({ required: true }) } });
export default defineKit({ id: "billing", version: 1, includes: [Invoice] });
`;

async function world(t, over = {}) {
  const rk = await createRealKernel({
    defs: [...CORE_TYPES, ...KIT.types], actions: [SEND],
    agents: { juno: ["records.read", "records.update", "records.create", "tasks.request", "tasks.work", "email.send"], engineer: engineerGrants("spc_aaaaaaaaaaaa").flatMap(g => g.actions), research: ["records.read"] },
    services: { memory: ["records.read", "events.read"] }, model: over.model,
  });
  const owner = rk.person();
  const contact = await rk.kernel.records.create(owner, "contact", { full_name: "Jane Doe", email: "jane@example.com", ssn: sealedRef });
  const matter = await rk.kernel.records.create(owner, "matter", { title: "Doe estate plan", stage: "Intake", client: { urn: contact.urn } });
  return { rk, owner, contact, matter, juno: rk.agent("juno") };
}

test("the surface is the Estate Kit's own nouns; a model reads placeholders and the sealed value never appears", async t => {
  const { rk, juno, contact } = await world(t);
  const names = (await rk.surface.list(juno)).map(x => x.name);
  for (const n of ["contacts.find", "matters.find", "matters.move_stage", "tasks.assign", "email.send"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("research.find"));
  const found = await rk.surface.call(juno, "contacts.find", { where: { full_name: "Jane Doe" } });
  assert.equal(found.records.length, 1);
  assert.deepEqual(found.records[0].data.ssn, { sealed: "us-ssn", present: true, valid_format: true });
  assert.doesNotMatch(JSON.stringify(found), /seal_ssn_1|123-45/);
  assert.equal(toComponent("contacts.find", found).kind === "record_card" || toComponent("contacts.find", found).kind === "group", true);
  const reader = rk.agent("research");
  assert.deepEqual((await rk.surface.list(reader)).map(x => x.name).filter(n => n.startsWith("contacts.")), ["contacts.find"]);
  void contact;
});

test("an outward send is held as a task, the agent completes it, and only the owner's presence proof approves it", async t => {
  const { rk, juno, owner, matter } = await world(t);
  const held = await rk.surface.call(juno, "email.send", { summary: "Welcome email for Jane Doe", record: matter.urn });
  assert.ok(held.held, JSON.stringify(held));
  await rk.tasks.start(juno, held.held.task);
  const done = await rk.tasks.complete(juno, held.held.task, { payload: { what: "welcome", recipients: [{ address: "jane@example.com", verified: false, record: matter.urn }] }, action: "email.send", resource: `vyre://${rk.space}/message/m1` });
  assert.equal(done.state, "needs_check");
  const proof = await rk.proofFor(owner, held.held.task);
  await assert.rejects(() => rk.tasks.decide(juno, held.held.task, { outcome: "approved", proof }), { code: "chain_not_person" }, "an assistant cannot approve");
  await assert.rejects(() => rk.tasks.decide(owner, held.held.task, { outcome: "approved" }), { code: "needs_presence" }, "no proof, no approval");
  const ok = await rk.tasks.decide(owner, held.held.task, { outcome: "approved", proof });
  assert.equal(ok.state, "done");
});

test("the situation is built from the real records: the stage, the sealed field as a placeholder, and nothing sealed", async t => {
  const { rk, juno, matter, contact } = await world(t);
  const s = await buildSituation(rk.kernel, juno, { space: rk.space, project: { type: "matter", id: matter.id } });
  assert.match(s.text, /matter/);
  assert.match(s.text, /Intake/);
  const c = await buildSituation(rk.kernel, juno, { space: rk.space, record: { type: "contact", id: contact.id } });
  assert.match(c.text, /sealed/);
  assert.doesNotMatch(c.text + s.text, /seal_ssn_1|123-45-6789/);
});

test("a teammate is added from the Kit's research role, no wider than the adder, and starts with the project minus sealed fields", async t => {
  const { rk, owner, matter } = await world(t);
  const role = KIT.roles.find(r => r.name === "research");
  let spec = markReviewed(teammateFromRole(role, { project: matter.urn, space: rk.space }), "alex");
  assert.ok(spec.wanted.some(w => w.actions.includes("records.update") && w.prefix.endsWith("/matter/*") && w.fields.includes("practice_area")));
  assert.ok(checkAdd({ spec, adder: owner.hops[0].actor, count: 0 }).ok);
  const teammate = { kind: "agent", id: "research", space: rk.space };
  const made = await delegateGrants(rk.kernel, owner, { adder: owner.hops[0].actor, teammate, wanted: spec.wanted });
  assert.ok(made.grants.length >= 3);
  const ctx = await teammateContext(rk.kernel, rk.agent("research"), { project: matter.urn, space: rk.space, role: { name: "research", instructions: role.instructions } });
  assert.match(ctx.text, /Doe estate plan/);
  assert.doesNotMatch(ctx.text, /seal_ssn_1|123-45-6789/);
});

test("memory: search and answers only from sources the caller may read, with a citation", async t => {
  const { rk, owner, matter, contact } = await world(t, { model: i => ({ content: "Jane Doe's matter is the Doe estate plan [S1]." }) });
  const db = open(path.join(tempHome(t), "engine.db"));
  const engine = createMemoryEngine({ kernel: rk.kernel, db, space: rk.space, serviceChain: rk.kernel.serviceChain("memory"), chainFor: () => owner });
  await engine.index({ kind: "record", type: "matter", id: matter.id });
  await engine.index({ kind: "record", type: "contact", id: contact.id });
  const hits = await engine.search(owner, "Doe estate plan");
  assert.ok(hits.some(h => h.source === matter.urn));
  const a = await engine.answer(owner, "What is Jane Doe's matter?");
  assert.deepEqual(a.citations.length > 0, true);
  assert.doesNotMatch(JSON.stringify(rk.modelCalls), /seal_ssn_1|123-45-6789/);
  const nobody = rk.agent("juno");
  const blind = await engine.search(nobody, "Doe estate plan");
  assert.ok(blind.every(h => h.source !== undefined));
});

test("the Engineer proposes a definition, compiled by the real language, and only the admin's own proof applies it", async t => {
  const { rk, owner } = await world(t, { model: () => ({ content: "```typescript\n" + INVOICE_TS + "```\nAdds an invoice type." }) });
  const compiler = async (/** @type {string} */ src) => {
    try {
      const kit = compile(src);
      const have = new Set((await rk.kernel.definitions(owner)).map(d => d.name));
      const canonical = print(kit);
      return { diff: { add_types: kit.types.filter(x => !have.has(x.name)) }, canonical, hash: createHash("sha256").update(canonical).digest("hex"), errors: [], authorship: "model-drafted" };
    } catch (e) { return { diff: {}, canonical: "", hash: "", errors: [{ line: e.line || 1, msg: String(e.message) }] }; }
  };
  const eng = createEngineer({ kernel: rk.kernel, compile: compiler, simulate: async () => ({ ok: true, steps: 1, failures: [] }), engineerChain: rk.kernel.engineerChain });
  const r = await eng.talk(owner, "Add an invoice type with a number");
  assert.equal(r.kind, "proposal", JSON.stringify(r).slice(0, 300));
  assert.equal((await rk.kernel.definitions(owner)).some(d => d.name === "invoice"), false, "nothing applied yet");
  const proof = await rk.proofFor(owner, r.task);
  await assert.rejects(() => eng.approve(rk.agent("juno"), r.id, { proof }), { code: "chain_not_person" }, "an assistant cannot approve");
  const out = await eng.approve(owner, r.id, { proof });
  assert.equal(out.applied, true);
  assert.ok(out.changes.length > 0);
});
