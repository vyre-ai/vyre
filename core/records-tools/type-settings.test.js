// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { applyTypeSettings, settingsOf, isColour } from "./type-settings.js";
import { pipelinesFrom, stagesFrom, stagesOfRecord } from "./pipeline.js";

const deal = { name: "deal", label: "Deal", fields: [{ name: "name", kind: "text" }, { name: "stage", kind: "stage", options: ["Lead", "Won"] }, { name: "source", kind: "choice", options: ["Web", "Referral"] }] };

test("a type is hidden from Records by its flag, not its name", () => {
  const t = applyTypeSettings({ name: "template", label: "Template", fields: [] }, { hidden_in_records: true });
  assert.equal(t.hidden_in_records, true);
  assert.equal(settingsOf(t).hidden_in_records, true);
  assert.equal("hidden_in_records" in applyTypeSettings(t, { hidden_in_records: false }), false, "false takes the flag off");
  assert.throws(() => applyTypeSettings(t, { hidden_in_records: "yes" }), /true or false/);
});

test("colours are names or hex, on the type and on the options of a choice or stage field", () => {
  assert.ok(isColour("blue") && isColour("#3b82f6") && !isColour("#fff") && !isColour("chartreuse"));
  const t = applyTypeSettings(deal, { color: "green", option_colors: { stage: { Won: "green", Lead: "#aabbcc" }, source: { Web: "blue" } } });
  assert.equal(t.color, "green");
  assert.deepEqual(t.option_colors, { stage: { Won: "green", Lead: "#aabbcc" }, source: { Web: "blue" } });
  assert.deepEqual(applyTypeSettings(t, { option_colors: { source: null } }).option_colors, { stage: { Won: "green", Lead: "#aabbcc" } });
  assert.throws(() => applyTypeSettings(deal, { option_colors: { name: { x: "blue" } } }), /not a choice or stage field/);
  assert.throws(() => applyTypeSettings(deal, { option_colors: { stage: { Nope: "blue" } } }), /not one of stage's options/);
  assert.throws(() => applyTypeSettings(deal, { option_colors: { stage: { Won: "mauve" } } }), /a colour is one of/);
  assert.throws(() => applyTypeSettings(deal, { color: "mauve" }), /A colour is one of/);
  assert.equal("color" in applyTypeSettings(t, { color: null }), false);
});

test("the name is 1 to 60 characters", () => {
  assert.equal(applyTypeSettings(deal, { label: " Sale " }).label, "Sale");
  assert.throws(() => applyTypeSettings(deal, { label: "  " }), /1 to 60/);
});

test("a stage keeps its chance, a number from 0 to 100", () => {
  const s = stagesFrom([{ name: "Lead", probability: 10 }, { name: "Won", probability: 100 }, { name: "Lost", probability: 0, lost: true }], new Set(["lost_reason"]));
  assert.deepEqual(s.map((x) => x.probability), [10, 100, 0]);
  assert.throws(() => stagesFrom([{ name: "A", probability: 101 }], new Set()), /0 to 100/);
  assert.throws(() => stagesFrom([{ name: "A", probability: "ten" }], new Set()), /0 to 100/);
  assert.deepEqual(stagesFrom([{ name: "A", probability: "" }], new Set()), [{ name: "A" }]);
});

test("several pipelines: the first is the default, the others are picked by the record's pipeline field", () => {
  const p = pipelinesFrom([{ name: "Sales", stages: [{ name: "Lead", probability: 10 }, { name: "Won", probability: 100 }] }, { name: "Partner", stages: [{ name: "Intro" }, { name: "Won", probability: 100 }] }], new Set());
  assert.deepEqual(p.names, ["Sales", "Partner"]);
  assert.deepEqual(p.options, ["Lead", "Won", "Intro"]);
  assert.equal(p.stage_sets.length, 1);
  assert.equal(p.stage_sets[0].when, 'pipeline == "Partner"');
  const t = { stages: p.stages, stage_sets: p.stage_sets };
  assert.deepEqual(stagesOfRecord(t, {}).map((s) => s.name), ["Lead", "Won"]);
  assert.deepEqual(stagesOfRecord(t, { pipeline: "Partner" }).map((s) => s.name), ["Intro", "Won"]);
  assert.throws(() => pipelinesFrom([], new Set()), /1 and 10/);
  assert.throws(() => pipelinesFrom([{ name: "A", stages: [{ name: "x" }] }, { name: "a", stages: [{ name: "y" }] }], new Set()), /Two pipelines/);
  assert.throws(() => pipelinesFrom([{ name: 'A"b', stages: [{ name: "x" }] }], new Set()), /without quotes/);
});
