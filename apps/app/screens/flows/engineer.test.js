// @ts-check
// Flow text ("See as code") and @Engineer against a fake box.
import "../../../../scripts/mac-test-guard.mjs";
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
  assert.deepEqual(m.effectLines(c.effects), ["Reads: matter.", "Writes: matter.", "Sends or publishes: email.send.", "Asks a person 2 times.", "Hands work to: intake."]);
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

test("@Engineer: found by name (built in, never created by the app), first message through agents.ask", { skip: !strip }, async () => {
  const { assistantSource } = await import("./assistant-source.ts");
  const m = await import("./assistant-model.ts");
  const AGENTS = [{ name: "juno", kind: "assistant", thread: "t1" }, { name: "Engineer", kind: "agent", thread: null }];
  const b = box({ "agents.list": { data: AGENTS }, "spaces.list": { data: [{ id: "s", role: "admin" }] } });
  const s = assistantSource(b.call);
  const eng = m.findEngineer(await s.agents());
  assert.equal(eng?.name, "Engineer");
  assert.deepEqual([m.stateOf(null), m.stateOf(eng), m.stateOf({ ...AGENTS[1], thread: "t9" })], ["none", "new", "ready"]);
  assert.deepEqual([m.mayTalk(await s.role()), m.mayTalk("member"), m.mayTalk("owner")], [true, false, true]);
  await s.say("engineer", "Make me an intake Flow.");
  const say = b.seen[b.seen.length - 1];
  assert.ok(!b.seen.some((x) => x.tool === "agents.create"), "the Engineer is built in: the app never creates it");
  assert.deepEqual(say, { tool: "agents.ask", input: { agent: "engineer", text: "Make me an intake Flow." } });
});

test("what is waiting for a person: Flow versions not approved and Kits pending, each with where to approve", { skip: !strip }, async () => {
  const { assistantSource } = await import("./assistant-source.ts");
  const m = await import("./assistant-model.ts");
  const b = box({ "flows.list": { data: [{ id: "a", name: "intake", label: "Intake", status: "active", active: 1 }, { id: "b", name: "estate_leads", label: "Estate leads", status: "draft", active: null }] }, "flows.kit.list": { data: [{ id: "estate-planning", version: 1, status: "pending" }, { id: "x", version: 1, status: "installed" }] } });
  const s = assistantSource(b.call);
  const cards = m.proposals(await s.flows(), await s.kits());
  assert.deepEqual(cards.map((c) => [c.title, c.sub, c.href]), [["Estate leads", "A Flow waiting for your approval", "/u/flows/b"], ["estate planning", "A Kit waiting for your yes", null]]);
});

test("a proposal task in Now is a card that opens its approve page (only form.kind proposal counts), beside a pending Kit", { skip: !strip }, async () => {
  const { assistantSource } = await import("./assistant-source.ts");
  const m = await import("./assistant-model.ts");
  const rows = [{ id: "t1", title: "Add a Retainer type", state: "ready", form: { kind: "proposal", what: "types" } }, { id: "t2", title: "Old", state: "done", form: { kind: "proposal", what: "flow" } }, { id: "t3", kind: "proposal", title: "Not one: only form.kind counts", state: "ready" }, { id: "t4", title: "Install Estate planning", state: "ready", form: { kind: "kit_install" } }];
  const b = box({ "tasks.list": { data: { tasks: rows } }, "flows.list": { data: [] }, "flows.kit.list": { data: [{ id: "estate-planning", version: 1, status: "pending" }] } });
  const s = assistantSource(b.call);
  const cards = m.proposals(await s.flows(), await s.kits(), await s.tasks());
  assert.deepEqual(cards.map((c) => [c.title, c.href]), [["Add a Retainer type", "/u/task/t1"], ["estate planning", null]]);
  assert.deepEqual(m.proposals([], [], []), []);
});

test("What it would do reads the kernel's real effects (objects, not names): no line says [object Object]", { skip: !strip }, async () => {
  const m = await import("./engineer-model.ts");
  const { compileFlow } = await import("../../../../kernel/flows/compile.js");
  const { catalog, SPACE } = await import("../../../../kernel/flows/testing/fixtures.js");
  const flow = { format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "m", kind: "create", type: "matter", set: { client: "A" } },
    { id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com" } },
    { id: "who", kind: "assign", to: "role:manager", title: "Look", output: { kind: "note" } },
    { id: "sv", kind: "service", connector: "practice", method: "POST", path: "/matters", body: { client: "A" } },
  ] };
  const c = compileFlow(flow, catalog());
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  const lines = m.effectLines(c.effects);
  assert.ok(lines.length >= 3, JSON.stringify(lines));
  assert.ok(lines.every((l) => !/\[object Object\]/.test(l)), JSON.stringify(lines));
  assert.ok(lines.some((l) => /Sends or publishes: .*email\.send/.test(l)), JSON.stringify(lines));
  assert.ok(lines.some((l) => /Hands work to: the manager role/.test(l)), JSON.stringify(lines));
  assert.ok(lines.every((l) => !/\brole:/.test(l)), "no raw role:x");
});

test("the card says what sends on its own after the one yes, and what still asks", async () => {
  const m = await import("./engineer-model.ts");
  const sends = { steps: [{ step: "a", action: "email.send", to: ["sam@x.com"], source: "literal", approve: false }, { step: "b", action: "email.send", to: [], source: "outside", approve: false }], allow: ["sam@x.com"], max: 20, per_minute: 5, outside: "ask" };
  const lines = m.effectLines({ sends });
  assert.match(lines[0], /sends on its own to sam@x\.com: up to 20 sends in all and 5 sends a minute, then it stops and tells you/);
  assert.match(lines[1], /Still asks you first: email\.send \(it goes to someone found in the message\)/);
});
