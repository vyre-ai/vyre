import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createRecordsHost } from "../host.js";
import fs from "node:fs";
import { CORE_TYPES } from "../core-types.js";
const BASE = JSON.parse(fs.readFileSync(new URL("./base/kit.json", import.meta.url), "utf8"));
const LAW = JSON.parse(fs.readFileSync(new URL("./law-firm/kit.json", import.meta.url), "utf8"));

const SPACE = "spc_baseobjects1";
async function rig(law = false) {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  await host.installKit(BASE);
  if (law) await host.installKit(LAW);
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
  const lead = await R.create(o, "lead", { contact: { urn: c.urn }, stage: "New" });
  const client = await R.create(o, "client", { contact: { urn: c.urn }, stage: "Onboarding" });
  const roles = await R.roles(o, c.urn);
  assert.deepEqual(roles.map((r) => r.role).sort(), ["client", "lead"]);
  assert.ok(lead.urn && client.urn);
  await assert.rejects(() => R.create(o, "lead", { stage: "New" }), "a lead without a contact is refused");
});

test("the Law firm Kit: a Project follows the stages of its practice area, and the fields that apply only there are required only there", async () => {
  const { R, o } = await rig(true);
  const c = await R.create(o, "contact", { name: "Casey Lin" });
  const client = await R.create(o, "client", { contact: { urn: c.urn }, practice_area: "Personal Injury", stage: "Active" });
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

test("the base Project is generic: the same stages for every project", async () => {
  const { R, o } = await rig();
  const c = await R.create(o, "contact", { name: "Casey Lin" });
  const p = await R.create(o, "project", { client: { urn: c.urn }, name: "Website rebuild", stage: "New" });
  assert.equal((await R.update(o, "project", p.id, { stage: "Active" }, p.version)).data.stage, "Active");
  await assert.rejects(() => R.update(o, "project", p.id, { stage: "Treating" }, p.version + 1), "a stage of the Law firm Kit is not the base's");
});

test("no legal words anywhere in the base Kit: its source, its stored form, its labels, stages, options and descriptions", () => {
  const WORDS = /practice|attorney|lawyer|\blaw\b|legal|\bcourt|\bcase\b|\bmatter|trust|estate|injury|accident|hearing|consult|retainer|litigation|plaintiff|settle|demand|signing|immigration|criminal|family|probate|counsel|intake/i;
  for (const file of ["kit.ts", "kit.json"]) {
    const text = fs.readFileSync(new URL(`./base/${file}`, import.meta.url), "utf8");
    const hits = text.split(/\r?\n/).flatMap((l) => (l.match(new RegExp(WORDS, "gi")) || []).map((w) => `${file}: ${w} in ${l.trim().slice(0, 80)}`));
    assert.deepEqual(hits, [], "legal words in the base Kit");
  }
  for (const t of BASE.types) assert.equal(t.fields.some((f) => f.name === "practice_area"), false, `${t.name} has no practice area`);
});

test("no legal words in the core types either: their names, labels, options and descriptions", () => {
  const WORDS = /practice|attorney|lawyer|\blaw\b|legal|\bcourt|\bcase\b|\bmatter|trust|estate|injury|accident|hearing|consult|retainer|litigation|plaintiff|settle|demand|signing|immigration|criminal|family|probate|counsel/i;
  assert.equal(WORDS.test(JSON.stringify(CORE_TYPES)), false, "legal words in the core types");
});
