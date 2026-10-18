// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { roleLabel, labelled, lineOf, countsOf, startStage } from "./roles.js";
import { ROLE_TYPES, CORE_TYPES } from "../../records/core-types.js";

const lead = ROLE_TYPES.find((t) => t.name === "role-lead");

test("the day-one roles: people are Lead, Client, Partner, Vendor, Teammate; companies are Customer, Vendor, Partner", () => {
  assert.deepEqual(ROLE_TYPES.map((t) => roleLabel(t)), ["Lead", "Client", "Partner", "Vendor", "Teammate", "Customer", "Vendor", "Partner"]);
  assert.equal(new Set(ROLE_TYPES.map((t) => t.label.toLowerCase())).size, ROLE_TYPES.length, "labels are unique, or a person's define is refused");
  for (const t of ROLE_TYPES) {
    const holder = t.fields.find((f) => f.name === t.role.link);
    assert.ok(holder && holder.kind === "link" && (holder.to === "contact" || holder.to === "organization") && holder.required === true, t.name);
    assert.ok(CORE_TYPES.some((c) => c.name === t.name), `${t.name} is a core type`);
    assert.ok(t.name.startsWith("role-"), "a Kit's own lead stays its own");
  }
  assert.deepEqual(lead.role.ended, ["Won", "Lost"]);
  const stageField = lead.fields.find((f) => f.kind === "stage");
  assert.deepEqual(stageField.options, ["New", "Talking", "Won", "Lost"]);
  for (const e of lead.role.ended) assert.ok(stageField.options.includes(e));
});

test("a role is a label with its stage and colour; a stage colour wins over the type's", () => {
  const row = { id: "r1", urn: "vyre://s/role-lead/r1", data: { since: "2026-10-01" } };
  const t = { ...lead, option_colors: { stage: { New: "blue" } } };
  assert.deepEqual(labelled(t, { role: "role-lead", stage: "New", current: true, record: row }), { role: "role-lead", label: "Lead", stage: "New", current: true, color: "blue", id: "r1", urn: row.urn, since: "2026-10-01" });
  assert.equal(labelled(lead, { role: "role-lead", stage: "Talking", current: true, record: row }).color, "orange");
  assert.equal(labelled(ROLE_TYPES[2], { role: "role-partner", current: true, record: row }).stage, undefined);
});

test("the list line names current roles with their stage, and leaves ended ones out", () => {
  assert.equal(lineOf([{ label: "Lead", stage: "New", current: true }, { label: "Client", stage: "Active", current: true }, { label: "Vendor", current: true }, { label: "Lead", stage: "Lost", current: false }]), "Lead (New), Client (Active), Vendor");
  assert.equal(lineOf([]), "");
});

test("a role starts in its first stage, or the one asked for", () => {
  assert.equal(startStage(lead, undefined), "New");
  assert.equal(startStage(lead, "Talking"), "Talking");
  assert.throws(() => startStage(lead, "Nope"), /no stage called Nope/);
  assert.equal(startStage(ROLE_TYPES[2], undefined), undefined);
  assert.throws(() => startStage(ROLE_TYPES[2], "New"), /has no stages/);
});

test("counts by stage cover current holders; ended ones are counted apart", () => {
  assert.deepEqual(countsOf([{ stage: "New", current: true }, { stage: "New", current: true }, { stage: "Talking", current: true }, { stage: "Lost", current: false }]), { current: 3, ended: 1, by_stage: { New: 2, Talking: 1 } });
  assert.deepEqual(countsOf([]), { current: 0, ended: 0, by_stage: {} });
});
