import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planType } from "./plan.js";
import { filterPlan, viewId, viewsPlan } from "./views.js";

const DEF = {
  name: "matter", label: "Matter",
  fields: [
    { name: "title", kind: "text", label: "Title" },
    { name: "area", kind: "choice", label: "Area", options: ["Personal Injury", "Estate Planning"] },
    { name: "fee", kind: "number", label: "Fee" },
    { name: "due", kind: "date", label: "Due" },
    { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Closed"] },
    { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } },
  ],
  views: [
    { name: "all", type: "list", label: "All", columns: ["area", "fee"], sort: { field: "fee", dir: "desc" }, filter: 'area == "Personal Injury" and fee >= 100' },
    { name: "board", type: "board", groupBy: "stage", columns: ["title"], filter: "len(title) > 3" },
    { name: "cal", type: "calendar", dateField: "due" },
    { name: "dash", type: "dashboard" },
  ],
};
const p = planType(DEF);

test("a filter Expression of fields, literals, and/or and empty() becomes the Records' filters; anything else is null", () => {
  assert.deepEqual(filterPlan('area == "Personal Injury" and fee >= 100', p), { op: "AND", filters: [{ field: "area", operand: "IS", value: '["PERSONAL_INJURY"]' }, { field: "fee", operand: "GREATER_THAN_OR_EQUAL", value: "100" }] });
  assert.deepEqual(filterPlan('stage == "A" or stage == "B"', p).op, "OR");
  assert.deepEqual(filterPlan("not empty(due)", p), { op: "AND", filters: [{ field: "due", operand: "IS_NOT_EMPTY", value: "" }] });
  assert.equal(filterPlan("due < 5", p).filters[0].operand, "IS_BEFORE");
  assert.equal(filterPlan("100 <= fee", p).filters[0].operand, "GREATER_THAN_OR_EQUAL", "a literal on the left is turned round");
  for (const src of ["len(title) > 3", "fee > 1", "ssn == 1", 'area == "a" and (fee >= 1 or fee <= 0)', "nope == 1", "("]) assert.equal(filterPlan(src, p), null, src);
});

test("the plan has one entry per view the Records can hold, with deterministic ids", () => {
  const plan = viewsPlan(p, "spc_a");
  assert.deepEqual(plan.map((v) => [v.name, v.view.type]), [["all", "TABLE"], ["board", "KANBAN"], ["cal", "CALENDAR"]], "a dashboard has no Records form");
  assert.equal(plan[0].id, viewId("spc_a", "matter", "all"));
  assert.notEqual(viewId("spc_a", "matter", "all"), viewId("spc_b", "matter", "all"));
  assert.match(plan[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(plan[0].fields, [{ field: "area", position: 0 }, { field: "fee", position: 1 }]);
  assert.deepEqual(plan[0].sort, { field: "fee", direction: "DESC" });
  assert.equal(plan[0].filterKept, false);
  assert.equal(plan[1].view.mainGroupByFieldMetadataIdOf, "stage");
  assert.equal(plan[1].filterKept, true, "len(...) stays in the definition only");
  assert.equal(plan[2].view.calendarFieldMetadataIdOf, "due");
});
