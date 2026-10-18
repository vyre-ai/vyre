// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { samplePlan, resolve, urnsOf, SAMPLE_TAG } from "./sample.js";
import { CORE_TYPES } from "../../records/core-types.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");

test("the sample set is made in an order where every reference is made first", () => {
  /** @type {Map<string, string>} */ const made = new Map();
  for (const item of samplePlan(NOW)) {
    assert.ok(!made.has(item.key), `${item.key} is once`);
    for (const v of Object.values(item.data)) resolve(v, made);
    made.set(item.key, `vyre://s/${item.type}/${item.key}`);
  }
});

test("every record carries the sample tag where its type has tags, and every type and field exists", () => {
  const types = new Map(CORE_TYPES.map((t) => [t.name, t]));
  for (const item of samplePlan(NOW)) {
    const t = types.get(item.type);
    assert.ok(t, `${item.type} is a core type`);
    const fields = new Set(t.fields.map((f) => f.name));
    for (const k of Object.keys(item.data)) assert.ok(fields.has(k), `${item.type}.${k}`);
    if (fields.has("tags")) assert.deepEqual(JSON.parse(item.data.tags), [SAMPLE_TAG], `${item.key} is tagged`);
  }
});

test("sample stages and roles are real ones, and a deal's weighted value is its amount times its chance", () => {
  const types = new Map(CORE_TYPES.map((t) => [t.name, t]));
  for (const item of samplePlan(NOW)) {
    const t = types.get(item.type);
    const sf = t.fields.find((f) => f.kind === "stage");
    if (sf && item.data[sf.name] !== undefined) assert.ok(sf.options.includes(item.data[sf.name]), `${item.key}: ${item.data[sf.name]}`);
    if (item.type === "deal") assert.equal(item.data.weighted_value, Math.round(item.data.amount * item.data.probability) / 100);
    if (item.type === "relationship") assert.ok(types.get("relationship").fields.find((f) => f.name === "kind").options.includes(item.data.kind));
  }
});

test("the sample set names no industry", () => {
  const text = JSON.stringify(samplePlan(NOW));
  assert.doesNotMatch(text, /law|legal|attorney|lawyer|client matter|estate|probate|—/i.source ? /law|legal|attorney|lawyer|estate|probate|—/i : /x/);
});

test("a reference is filled in with an address, a link becomes { urn }, and a missing one is a plain error", () => {
  const made = new Map([["ava", "vyre://s/contact/1"]]);
  assert.equal(resolve("$ava", made), "vyre://s/contact/1");
  assert.deepEqual(resolve({ link: "$ava" }, made), { urn: "vyre://s/contact/1" });
  assert.equal(resolve("plain", made), "plain");
  assert.throws(() => resolve("$nobody", made), /before it is made/);
});

test("the ledger gives back addresses only, never anything else", () => {
  const good = "vyre://s/contact/0192f5a0-0000-7000-8000-000000000001";
  assert.deepEqual(urnsOf(JSON.stringify([good, "not a urn", 5, "vyre://s/../x/1"])), [good]);
  assert.deepEqual(urnsOf("{{bad"), []);
  assert.deepEqual(urnsOf(undefined), []);
});
