// @ts-check
// t2: saved test cases hold an approval back while one fails.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";
import { checkCase } from "./cases.js";

const flowOf = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", label: "Welcome", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const chainOf = () => ({ hops: [{ actor: ALEX }] });
const agentChain = () => ({ hops: [{ actor: ALEX }, { actor: { kind: "agent", id: "juno", space: ALEX.space } }] });
const toolsOf = (/** @type {any} */ w) => createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, runner: w.runner, store: w.store, catalog: () => w.runner.catalogFn() });
const matter = (/** @type {string} */ id, /** @type {string} */ expr) => ({ id, kind: "create", type: "matter", set: { client: { expr } } });

test("t2: checkCase refuses what a case cannot be", () => {
  assert.deepEqual(checkCase({ name: "a", event: { type: "payment.received", data: {} }, expect: { state: "completed", writes: { matter: 1 } } }), []);
  assert.ok(checkCase({ event: { type: "x" } }).some(p => p.path === "name"));
  assert.ok(checkCase({ name: "a" }).some(p => /not both/.test(p.message)));
  assert.ok(checkCase({ name: "a", input: {}, expect: { bogus: 1 } }).some(p => /bogus/.test(p.message)));
});

test("t2: a case from words runs, and approving is refused once the Flow changes so it fails", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const v1 = await install(w, flowOf([matter("m", "trigger.name")]));
  const saved = await f.tools["flows.test.save"](chainOf(), { id: v1.id, name: "one matter", event: { type: "payment.received", data: { name: "Jane" } }, expect: { state: "completed", writes: { matter: 1 }, steps_ran: ["m"] } });
  assert.match(saved.ran, /one matter: ok/);
  const run = await f.tools["flows.test.run"](chainOf(), { id: v1.id });
  assert.equal(run.ok, true);
  assert.equal(run.summary, "1 of 1 test case pass");
  const two = await w.runner.define(v1.id, flowOf([matter("m", "trigger.name"), matter("m2", "trigger.name")]), ALEX);
  assert.equal(two.ok, true, JSON.stringify(two.errors));
  await assert.rejects(() => w.runner.approve(v1.id, two.version, ALEX, two.hash), /a saved test case fails.*one matter: it wrote 2 matter, expected 1/);
  const ok = await w.runner.define(v1.id, flowOf([matter("m", "trigger.name"), { id: "n", kind: "find", type: "matter" }]), ALEX);
  await w.runner.approve(v1.id, ok.version, ALEX, ok.hash);
});

test("t2: a case saved from a real run keeps what the Flow did as the baseline", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const v = await install(w, flowOf([matter("m", "trigger.name")]));
  w.kernel.inbound("payment.received", { name: "Jane" }); await settle(w);
  const run = (await w.runner.listRuns())[0];
  const saved = await f.tools["flows.test.save"](chainOf(), { id: v.id, from_run: run.id, name: "baseline" });
  assert.equal(saved.expect.state, "completed");
  assert.deepEqual(saved.expect.writes, { matter: 1 });
  assert.deepEqual((await f.tools["flows.test.list"](chainOf(), { id: v.id })).cases.map((/** @type {any} */ c) => c.name), ["baseline"]);
});

test("t2: an assistant adds cases but cannot change or remove one; a case on a trigger that does not match fails", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const v = await install(w, flowOf([matter("m", "trigger.name")]));
  const c = { id: v.id, name: "a", event: { type: "payment.received", data: { name: "J" } }, expect: { writes: { matter: 1 } } };
  await f.tools["flows.test.save"](agentChain(), c);
  await assert.rejects(() => f.tools["flows.test.save"](agentChain(), { ...c, expect: { writes: { matter: 0 } } }), /an assistant adds cases, a person changes one/);
  await assert.rejects(() => f.tools["flows.test.remove"](agentChain(), { id: v.id, name: "a" }), /only a person/);
  await f.tools["flows.test.save"](chainOf(), { id: v.id, name: "wrong", event: { type: "case.opened", data: {} }, expect: {} });
  const r = await f.tools["flows.test.run"](chainOf(), { id: v.id });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((/** @type {string} */ l) => /wrong: the trigger did not start the Flow/.test(l)), r.lines.join("\n"));
  await f.tools["flows.test.remove"](chainOf(), { id: v.id, name: "wrong" });
  assert.equal((await f.tools["flows.test.run"](chainOf(), { id: v.id })).ok, true);
});

test("t2: a Flow with no cases approves as before", async () => {
  const w = await world({});
  await install(w, flowOf([matter("m", "trigger.name")]));
});
