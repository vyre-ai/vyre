// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { specFor, shape } from "./stats.js";
import { DEAL } from "../../records/core-types.js";

test("a board's totals group by the stage and add up the amount and the weighted value", () => {
  const s = specFor(DEAL, {});
  assert.equal(s.group_by, "stage");
  assert.deepEqual(s.sum, ["amount", "weighted_value"]);
  assert.deepEqual(s.spec, { group_by: ["stage"], measures: [{ fn: "count" }, { fn: "sum", field: "amount" }, { fn: "sum", field: "weighted_value" }] });
  assert.deepEqual(specFor(DEAL, { sum: ["amount"], filter: { field: "pipeline", op: "eq", value: "Sales" } }).spec.filter, { field: "pipeline", op: "eq", value: "Sales" });
});

test("only a stage, choice or yes/no field groups, and only number fields add up", () => {
  assert.throws(() => specFor(DEAL, { group_by: "name" }), /not a stage, choice or yes\/no field/);
  assert.throws(() => specFor(DEAL, { sum: ["close_date"] }), /not a number field/);
  assert.throws(() => specFor({ label: "Note", fields: [{ name: "body", kind: "text" }] }, {}), /no stage field/);
  assert.deepEqual(specFor({ fields: [{ name: "kind", kind: "choice", options: ["a"] }] }, { group_by: "kind" }).sum, []);
});

test("every stage is listed in its own order, empty ones with zeros, and there is a grand total", () => {
  const rows = [
    { group: { stage: "Proposal" }, values: { count: 2, "sum:amount": 10000, "sum:weighted_value": 6000 } },
    { group: { stage: "Lead" }, values: { count: 1, "sum:amount": 4200, "sum:weighted_value": 420 } },
    { group: { stage: null }, values: { count: 1, "sum:amount": null, "sum:weighted_value": null } },
  ];
  const out = shape(DEAL, "stage", ["amount", "weighted_value"], rows);
  assert.deepEqual(out.groups.map((g) => g.key), ["Lead", "Qualified", "Proposal", "Won", "Lost", null]);
  assert.deepEqual(out.groups[1], { key: "Qualified", count: 0, amount: 0, weighted_value: 0 });
  assert.deepEqual(out.groups[2], { key: "Proposal", count: 2, amount: 10000, weighted_value: 6000 });
  assert.deepEqual(out.total, { count: 4, amount: 14200, weighted_value: 6420 });
});
