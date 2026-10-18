// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rollupField, weightedOf, withWeighted } from "./rollup.js";

test("a roll-up becomes a computed number field over the records that point here", () => {
  assert.deepEqual(rollupField({ name: "open_value", label: "Open value", over: { type: "deal", via: "organization" }, fn: "sum", field: "weighted_value" }, "organization"),
    { name: "open_value", kind: "number", label: "Open value", computed: { over: { type: "deal", via: "organization", fn: "sum", field: "weighted_value" } } });
  assert.deepEqual(rollupField({ name: "deals", over: { type: "deal", via: "organization" }, fn: "count" }, "organization").computed.over, { type: "deal", via: "organization", fn: "count" });
  assert.throws(() => rollupField({ name: "x", over: { type: "deal", via: "organization" }, fn: "sum" }, "organization"), /give field/);
  assert.throws(() => rollupField({ name: "x", over: { type: "deal", via: "organization" }, fn: "median" }, "organization"), /fn is one of/);
  assert.throws(() => rollupField({ name: "Bad", over: { type: "deal", via: "o" }, fn: "count" }, "organization"), /lowercase/);
  assert.throws(() => rollupField({ name: "ok", over: { type: "deal" }, fn: "count" }, "organization"), /over is/);
});

test("weighted value is amount x chance, to the cent, and only when both are known", () => {
  assert.equal(weightedOf({ amount: 1000, probability: 60 }), 600);
  assert.equal(weightedOf({ amount: 333.33, probability: 10 }), 33.33);
  assert.equal(weightedOf({ amount: 1000 }), null);
  assert.equal(weightedOf({ amount: "", probability: 50 }), null);
});

test("a write keeps weighted_value current on a type that has the three fields, and leaves other types alone", () => {
  const fields = [{ name: "amount" }, { name: "probability" }, { name: "weighted_value" }];
  assert.deepEqual(withWeighted(fields, { amount: 200, probability: 50 }, { probability: 100 }), { probability: 100, weighted_value: 200 });
  assert.deepEqual(withWeighted(fields, { amount: 200 }, { name: "x" }), { name: "x" }, "untouched when neither number changes");
  assert.deepEqual(withWeighted([{ name: "amount" }], { amount: 1 }, { amount: 2 }), { amount: 2 });
});
