// @ts-check
// Flow text ("See as code") and @Engineer against a fake box.
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const EFFECTS = { reads: ["matter"], writes: ["matter"], outward: ["email.send"], services: [], code: [], asks: 2, assigns: ["teammate:intake"], sealed_uses: [], destinations: [], model_steps: [], needs_run_ask: false };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: {} }; };
  return { call, seen };
}

test("See as code: the version's text, Check against this Flow, Save as a new version of it", { skip: !strip }, async () => {
  const { engineerSource } = await import("./engineer-source.ts");
  const m = await import("./engineer-model.ts");
  const b = box({ "flows.code": { data: { text: "export default 1", hash: "h" } }, "flows.compile-text": { data: { ok: true, errors: [], warnings: ["It sends mail"], effects: EFFECTS, changes: ["Adds a step: x."] } }, "flows.define": { data: { ok: true, id: "welcome", version: 2, hash: "h2" } } });
  const s = engineerSource(b.call);
  assert.equal((await s.code("welcome", 1)).text, "export default 1");
  const c = await s.check("t", "welcome");
  assert.equal(m.verdict(c).tone, "ok");
  assert.deepEqual(m.effectLines(c.effects), ["Reads: matter.", "Writes: matter.", "Sends or publishes: email.send.", "Asks a person 2 times.", "Hands work to: teammate:intake."]);
  await s.save("t", "welcome");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["flows.code", { id: "welcome", version: 1 }], ["flows.compile-text", { text: "t", id: "welcome" }], ["flows.define", { text: "t", id: "welcome" }]]);
});

test("a bad text says what is wrong in the kernel's words and a refusal stays plain", { skip: !strip }, async () => {
  const { engineerSource } = await import("./engineer-source.ts");
  const m = await import("./engineer-model.ts");
  const bad = box({ "flows.compile-text": { data: { ok: false, errors: [{ path: "line 1", message: "only @vyre/sdk may be imported" }], changes: [] } } });
  const r = await engineerSource(bad.call).check("hello");
  assert.deepEqual(bad.seen, [{ tool: "flows.compile-text", input: { text: "hello" } }]);
  assert.deepEqual([m.verdict(r).title, m.problemLine(r.errors[0])], ["1 problem to fix", "line 1: only @vyre/sdk may be imported"]);
  assert.equal(m.flowHref({ ok: false, errors: [] }), null);
  assert.match(m.engineerRefusal("forbidden", ""), /may not write Flows/);
});

test("@Engineer: found by name, set up with instructions that only propose, first message through agents.ask", { skip: !strip }, async () => {
  const { assistantSource } = await import("./assistant-source.ts");
  const m = await import("./assistant-model.ts");
  const AGENTS = [{ name: "juno", kind: "assistant", thread: "t1" }, { name: "Engineer", kind: "agent", thread: null }];
  const b = box({ "agents.list": { data: AGENTS }, "spaces.list": { data: [{ id: "s", role: "admin" }] } });
  const s = assistantSource(b.call);
  const eng = m.findEngineer(await s.agents());
  assert.equal(eng?.name, "Engineer");
  assert.deepEqual([m.stateOf(null), m.stateOf(eng), m.stateOf({ ...AGENTS[1], thread: "t9" })], ["none", "new", "ready"]);
  assert.deepEqual([m.mayTalk(await s.role()), m.mayTalk("member"), m.mayTalk("owner")], [true, false, true]);
  await s.create(m.ENGINEER, m.INSTRUCTIONS); await s.say("engineer", "Make me an intake Flow.");
  const [, , create, say] = b.seen;
  assert.equal(create.tool, "agents.create");
  assert.deepEqual([create.input.name, create.input.kind, create.input.projects], ["engineer", "agent", []]);
  assert.match(create.input.instructions, /only propose/);
  assert.deepEqual(say, { tool: "agents.ask", input: { agent: "engineer", text: "Make me an intake Flow." } });
});

test("what is waiting for a person: Flow versions not approved and Kits pending, each with where to approve", { skip: !strip }, async () => {
  const { assistantSource } = await import("./assistant-source.ts");
  const m = await import("./assistant-model.ts");
  const b = box({ "flows.list": { data: [{ id: "a", name: "Intake", status: "approved" }, { id: "b", name: "Estate leads", status: "draft" }] }, "flows.kit.list": { data: [{ id: "estate-planning", version: 1, status: "pending" }, { id: "x", version: 1, status: "installed" }] } });
  const s = assistantSource(b.call);
  const cards = m.proposals(await s.flows(), await s.kits());
  assert.deepEqual(cards.map((c) => [c.title, c.sub, c.href]), [["Estate leads", "A Flow waiting for your approval", "/u/flows/b"], ["estate planning", "A Kit waiting for your yes", null]]);
});
