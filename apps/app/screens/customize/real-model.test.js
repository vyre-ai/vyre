// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addField, sealField } from "./logic.js";
import { diffFor, isOwn, toKernelType, toTypeDef } from "./real-model.js";

const matter = { name: "matter", label: "Matter", fields: [{ name: "title", label: "Title", kind: "text", required: true }, { name: "stage", label: "Stage", kind: "stage", options: ["Intake", "Closed"] }, { name: "ssn", label: "SSN", kind: "sealed", seal: { level: "ai", class: "free" } }],
  stages: [{ name: "Intake", tasks: [{ title: "Collect", doer: "juno", output: { kind: "note" } }] }, { name: "Closed" }] };

test("a kernel type reads as the screen's type", () => {
  const t = toTypeDef(matter, "juniper");
  assert.equal(t.id, "matter");
  assert.equal(t.work, true);
  assert.deepEqual(t.stages, ["Intake", "Closed"]);
  assert.equal(t.fields.find((f) => f.key === "ssn")?.sealed, true);
  assert.equal(t.fields.find((f) => f.key === "title")?.sealed, undefined);
});

test("adding a field is one change_types diff that keeps what the screen does not show", () => {
  const t = addField(toTypeDef(matter, "juniper"), "Plan year", "text");
  const d = /** @type {any} */ (diffFor(t, matter));
  const next = d.change_types[0];
  assert.deepEqual(next.fields.map((/** @type {any} */ f) => f.name), ["title", "stage", "ssn", "plan_year"]);
  assert.equal(next.stages[0].tasks[0].title, "Collect");
  assert.deepEqual(next.fields.find((/** @type {any} */ f) => f.name === "plan_year"), { name: "plan_year", label: "Plan year", kind: "text" });
});

test("sealing a field adds a seal config, and unsealing removes it", () => {
  const sealed = /** @type {any} */ (toKernelType(sealField(toTypeDef(matter, "h"), "title", true), matter));
  assert.deepEqual(sealed.fields.find((/** @type {any} */ f) => f.name === "title").seal, { level: "ai", class: "free" });
  const back = /** @type {any} */ (toKernelType(sealField(toTypeDef(sealed, "h"), "title", false), sealed));
  assert.equal(back.fields.find((/** @type {any} */ f) => f.name === "title").seal, undefined);
});

test("a new type is an add_types diff, and the kernel's own types are not shown", () => {
  const d = /** @type {any} */ (diffFor({ id: "trip", label: "Trip", plural: "Trips", spaces: ["h"], work: false, fields: [{ key: "title", label: "Title", kind: "text" }], stages: [] }, undefined));
  assert.equal(d.add_types[0].name, "trip");
  assert.ok(isOwn({ name: "matter" }) && !isOwn({ name: "def-flow" }) && !isOwn({ name: "flow-run" }) && !isOwn({ name: "goal" }));
});
