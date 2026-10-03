// An assistant in a group writes for the whole room (DESIGN-chat): with more than one person in the chat the model SEES a field as a value only when every
// person in the chat may read it, and any other field only as a token it can cite. Run on the real gateway with a manager and a member of different roles.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRealKernel } from "../../../test/real-kernel.js";
import { tempHome } from "../../../test/helpers.js";
import { open } from "../../store/index.js";
import { buildSituation } from "./situation.js";
import { createMemoryEngine } from "../memory/index.js";

const MATTER = { name: "matter", label: "Matter", fields: [
  { name: "title", kind: "text", label: "Title" }, { name: "client", kind: "text", label: "Client" },
  { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Open"] }, { name: "fee", kind: "money", label: "Fee" },
  { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }], stages: [{ name: "Intake" }, { name: "Open" }] };
const FEE = { amount: 4321, currency: "USD" };

async function world(over = {}) {
  const rk = await createRealKernel({
    defs: [MATTER], agents: { kit: ["records.read"] }, services: { memory: ["records.read", "events.read"] },
    people: { bob: { actions: ["records.read"], fields: ["title", "client", "stage"] } }, model: () => ({ content: "The matter is Doe estate plan [S1]." }), ...over });
  const manager = rk.person(), member = rk.person("bob");
  const m = await rk.kernel.records.create(manager, "matter", { title: "Doe estate plan", client: "Jane Doe", stage: "Intake", fee: FEE, ssn: { sealed: "us-ssn", ref: "seal_1", present: true, valid_format: true, set_at: 1 } });
  return { rk, manager, member, m };
}
const at = m => ({ type: "matter", id: m.id });

test("one to one with the manager the model gets the manager-only value; with a member in the chat it gets a token", async () => {
  const { rk, manager, member, m } = await world();
  // The gateway's own rule: the member's read omits the field.
  assert.equal("fee" in (await rk.kernel.records.get(member, "matter", m.id)).data, false);
  const solo = await buildSituation(rk.kernel, manager, { space: rk.space, project: at(m) });
  assert.match(solo.text, /fee: 4321 USD/);
  assert.equal(solo.parts.group, false);
  const room = await buildSituation(rk.kernel, manager, { space: rk.space, project: at(m), audience: [manager, member] });
  assert.doesNotMatch(room.text, /4321/);
  assert.match(room.text, new RegExp(`fee: restricted here, cite it as \\{\\{field:${m.urn.replace(/[/.]/g, "\\$&")}#fee\\}\\}`));
  assert.match(room.text, /client: Jane Doe/);
  assert.match(room.text, /stage: Intake/);
  assert.deepEqual(room.parts.restricted, ["fee"]);
  assert.doesNotMatch(room.text, /seal_1/);
  assert.match(room.text, /ssn: on file, sealed/);
});

test("the room is narrowed whoever asks and in whatever order, and a chat of one person is a one to one", async () => {
  const { rk, manager, member, m } = await world();
  const a = await buildSituation(rk.kernel, manager, { space: rk.space, project: at(m), audience: [manager, member] });
  const b = await buildSituation(rk.kernel, manager, { space: rk.space, project: at(m), audience: [member, manager] });
  assert.equal(a.text, b.text);
  const one = await buildSituation(rk.kernel, manager, { space: rk.space, project: at(m), audience: [manager] });
  assert.match(one.text, /fee: 4321 USD/);
  const two = await buildSituation(rk.kernel, manager, { space: rk.space, project: at(m), audience: [manager, rk.person()] });
  assert.match(two.text, /fee: 4321 USD/, "two managers may both read it");
});

test("a record someone in the chat cannot read at all is not shown, not even its name", async () => {
  const { rk, manager, m } = await world();
  const outsider = { ...rk.person("bob") };
  const blind = new Proxy(rk.kernel, { get: (t, k) => (k === "records" ? { ...t.records, get: async (c, ...r) => (c === outsider ? null : t.records.get(c, ...r)) } : t[k]) });
  const room = await buildSituation(blind, manager, { space: rk.space, project: at(m), audience: [manager, outsider] });
  assert.doesNotMatch(room.text, /Doe estate plan|Jane Doe|Intake/);
  assert.match(room.text, /not everyone in this chat may read/);
});

test("memory answers and recalled notes follow the same rule: no manager-only value reaches the model while a member is in the chat", async t => {
  const { rk, manager, member, m } = await world();
  const db = open(path.join(tempHome(t), "engine.db"));
  const engine = createMemoryEngine({ kernel: rk.kernel, db, space: rk.space, serviceChain: rk.kernel.serviceChain("memory"), chainFor: () => manager });
  await engine.index({ kind: "record", type: "matter", id: m.id });
  const solo = await engine.answer(manager, "Doe estate plan");
  assert.match(JSON.stringify(rk.modelCalls), /4321/, "alone with the manager the value is in what the model reads");
  rk.modelCalls.length = 0;
  const room = await engine.answer(manager, "Doe estate plan", { audience: [manager, member] });
  const sent = JSON.stringify(rk.modelCalls);
  assert.doesNotMatch(sent, /4321/);
  assert.match(sent, /\{\{field:[^}]*#fee\}\}/);
  assert.ok(solo.citations.length && room.citations.length);
  const hits = await engine.search(manager, "Doe", 6, { audience: [manager, member] });
  assert.doesNotMatch(JSON.stringify(hits), /4321/);
});

test("a source the member may not read is withheld from a group answer, never guessed at, and the model is told that more exists", async t => {
  const { rk, manager, member, m } = await world();
  const m2 = await rk.kernel.records.create(manager, "matter", { title: "Doe trust, privileged", client: "Jane Doe", stage: "Open", fee: FEE });
  const db = open(path.join(tempHome(t), "engine2.db"));
  const engine = createMemoryEngine({ kernel: rk.kernel, db, space: rk.space, serviceChain: rk.kernel.serviceChain("memory"), chainFor: () => manager });
  await engine.index({ kind: "record", type: "matter", id: m.id });
  await engine.index({ kind: "record", type: "matter", id: m2.id });
  const real = rk.kernel.authorize;
  rk.kernel.authorize = async i => (i.resource === m2.urn && i.chain.hops[0].actor.id === "bob" ? { effect: "deny", obligations: [] } : real(i));
  const hits = await engine.search(manager, "Doe", 6, { audience: [manager, member] });
  assert.equal(hits.withheld, 1);
  assert.ok(hits.every(h => h.source !== m2.urn));
  const a = await engine.answer(manager, "Doe", { audience: [manager, member] });
  const sent = JSON.stringify(rk.modelCalls.at(-1));
  assert.doesNotMatch(sent, /privileged/);
  assert.match(sent, /more source\(s\) exist that not everyone in this chat may read/);
  assert.equal(a.withheld, 1);
  assert.equal((await engine.search(manager, "Doe", 6)).withheld, 0, "alone with the manager nothing is withheld");
});
