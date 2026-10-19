// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPipeline, addStageIn, chanceOf, colourInput, moveStageIn, patchStage, pipelinesInput, pipelinesOf, removeStageIn, stageColour } from "./pipelines.js";

const def = {
  name: "deal",
  fields: [{ name: "stage", kind: "stage", options: ["Lead", "Won"] }, { name: "pipeline", kind: "choice", options: ["Sales", "Partners"] }],
  stages: [{ name: "Lead", probability: 10 }, { name: "Won", probability: 100, enter_if: "not empty(amount)" }],
  stage_sets: [{ name: "Partners", stages: [{ name: "Intro" }, { name: "Lost", enter_if: "not empty(lost_reason)" }] }],
  option_colors: { stage: { Lead: "blue" } },
};

test("a type with two pipelines reads as two, the default first, with chances", () => {
  const p = pipelinesOf(def);
  assert.deepEqual(p.map((x) => x.name), ["Sales", "Partners"]);
  assert.deepEqual(p[0].stages, [{ name: "Lead", probability: 10, requires: [], lost: false }, { name: "Won", probability: 100, requires: ["amount"], lost: false }]);
  assert.equal(p[1].stages[1].lost, true);
});

test("one pipeline is sent as plain stages, several as a list", () => {
  const p = pipelinesOf(def);
  assert.deepEqual(pipelinesInput("deal", [p[0]]), { type: "deal", stages: [{ name: "Lead", probability: 10 }, { name: "Won", probability: 100, requires: ["amount"] }] });
  assert.deepEqual(pipelinesInput("deal", p).pipelines.map((x) => x.name), ["Sales", "Partners"]);
  assert.deepEqual(pipelinesOf({}).map((x) => x.name), ["Main"]);
});

test("a chance is a whole number from 0 to 100", () => {
  assert.equal(chanceOf("35%"), 35);
  assert.equal(chanceOf("250"), 100);
  assert.equal(chanceOf("-4"), 0);
  assert.equal(chanceOf(""), undefined);
  assert.equal(chanceOf("soon"), undefined);
});

test("editing stages and pipelines", () => {
  let p = pipelinesOf(def);
  p = patchStage(p, 0, 0, { probability: 20 });
  assert.equal(p[0].stages[0].probability, 20);
  p = moveStageIn(p, 0, 0, 1);
  assert.deepEqual(p[0].stages.map((s) => s.name), ["Won", "Lead"]);
  p = addStageIn(addStageIn(p, 0), 0);
  assert.deepEqual(p[0].stages.slice(2).map((s) => s.name), ["New stage", "New stage 2"]);
  p = removeStageIn(p, 0, 2);
  assert.equal(p[0].stages.length, 3);
  const q = addPipeline(pipelinesOf(def));
  assert.equal(q[2].name, "Pipeline 2");
  assert.deepEqual(q[2].stages.map((s) => s.name), ["Lead", "Won"]);
});

test("a stage's colour reads from the type and is set through type.update", () => {
  assert.equal(stageColour(def, "Lead"), "blue");
  assert.equal(stageColour(def, "Won"), undefined);
  assert.deepEqual(colourInput(def, "Won", "green"), { name: "deal", option_colors: { stage: { Won: "green" } } });
});
