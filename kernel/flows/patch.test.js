// @ts-check
// e2: edit by patch.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";
import { applyPatch, PatchError } from "./patch.js";

const flowOf = (/** @type {any[]} */ steps) => ({ format: 1, name: "t", label: "Welcome", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const chainOf = () => ({ hops: [{ actor: ALEX }] });
const toolsOf = (/** @type {any} */ w) => createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, runner: w.runner, store: w.store, catalog: () => w.runner.catalogFn() });
const m = (/** @type {string} */ id, client = "x") => ({ id, kind: "create", type: "matter", set: { client } });

test("e2: each op changes only what it names, on a copy", () => {
  const base = flowOf([m("a"), { id: "d", kind: "decide", if: "true", then: [m("b")], else: [] }, m("c")]);
  const keep = JSON.stringify(base);
  let f = applyPatch(base, [{ op: "set", step: "a", key: "set.client", value: "Jane" }]);
  assert.equal(f.steps[0].set.client, "Jane");
  f = applyPatch(f, [{ op: "set", step: "a", key: "label", value: "First" }, { op: "set", step: "a", key: "label" }]);
  assert.equal(f.steps[0].label, undefined);
  f = applyPatch(f, [{ op: "insert", after: "a", line: "n find type=matter" }]);
  assert.deepEqual(f.steps.map((/** @type {any} */ s) => s.id), ["a", "n", "d", "c"]);
  f = applyPatch(f, [{ op: "insert", into: "d", block: "else", line: "e create type=matter set={client: y}" }]);
  assert.equal(f.steps[2].else[0].id, "e");
  f = applyPatch(f, [{ op: "replace", step: "c", line: "c2 find type=matter" }, { op: "move", step: "c2", by: -3 }, { op: "remove", step: "b" }]);
  assert.deepEqual(f.steps.map((/** @type {any} */ s) => s.id), ["c2", "a", "n", "d"]);
  assert.deepEqual(f.steps[3].then, []);
  f = applyPatch(f, [{ op: "meta", key: "label", value: "Renamed" }, { op: "trigger", trigger: { on: "manual" } }]);
  assert.equal(f.label, "Renamed"); assert.equal(f.trigger.on, "manual");
  assert.equal(JSON.stringify(base), keep, "the input is never changed");
});

test("e2: a bad op names its place and what to do", () => {
  const base = flowOf([m("client"), m("matter")]);
  const bad = (/** @type {any[]} */ ops, /** @type {RegExp} */ re) => assert.throws(() => applyPatch(base, ops), (e) => e instanceof PatchError && re.test(e.message), JSON.stringify(ops));
  bad([{ op: "remove", step: "clent" }], /op 1: there is no step clent; did you mean client\?/);
  bad([{ op: "set", step: "client", key: "id", value: "z" }], /keeps its id and kind/);
  bad([{ op: "set", step: "client", key: "__proto__", value: 1 }], /key is a name/);
  bad([{ op: "insert", line: "x find type=matter" }], /say where/);
  bad([{ op: "insert", after: "client", line: "x find type=matter\ny find type=matter" }], /exactly one step/);
  bad([{ op: "insert", after: "client", line: "x find type=" }], /op 1:/);
  bad([{ op: "meta", key: "authorship", value: "kit" }], /key is one of/);
  bad([{ op: "wat" }], /op is one of/);
  bad([], /give ops/);
});

test("e2: flows.patch stores a new draft, says what changed, and refuses a patch made against an older version", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const v = await install(w, flowOf([m("a"), m("b")]));
  const r = await f.tools["flows.patch"](chainOf(), { id: v.id, base: v.version, ops: [{ op: "set", step: "b", key: "set.client", value: "Z" }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.version, v.version + 1);
  assert.ok(r.changes.some((/** @type {string} */ c) => /Changes a step/.test(c)), JSON.stringify(r.changes));
  await assert.rejects(() => f.tools["flows.patch"](chainOf(), { id: v.id, base: v.version, ops: [{ op: "remove", step: "a" }] }), /Flow is at version 2/);
  const next = await f.tools["flows.patch"](chainOf(), { id: v.id, base: r.version, ops: [{ op: "remove", step: "nope" }] });
  assert.equal(next.ok, false);
  assert.match(next.errors[0].message, /there is no step nope/);
  const bad = await f.tools["flows.patch"](chainOf(), { id: v.id, ops: [{ op: "set", step: "a", key: "set.nofield", value: 1 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /^Step 1 \(a\): .*has no field nofield/);
  const active = await w.store.active(v.id);
  assert.equal(active.version, v.version, "the live version is untouched");
});

test("0.6: a patch reaches a step's failure path and the Flow's own failure steps, and sets sends and returns", () => {
  const base = flowOf([m("a"), m("c")]);
  // a step's failure path: made, filled, edited, moved and removed by name
  let f = applyPatch(base, [{ op: "insert", into: "a", block: "on_fail", step: m("h1") }, { op: "insert", after: "h1", step: m("h2") }]);
  assert.deepEqual(f.steps[0].on_fail, { steps: [m("h1"), m("h2")], then: "stop" });
  f = applyPatch(f, [{ op: "set", step: "h2", key: "set.client", value: "Z" }, { op: "move", step: "h2", by: -1 }]);
  assert.deepEqual(f.steps[0].on_fail.steps.map((/** @type {any} */ s) => s.id), ["h2", "h1"]);
  assert.equal(f.steps[0].on_fail.steps[0].set.client, "Z");
  f = applyPatch(f, [{ op: "remove", step: "h1" }, { op: "replace", step: "h2", with: m("h3") }]);
  assert.deepEqual(f.steps[0].on_fail.steps.map((/** @type {any} */ s) => s.id), ["h3"]);
  assert.equal(base.steps[0].on_fail, undefined, "the stored Flow is not changed");
  // the Flow's own failure steps
  f = applyPatch(base, [{ op: "insert", lane: "on_failure", first: true, step: m("n1") }, { op: "insert", lane: "on_failure", after: "n1", step: m("n2") }, { op: "set", step: "n2", key: "set.client", value: "Q" }]);
  assert.deepEqual(f.on_failure.map((/** @type {any} */ s) => s.id), ["n1", "n2"]);
  assert.equal(f.on_failure[1].set.client, "Q");
  f = applyPatch(f, [{ op: "move", step: "n2", by: -1 }, { op: "remove", step: "n1" }]);
  assert.deepEqual(f.on_failure.map((/** @type {any} */ s) => s.id), ["n2"]);
  // sends and returns are Flow settings
  f = applyPatch(base, [{ op: "meta", key: "sends", value: { allow: ["mail"], max: 5 } }, { op: "meta", key: "returns", value: { matter: "steps.a.record.id" } }]);
  assert.deepEqual(f.sends, { allow: ["mail"], max: 5 });
  assert.deepEqual(f.returns, { matter: "steps.a.record.id" });
  const bad = (/** @type {any[]} */ ops, /** @type {RegExp} */ re) => assert.throws(() => applyPatch(base, ops), re);
  bad([{ op: "insert", lane: "steps", first: true, step: m("x") }], /lane is on_failure/);
  bad([{ op: "insert", lane: "on_failure", step: m("x") }], /say where in the failure steps/);
  bad([{ op: "insert", into: "nope", block: "on_fail", step: m("x") }], /no step nope/);
});
