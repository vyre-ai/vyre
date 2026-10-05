import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createRecordsHost } from "../host.js";
import fs from "node:fs";
const BASE = JSON.parse(fs.readFileSync(new URL("./base/kit.json", import.meta.url), "utf8"));

const SPACE = "spc_baseobjects1";
async function rig() {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  await host.installKit(BASE);
  const R = host.kernel.records, o = host.ownerChain();
  return { host, R, o };
}

test("the base Kit installs on a Space and the types are there with their views stored", async () => {
  const { host } = await rig();
  const types = new Map(Object.entries(host.catalog().types));
  for (const n of ["contact", "lead", "appointment", "client", "subscriber", "project"]) assert.ok(types.has(n), n);
  assert.equal(types.get("project").views[0].groupBy, "stage");
  assert.equal(types.get("project").kind, "project");
});

test("one Contact, many roles: a person who is a Lead and then a Client is still one Contact", async () => {
  const { R, o } = await rig();
  const c = await R.create(o, "contact", { name: "Jordan Reyes", email: "jordan@example.com" });
  const lead = await R.create(o, "lead", { contact: { urn: c.urn }, practice_area: "Estate Planning", stage: "New" });
  const client = await R.create(o, "client", { contact: { urn: c.urn }, practice_area: "Estate Planning", stage: "Onboarding" });
  const roles = await R.roles(o, c.urn);
  assert.deepEqual(roles.map((r) => r.role).sort(), ["client", "lead"]);
  assert.ok(lead.urn && client.urn);
  await assert.rejects(() => R.create(o, "lead", { practice_area: "Estate Planning" }), "a lead without a contact is refused");
});

test("a Project follows the stages of its practice area, and the fields that apply only there are required only there", async () => {
  const { R, o } = await rig();
  const c = await R.create(o, "contact", { name: "Casey Lin" });
  // the core Project's client is the Contact (one Contact per person; Client is a role type linked to it), and its name is `name`
  const base = { client: { urn: c.urn } };
  await assert.rejects(() => R.create(o, "project", { ...base, name: "Lin v. Acme", practice_area: "Personal Injury" }), { code: "field_required" });
  await assert.rejects(() => R.create(o, "project", { ...base, name: "Lin trust", practice_area: "Estate Planning", accident_date: "2026-01-01" }), { code: "field_not_shown" });
  const pi = await R.create(o, "project", { ...base, name: "Lin v. Acme", practice_area: "Personal Injury", accident_date: "2026-01-01", stage: "Intake" });
  await assert.rejects(() => R.update(o, "project", pi.id, { stage: "Drafting" }, pi.version), { code: "stage_not_in_set" });
  const treating = await R.update(o, "project", pi.id, { stage: "Treating" }, pi.version);
  assert.equal(treating.data.stage, "Treating");
  const ep = await R.create(o, "project", { ...base, name: "Lin trust", practice_area: "Estate Planning", stage: "Review" });
  await assert.rejects(() => R.update(o, "project", ep.id, { stage: "Signing" }, ep.version), { code: "stage_entry_refused" });
  const signing = await R.update(o, "project", ep.id, { stage: "Signing", trust_name: "Lin Family Trust" }, ep.version);
  assert.equal(signing.data.stage, "Signing");
  const other = await R.create(o, "project", { ...base, name: "Misc", practice_area: "Business", stage: "Active" });
  assert.equal(other.data.stage, "Active", "an area with no stage set follows the default stages");
});
