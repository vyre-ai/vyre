import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { KINDS, DEFAULT_STAGES, parseStages, stagesProblem, createInput } from "./kinds.js";

test("there are four kinds to choose, in order, and Personal is not one of them", () => {
  assert.deepEqual(KINDS.map((k) => k.label), ["Stages", "For a client", "Ongoing", "Simple"]);
  assert.ok(!KINDS.some((k) => /personal/i.test(k.key + k.label)));
  assert.ok(KINDS.every((k) => k.blurb.length > 20 && !/matter/i.test(k.blurb)));
});

test("a typed stage list is trimmed and deduplicated, and a bad one says why", () => {
  assert.deepEqual(parseStages(" Plan , Do,Check\nPlan,, "), ["Plan", "Do", "Check"]);
  assert.equal(stagesProblem([]), "Name at least one stage.");
  assert.equal(stagesProblem(Array.from({ length: 13 }, (_, i) => `S${i}`)), "Twelve stages at most.");
  assert.equal(stagesProblem(["x".repeat(61)]), "A stage name is 60 characters at most.");
  assert.equal(stagesProblem([...DEFAULT_STAGES]), null);
});

test("the create call carries the kind, and stages and client only where they belong", () => {
  assert.deepEqual(createInput("stages", { name: " Spring launch " }), { name: "Spring launch", kind: "stages", stages: ["Brief", "Draft", "Review", "Launch", "Wrap up"] });
  assert.deepEqual(createInput("stages", { name: "A", stages: ["Plan", "Do"] }).stages, ["Plan", "Do"]);
  assert.deepEqual(createInput("client", { name: "Northwind", client: "vyre://s/contact/c1", stages: ["X"] }), { name: "Northwind", kind: "client", client: "vyre://s/contact/c1" });
  assert.deepEqual(createInput("ongoing", { name: "Office", client: "vyre://s/contact/c1" }), { name: "Office", kind: "ongoing" });
  assert.deepEqual(createInput("simple", { name: "Notes" }), { name: "Notes", kind: "simple" });
});
