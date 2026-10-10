// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { templateStage } from "./template-stage.js";

const snapshot = JSON.stringify({ template: "estate-plan", version: 1, name: "Estate plan", stages: [{ name: "Intake" }, { name: "Drafting" }, { name: "Signing" }] });

test("a template project says which stages it follows and which it is in", () => {
  assert.deepEqual(templateStage({ template_snapshot: snapshot, template_stage: "Drafting" }), { stages: ["Intake", "Drafting", "Signing"], at: 1 });
  assert.deepEqual(templateStage({ template_snapshot: snapshot, template_stage: "Gone" }), { stages: ["Intake", "Drafting", "Signing"], at: -1 }, "a stage the template no longer has is shown as none");
});

test("a project that is not from a template, or has a broken snapshot, is not one", () => {
  assert.equal(templateStage({ name: "Plain" }), null);
  assert.equal(templateStage({ template_snapshot: "not json" }), null);
  assert.equal(templateStage({ template_snapshot: JSON.stringify({ stages: [] }) }), null);
  assert.equal(templateStage(undefined), null);
});
