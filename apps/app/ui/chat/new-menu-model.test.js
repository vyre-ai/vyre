// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { newMenuRows, firstRow } from "./new-menu-model.js";

const agents = [{ name: "Assistant", role: "Yours" }, { name: "Engineer" }, { name: "Scout" }];
const people = [{ id: "per_dana", name: "Dana Marsh" }, { id: "per_sam", name: "Sam Reyes" }];

test("nothing typed: every agent and person, then New group, New agent, New Flow", () => {
  const r = newMenuRows("", agents, people);
  assert.deepEqual(r.agents.map((x) => x.label), ["Assistant", "Engineer", "Scout"]);
  assert.deepEqual(r.people.map((x) => x.label), ["Dana Marsh", "Sam Reyes"]);
  assert.deepEqual(r.make.map((x) => x.label), ["New group", "New agent", "New Flow"]);
  assert.equal(firstRow(r)?.label, "Assistant");
});

test("a typed word narrows agents and people, best first, and drops the New rows", () => {
  const r = newMenuRows("sa", agents, people);
  assert.deepEqual(r.agents, [], "no agent has 'sa' in its name");
  assert.deepEqual(r.people.map((x) => x.label), ["Sam Reyes"]);
  assert.deepEqual(r.make, []);
  const both = newMenuRows("an", agents, people);
  assert.deepEqual(both.agents.map((x) => x.label), ["Assistant"], "holds 'an' (assistANt)");
  assert.deepEqual(both.people.map((x) => x.label), ["Dana Marsh"], "Dana holds 'an'");
});

test("nothing matches: no rows and no first row", () => {
  const r = newMenuRows("zzz", agents, people);
  assert.equal(firstRow(r), null);
});
