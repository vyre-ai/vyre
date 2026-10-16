// @ts-check
import "../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { personCallOpts, provenFromMeta, moduleRelayNeedsProvenCall } from "./person-relay.js";
import { listPersonRelayEntryPoints, composerPersonRelayTargets } from "./person-relay-entrypoints.js";

test("personCallOpts binds surface label and proven session", () => {
  const meta = { token: "tok", kernelFacts: { kind: "device", person: "per_a" } };
  assert.deepEqual(personCallOpts("deck", meta), { as: "deck", token: "tok", kernelFacts: meta.kernelFacts });
  assert.equal(personCallOpts("mcp:agent:kit", meta), null);
  assert.deepEqual(provenFromMeta({ person: { id: "ps_1" } }), { person: { id: "ps_1" } });
});

test("moduleRelayNeedsProvenCall is true only for a person surface label", () => {
  assert.equal(moduleRelayNeedsProvenCall("cli"), true);
  assert.equal(moduleRelayNeedsProvenCall("deck"), true);
  assert.equal(moduleRelayNeedsProvenCall("module:threads"), false);
});

test("entry points are derived from composer routes and registry tools", () => {
  assert.ok(composerPersonRelayTargets().includes("planner.add"));
  const fake = { tools: { has: (n) => ["threads.slash", "threads.send", "threads.edit", "stream.send"].includes(n) } };
  const eps = listPersonRelayEntryPoints(fake);
  assert.ok(eps.some((e) => e.id === "composer.slash" && e.tool === "threads.slash"));
  assert.ok(eps.some((e) => e.id === "composer.send" && e.nested.includes("mentions.resolve")));
});
