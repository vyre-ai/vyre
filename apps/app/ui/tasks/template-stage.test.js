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

test("the New menu never says the same thing twice: a record type whose label a template already offers is left out", async () => {
  const { newMenuItems } = await import("./template-stage.js");
  const types = [{ name: "matter", label: "Matter" }, { name: "trip", label: "Trip" }, { name: "project", label: "Project" }];
  const choices = [{ label: "New matter", key: "tpl_estate" }, { label: "New blank project", key: null }];
  assert.deepEqual(newMenuItems(types, choices).map((x) => x.label), ["New matter", "New blank project", "New trip"]);
  assert.deepEqual(newMenuItems(types, undefined).map((x) => x.label), ["New matter", "New trip", "New project"]);
});
