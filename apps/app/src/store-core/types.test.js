// @ts-check
// The five sample types (deck/ui/types.js) and their view definitions (deck/ui/view-defs.js) are data a view can draw: the kernel's TypeDefinition, with the stages in
// the stage field's options and the Kit's task templates under each stage name. Replaces the types check the old DOM views test held.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { FIELD_KINDS } from "../../../../kernel/contracts/index.js";
import { types, typeByName, MATTER_STAGES, ESTATE_KIT_TASKS } from "./types.js";
import { viewDefOf } from "./view-defs.js";

test("types: the five sample types, and Matter has the stages the prototype has", () => {
  assert.deepEqual(types.map(t => t.name), ["contact", "matter", "project", "trip", "template"]);
  assert.deepEqual(typeByName("matter")?.fields.find(f => f.kind === "stage")?.options, MATTER_STAGES);
  assert.deepEqual(MATTER_STAGES, ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]);
  assert.ok(typeByName("contact")?.fields.some(f => f.kind === "sealed" && f.seal), "a contact has sealed fields, and a sealed field says how");
  for (const t of types) for (const f of t.fields) assert.ok(/** @type {readonly string[]} */ (FIELD_KINDS).includes(f.kind), `${t.name}.${f.name} is a kernel kind`);
});

test("types: every view definition names fields its type has", () => {
  for (const t of types) {
    const vd = viewDefOf(t), has = (/** @type {string} */ n) => t.fields.some(f => f.name === n);
    assert.ok(has(vd.titleField), `${t.name} has its title field`);
    for (const k of vd.list?.columns || []) assert.ok(has(k), `${t.name} list column ${k} exists`);
    if (vd.board) assert.ok(has(vd.board.groupBy), `${t.name} board field`);
    if (vd.calendar) assert.ok(has(vd.calendar.date), `${t.name} calendar field`);
  }
});

test("types: the Kit's tasks sit under stages of Matter, and each depends only on a task of its own stage", () => {
  for (const [stage, tpls] of Object.entries(ESTATE_KIT_TASKS)) {
    assert.ok(MATTER_STAGES.includes(stage), `${stage} is a Matter stage`);
    const titles = new Set(tpls.map(t => t.title));
    for (const t of tpls) for (const d of t.depends_on || []) assert.ok(titles.has(d), `${t.title} depends on ${d}, in ${stage}`);
  }
});
