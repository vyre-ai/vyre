// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { publishFlow, publishFlowKernel, validateFlow } from "./flow.js";
import { checkFlow } from "../../kernel/flows/schema.js";
import { compileFlow } from "../../kernel/flows/compile.js";
import { ACTIONS } from "./deployment.js";
import { REGISTRIES } from "./edge.js";
import { SPACE } from "./test-kit.js";

const D = { id: "dep_0123456789abcdef", name: "northwind", project: "bakery" };
const flow = () => JSON.parse(JSON.stringify(publishFlow({ space: SPACE, deployment: D })));
const throwsCode = (/** @type {() => any} */ fn, /** @type {string} */ code) => assert.throws(fn, (/** @type {any} */ e) => e.code === code, code);

test("the pipeline: build, preview, ask, production, rollback", () => {
  const f = publishFlow({ space: SPACE.id, deployment: D });
  assert.deepEqual(f.steps.map(s => s.id), ["build", "preview", "approve", "production", "rollback"]);
  assert.equal(f.kind, "def.flow");
  assert.equal(f.authorship, "system");
  assert.ok(Object.isFrozen(f));
  const [build, preview, approve, production, rollback] = /** @type {any[]} */ (f.steps);
  assert.equal(build.fn.tier, 2);
  assert.deepEqual(build.fn.needs.network, [...REGISTRIES]);
  assert.equal(build.fn.needs.sealed, false);
  assert.equal(build.fn.needs.inference, false);
  assert.equal(preview.call, "deploy.preview");
  assert.deepEqual(approve.ask.role, ["owner", "admin", "manager"]);
  assert.equal(production.call, "deploy.publish");
  assert.equal(production.through, "ask");
  assert.equal(rollback.call, "deploy.rollback");
  assert.equal(rollback.through, "ask");
  assert.deepEqual([...f.caps].sort(), ["deploy.preview", "deploy.publish", "deploy.rollback"]);
  assert.equal(JSON.parse(JSON.stringify(f)).on.manual.subject, `vyre://${SPACE.id}/deployment/${D.id}`);
});

test("a deployment without a project does not let a manager approve in the Flow", () => {
  const f = publishFlow({ space: SPACE, deployment: { id: D.id, name: "x" } });
  assert.deepEqual(/** @type {any} */ (f.steps[2]).ask.role, ["owner", "admin"]);
});

test("the Flow touches only declared actions", () => {
  const f = flow();
  const used = f.steps.filter((/** @type {any} */ s) => s.call).map((/** @type {any} */ s) => s.call);
  assert.ok(used.every((/** @type {string} */ a) => a in ACTIONS));
  assert.deepEqual(validateFlow(f), { ok: true, problems: [] });
});

test("the validator rejects what a publish Flow must never do", () => {
  /** @type {Array<[string, (f: any) => void, RegExp]>} */
  const cases = [
    ["an undeclared action", f => { f.steps[1].call = "files.write"; }, /not declared/],
    ["a call outside caps", f => { f.caps = ["deploy.preview", "deploy.publish"]; }, /not in caps/],
    ["an unused cap", f => { f.caps.push("deploy.retire"); }, /never used/],
    ["an unknown cap", f => { f.caps.push("crm.update"); }, /not a declared action/],
    ["production without ask", f => { delete f.steps[3].through; }, /must go through ask/],
    ["production before approval", f => { f.steps.splice(2, 1); }, /approve step must come before/],
    ["an http step", f => { f.steps.push({ id: "x", http: { url: "https://evil.example.com" } }); }, /http steps are not allowed/],
    ["an agent step", f => { f.steps.push({ id: "x", agent: { teammate: "juno" } }); }, /agent steps are not allowed/],
    ["a classify step", f => { f.steps.push({ id: "x", classify: {} }); }, /classify/],
    ["a record write", f => { f.steps.push({ id: "x", update: { record: "r" } }); }, /not allowed/],
    ["network beyond the registries", f => { f.steps[0].fn.needs.network.push("evil.example.com"); }, /not a listed registry/],
    ["a wildcard network", f => { f.steps[0].fn.needs.network = ["*"]; }, /not a listed registry/],
    ["no declared network", f => { f.steps[0].fn.needs.network = []; }, /must declare needs.network/],
    ["sealed access", f => { f.steps[0].fn.needs.sealed = true; }, /no sealed values/],
    ["inference access", f => { f.steps[0].fn.needs.inference = true; }, /inference door/],
    ["a non-sandbox fn", f => { f.steps[0].fn.tier = 1; }, /Tier 2/],
    ["a member as approver", f => { f.steps[2].ask.role = ["member"]; }, /owner, admin or manager/],
    ["a step with two kinds", f => { f.steps[1].ask = {}; }, /exactly one/],
    ["a duplicate step id", f => { f.steps[1].id = "build"; }, /listed twice/],
    ["a forward reference", f => { f.steps[1].after = "rollback"; }, /not an earlier step/],
    ["model authorship", f => { f.authorship = "model"; }, /model-authored/],
    ["no authorship", f => { delete f.authorship; }, /authorship/],
    ["wrong kind", f => { f.kind = "def.rule"; }, /def.flow/],
    ["no steps", f => { f.steps = []; }, /no steps/],
  ];
  for (const [name, mutate, re] of cases) {
    const f = flow();
    mutate(f);
    const v = validateFlow(f);
    assert.equal(v.ok, false, name);
    assert.ok(v.problems.some(p => re.test(p)), `${name}: ${v.problems.join(" | ")}`);
  }
  assert.equal(validateFlow(null).ok, false);
});

test("building a Flow checks its inputs", () => {
  throwsCode(() => publishFlow({ space: "nope", deployment: D }), "bad_input");
  throwsCode(() => publishFlow({ space: SPACE, deployment: { id: "x", name: "a" } }), "bad_input");
});

test("the kernel form of the pipeline passes the Flows schema and compiles, with the outward step named and the caps exactly the deploy ones", () => {
  const f = JSON.parse(JSON.stringify(publishFlowKernel({ space: SPACE.id, deployment: D })));
  assert.deepEqual(checkFlow(f), []);
  const cat = { space: SPACE.id, types: {}, roles: ["owner", "admin", "manager", "member", "temp"], actions: {
    "deploy.build": { risk: "write" }, "deploy.preview": { risk: "write" }, "deploy.publish": { risk: "outward.publish" }, "deploy.rollback": { risk: "outward.publish" }, "ask.request": { risk: "write" } } };
  const r = compileFlow(f, /** @type {any} */ (cat));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.effects.outward.length >= 2, "production and rollback are outward");
  assert.deepEqual(r.caps.map(c => c.action).sort(), ["ask.request", "deploy.build", "deploy.preview", "deploy.publish", "deploy.rollback"]);
  assert.ok(r.caps.filter(c => c.action.startsWith("deploy.")).every(c => c.resource === `vyre://${SPACE.id}/deployment/${D.id}`), "the deploy caps cover only this deployment");
  assert.equal(r.effects.asks, 1);
  assert.deepEqual(f.steps.map(s => s.id), ["build", "preview", "approve", "decide_publish"]);
  assert.ok(Object.isFrozen(publishFlowKernel({ space: SPACE.id, deployment: D })));
});
