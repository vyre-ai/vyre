// @ts-check
// e4: errors that name the place and the fix.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nearest, placeOf, decorate } from "./places.js";
import { compileFlow } from "./compile.js";
import { world } from "./testing/world.js";

const flowOf = (/** @type {any[]} */ steps) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });

test("e4: the nearest real name, or none when nothing is close", () => {
  assert.equal(nearest("client_name", ["client", "email", "phone"]), "client");
  assert.equal(nearest("emial", ["client", "email", "phone"]), "email");
  assert.equal(nearest("zzzzzz", ["client", "email"]), null);
});

test("e4: a path inside a block, a branch and a failure path finds its step and number", () => {
  const f = flowOf([{ id: "a", kind: "decide", if: "true", then: [{ id: "b", kind: "create", type: "m", set: {} }], else: [] }, { id: "c", kind: "create", type: "m", set: {}, on_fail: { steps: [{ id: "d", kind: "create", type: "m", set: {} }] } }]);
  assert.deepEqual(placeOf(f, "steps[0].then[0].set.x"), { n: "1.1", id: "b" });
  assert.deepEqual(placeOf(f, "steps[1].on_fail.steps[0].type"), { n: "2.1", id: "d" });
  assert.equal(placeOf(f, "trigger.type"), null);
});

test("e4: a misspelt type, field, step reference and action each say where and what", async () => {
  const w = await world({});
  const cat = await w.runner.catalogFn();
  const type = Object.keys(cat.types)[0];
  const field = (cat.types[type].fields || [])[0].name;
  const bad = (/** @type {any[]} */ steps) => compileFlow(flowOf(steps), cat).errors;
  let e = bad([{ id: "x", kind: "create", type: type + "s", set: {} }]);
  assert.ok(e.some(p => p.step === "x" && p.fix === `did you mean ${type}?` && /^Step 1 \(x\): /.test(p.message)), JSON.stringify(e));
  e = bad([{ id: "x", kind: "create", type, set: { [field + "z"]: "v" } }]);
  assert.ok(e.some(p => p.fix === `did you mean ${field}?`), JSON.stringify(e));
  e = bad([{ id: "x", kind: "create", type, set: { [field]: "v" } }, { id: "y", kind: "create", type, set: { [field]: { expr: "steps.xx.record.id" } } }]);
  assert.ok(e.some(p => p.step === "y" && p.fix === "did you mean x?"), JSON.stringify(e));
  e = bad([{ id: "x", kind: "call", action: "email.snd", resource: "vyre://s/email/x" }]);
  assert.ok(e.some(p => p.step === "x" && /^(did you mean|the choices are)/.test(p.fix || "")), JSON.stringify(e));
});

test("e4: no close name gives the choices, and the old path and message still hold", () => {
  const [p] = decorate(flowOf([{ id: "x", kind: "create", type: "q", set: {} }]), [{ path: "steps[0].type", message: "there is no record type q", bad: "q", choices: ["matter", "client", "payment"] }]);
  assert.equal(p.path, "steps[0].type");
  assert.match(p.message, /there is no record type q/);
  assert.equal(p.fix, "the choices are matter, client, payment");
});
