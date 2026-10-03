// @ts-check
// The fake kernel keeps the rules the 0.3 modules lean on: intersection of authority, placeholders to agents, one event per write, the task table,
// human-only approval, the inference door's ledger. If these hold here, a module that passes against it passes against the contract.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeKernel } from "./fake-kernel.js";
import { joinLabels, memberLabels, externalLabels, isTainted } from "../lib/labels.js";
import { modelView, sealedFields, isSealedValue } from "../lib/sealed.js";

test("authority is the intersection of every hop: an agent in a person's session cannot exceed either", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), juno = f.agent("juno");
  f.grant(alex, ["records.read", "records.update"]);
  f.grant(juno, ["records.read"]);
  const both = f.chain([alex, juno]);
  assert.ok(await f.kernel.records.query(both, "note", { page: { limit: 5 } }));
  await assert.rejects(f.kernel.records.create(both, "note", { text: "x" }), { code: "not_found" });
  await f.kernel.records.create(f.chain([alex]), "note", { text: "x" });
  assert.equal(f.events.filter(e => e.type === "record.created").length, 1, "one event per write");
});

test("an agent's read of a sealed field is the placeholder, never the reference", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), juno = f.agent("juno");
  f.grant(alex, ["records.read", "records.update"]); f.grant(juno, ["records.read"]);
  const { id } = f.seed("matter", { name: "Doe", ssn: { sealed: "us-ssn", ref: "seal_1", present: true, valid_format: true, set_at: 1 } });
  const person = await f.kernel.records.get(f.chain([alex]), "matter", id);
  const model = await f.kernel.records.get(f.chain([alex, juno]), "matter", id);
  assert.equal(/** @type {any} */ (person).data.ssn.ref, "seal_1");
  assert.equal(/** @type {any} */ (model).data.ssn.ref, undefined);
  assert.deepEqual(sealedFields(modelView(/** @type {any} */ (person).data)), ["ssn"]);
  assert.equal(isSealedValue(modelView(/** @type {any} */ (person).data).ssn) && "ref" in modelView(/** @type {any} */ (person).data).ssn, false);
});

test("the inference door refuses a prompt with a sealed value in it", async () => {
  const f = createFakeKernel();
  f.sealValue("123-45-6789");
  await assert.rejects(f.kernel.model.call({ chain: f.chain([f.agent("juno")]), purpose: "memory", provider: "x", model: "y", messages: [{ role: "user", content: "ssn 123-45-6789" }] }), { code: "ledger_hit" });
  f.script(() => ({ content: "ok" }));
  assert.equal((await f.kernel.model.call({ chain: f.chain([f.agent("juno")]), purpose: "memory", provider: "x", model: "y", messages: [{ role: "user", content: "hello" }] })).content, "ok");
});

test("tasks: only a chain of exactly one person with a proof over the payload approves, and not the doer", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), chris = f.person("chris"), kit = f.agent("intake");
  f.grant(alex, ["tasks.request", "tasks.decide"]); f.grant(kit, ["tasks.request"]); f.grant(chris, ["tasks.decide"]);
  const t = await f.kernel.ask.request(f.chain([alex]), { title: "Welcome email", doer: kit, checker: chris, output: { kind: "sent" } });
  assert.equal(t.state, "ready");
  await f.kernel.tasks.move(f.chain([alex, kit]), t.id, "working");
  await f.kernel.tasks.move(f.chain([f.service("kernel")]), t.id, "needs_check", { output_checked: true });
  const proof = { signer: "secure_enclave", payload_hash: f.taskPayloadHash(f.tasks.get(t.id)) };
  await assert.rejects(f.kernel.ask.decide(f.chain([chris, kit]), t.id, { outcome: "approved", proof: /** @type {any} */ (proof) }), { code: "chain_not_person" });
  await assert.rejects(f.kernel.ask.decide(f.chain([chris]), t.id, { outcome: "approved", proof: /** @type {any} */ ({ payload_hash: "x" }) }), { code: "needs_presence" });
  assert.equal((await f.kernel.ask.decide(f.chain([chris]), t.id, { outcome: "approved", proof: /** @type {any} */ (proof) })).state, "done");
  await assert.rejects(f.kernel.tasks.move(f.chain([kit]), t.id, "working"), { code: "bad_input" });
});

test("a doer cannot move a task to stuck by hand without being an assistant, and a guarded skip is refused", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), kit = f.agent("intake");
  f.grant(alex, ["tasks.request"]);
  const t = await f.kernel.ask.request(f.chain([alex]), { title: "Letter", doer: kit, checker: alex, output: { kind: "draft" } });
  await assert.rejects(f.kernel.tasks.move(f.chain([alex]), t.id, "stuck"), { code: "bad_input" });
  await f.kernel.tasks.move(f.chain([alex, kit]), t.id, "stuck", { stuck: { reason: "x", since: 1 } });
  await assert.rejects(f.kernel.tasks.move(f.chain([kit]), t.id, "skipped"), { code: "bad_input" });
});

test("a delegated grant is contained in its parent and takes the parent's conditions", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), kit = f.agent("research");
  f.grant(alex, ["grant.create"]);
  const parent = f.grant(alex, ["records.read", "records.update"], "vyre://spc_test/project/p1", { how: { presence: "fresh" } });
  const c = f.chain([alex]);
  const child = await f.kernel.grants.create(c, { subject: { kind: "actor", actor: kit }, actions: ["records.read"], resource: { prefix: "vyre://spc_test/project/p1" }, conditions: {}, source: "team", parent: parent.id });
  assert.equal(child.conditions.how.presence, "fresh");
  await assert.rejects(f.kernel.grants.create(c, { subject: { kind: "actor", actor: kit }, actions: ["email.send"], resource: { prefix: "vyre://spc_test/project/p1" }, conditions: {}, source: "team", parent: parent.id }), { code: "not_contained" });
  await f.kernel.grants.revoke(c, parent.id, "left");
  assert.equal((await f.kernel.grants.list(c, { status: "active", subject: { kind: "actor", actor: kit } })).length, 0, "a child dies with its parent");
});

test("labels: the weakest trust, the strongest class, every Space", () => {
  const j = joinLabels([memberLabels("spc_a"), { ...externalLabels("spc_b"), red: "pii" }]);
  assert.deepEqual(j, { trust: "external", red: "pii", source_spaces: ["spc_a", "spc_b"] });
  assert.ok(isTainted(j));
});
