import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { actsAsKernel } from "./records.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const key = Buffer.alloc(32, 7);
const boot = async () => bootKernel({ db: new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-objects-")), "kernel.db")), space: SPACE, owner: OWNER, owner_uid: 501, key });
const ownerChain = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });

const PI = "Personal Injury", EP = "Estate Planning";
const MATTER = {
  name: "matter", label: "Matter", kind: "project",
  fields: [
    { name: "title", kind: "text", label: "Title", required: true },
    { name: "area", kind: "choice", label: "Practice area", options: [PI, EP] },
    { name: "accident_date", kind: "date", label: "Accident date", visible_if: `area == "${PI}"`, required_if: `area == "${PI}"` },
    { name: "trust_name", kind: "text", label: "Trust name", visible_if: `area == "${EP}"` },
    { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Treating", "Demand", "Settled", "Drafting", "Signed"] },
  ],
  stages: [{ name: "Intake" }, { name: "Signed", enter_if: "not empty(area)" }],
  stage_sets: [
    { name: "pi", when: `area == "${PI}"`, stages: [{ name: "Intake" }, { name: "Treating" }, { name: "Demand", enter_if: "not empty(accident_date)" }, { name: "Settled" }] },
    { name: "ep", when: `area == "${EP}"`, stages: [{ name: "Intake" }, { name: "Drafting" }, { name: "Signed", enter_if: "not empty(trust_name)" }] },
  ],
  views: [
    { name: "board", type: "board", groupBy: "stage", columns: ["title", "area"] },
    { name: "pi_only", type: "list", columns: ["title", "accident_date"], filter: `area == "${PI}"`, sort: { field: "title", dir: "desc" } },
  ],
};

async function rig() { const k = await boot(), o = ownerChain(k); await k.gateway.records.define(o, { add_types: [MATTER] }); return { k, o, R: k.gateway.records }; }

test("required_if: a Personal Injury matter needs its accident date, an Estate Planning one does not", async () => {
  const { o, R } = await rig();
  await assert.rejects(() => R.create(o, "matter", { title: "Harlow", area: PI }), { code: "field_required" });
  const ok = await R.create(o, "matter", { title: "Harlow", area: PI, accident_date: "2026-03-01" });
  assert.equal(ok.data.accident_date, "2026-03-01");
  assert.ok(await R.create(o, "matter", { title: "Trust", area: EP }), "no accident date for an estate plan");
  assert.ok(await R.create(o, "matter", { title: "No area yet" }), "no area: neither condition holds");
});

test("required_if on update: judged on the record as it would be, and only where the write touches the condition", async () => {
  const { o, R } = await rig();
  const m = await R.create(o, "matter", { title: "Open" });
  await assert.rejects(() => R.update(o, "matter", m.id, { area: PI }, m.version), { code: "field_required" }, "changing the area to PI without the date");
  const up = await R.update(o, "matter", m.id, { area: PI, accident_date: "2026-01-02" }, m.version);
  await assert.rejects(() => R.update(o, "matter", m.id, { accident_date: null }, up.version), { code: "field_required" }, "clearing a required value");
  assert.ok(await R.update(o, "matter", m.id, { title: "Renamed" }, up.version), "an unrelated change is fine");
});

test("visible_if: a value cannot be written to a field that is not shown for the record; the kept value stays", async () => {
  const { o, R } = await rig();
  await assert.rejects(() => R.create(o, "matter", { title: "T", area: EP, accident_date: "2026-01-01" }), { code: "field_not_shown" });
  await assert.rejects(() => R.create(o, "matter", { title: "T", trust_name: "Smith Trust" }), { code: "field_not_shown" }, "no area, not shown");
  const m = await R.create(o, "matter", { title: "T", area: EP, trust_name: "Smith Trust" });
  const moved = await R.update(o, "matter", m.id, { area: PI, accident_date: "2026-02-02" }, m.version);
  assert.equal(moved.data.trust_name, "Smith Trust", "the hidden value is kept, not erased");
  assert.ok(await R.update(o, "matter", m.id, { trust_name: null }, moved.version), "clearing a hidden field is allowed");
});

test("stage sets: each practice area follows its own stages; a stage of another set is refused", async () => {
  const { o, R } = await rig();
  const pi = await R.create(o, "matter", { title: "PI", area: PI, accident_date: "2026-03-01", stage: "Intake" });
  await assert.rejects(() => R.update(o, "matter", pi.id, { stage: "Drafting" }, pi.version), { code: "stage_not_in_set" });
  const t = await R.update(o, "matter", pi.id, { stage: "Treating" }, pi.version);
  assert.equal(t.data.stage, "Treating");
  const ep = await R.create(o, "matter", { title: "EP", area: EP, stage: "Intake" });
  await assert.rejects(() => R.update(o, "matter", ep.id, { stage: "Treating" }, ep.version), { code: "stage_not_in_set" });
  assert.equal((await R.update(o, "matter", ep.id, { stage: "Drafting" }, ep.version)).data.stage, "Drafting");
  const none = await R.create(o, "matter", { title: "Default", stage: "Intake" });
  await assert.rejects(() => R.update(o, "matter", none.id, { stage: "Treating" }, none.version), { code: "stage_not_in_set" }, "no area: the default stages");
});

test("stage sets: changing the area while the stage is not in the new set is refused", async () => {
  const { o, R } = await rig();
  const pi = await R.create(o, "matter", { title: "PI", area: PI, accident_date: "2026-03-01", stage: "Treating" });
  await assert.rejects(() => R.update(o, "matter", pi.id, { area: EP }, pi.version), { code: "stage_not_in_set" });
  const ok = await R.update(o, "matter", pi.id, { area: EP, stage: "Drafting" }, pi.version);
  assert.equal(ok.data.stage, "Drafting");
});

test("enter_if: a stage is entered only while its condition holds for the record as it would be", async () => {
  const { o, R } = await rig();
  const ep = await R.create(o, "matter", { title: "EP", area: EP, stage: "Drafting" });
  await assert.rejects(() => R.update(o, "matter", ep.id, { stage: "Signed" }, ep.version), { code: "stage_entry_refused" });
  const signed = await R.update(o, "matter", ep.id, { stage: "Signed", trust_name: "The Smith Trust" }, ep.version);
  assert.equal(signed.data.stage, "Signed", "the same write supplies what the condition needs");
  const none = await R.create(o, "matter", { title: "Default", stage: "Intake" });
  await assert.rejects(() => R.update(o, "matter", none.id, { stage: "Signed" }, none.version), { code: "stage_entry_refused" }, "the default Signed needs an area");
});

test("define refuses a conditional field, stage set, entry condition or view that does not hold together", async () => {
  const k = await boot(), o = ownerChain(k), R = k.gateway.records;
  const t = (patch, f = {}) => ({ ...MATTER, name: "x", ...patch, fields: MATTER.fields.map(x => x.name === "accident_date" ? { ...x, ...f } : x) });
  const refused = async (type, re) => assert.rejects(() => R.define(o, { add_types: [type] }), (e) => e.code === "bad_input" && re.test(e.message));
  await refused(t({}, { visible_if: "nope == 1" }), /not a field of x/);
  await refused(t({}, { visible_if: "accident_date == 1" }), /cannot name accident_date/);
  await refused(t({}, { required: true }), /required or required_if/);
  await refused(t({ stage_sets: [{ name: "a", when: 'stage == "Intake"', stages: [{ name: "Intake" }] }] }), /cannot name stage/);
  await refused(t({ stages: [{ name: "Intake" }, { name: "Signed", enter_if: "(" }] }), /enter_if/);
  await refused(t({ views: [{ name: "b", type: "board", groupBy: "title" }] }), /groupBy is a stage or choice/);
  await refused(t({ views: [{ name: "c", type: "calendar", dateField: "title" }] }), /dateField/);
  await refused(t({ views: [{ name: "l", type: "list", columns: ["nope"] }] }), /columns are fields/);
  await refused(t({ views: [{ name: "l", type: "list", filter: "nope == 1" }] }), /not a field of x/);
  await refused(t({ views: [{ name: "l", type: "list", extra: 1 }] }), /unknown key extra/);
  await refused({ ...MATTER, name: "y", fields: MATTER.fields.map(x => x.kind === "stage" ? { ...x, options: ["Intake"] } : x) }, /must include every stage/);
  await R.define(o, { add_types: [MATTER] });
  const stored = (await k.store.types()).find((x) => x.name === "matter");
  assert.equal(stored.views.length, 2, "the views are stored with the type");
  assert.equal(stored.stage_sets.length, 2);
  assert.equal(stored.fields.find((f) => f.name === "accident_date").required_if, `area == "${PI}"`);
});

test("a type needs its own name and label: a second type with the same label is refused, and an add that would drop an existing type's fields is a change", async () => {
  const { o, R } = await rig();
  const dup = (name, label, fields = MATTER.fields) => ({ name, label, fields });
  await assert.rejects(() => R.define(o, { add_types: [dup("matter_2", "Matter")] }), (e) => e.code === "type_exists" && /There is already a type called Matter/.test(e.message));
  await assert.rejects(() => R.define(o, { add_types: [dup("matter_3", "  matter ")] }), { code: "type_exists" }, "case and spaces do not make it another label");
  await assert.rejects(() => R.define(o, { add_types: [dup("matter", "Matter", [MATTER.fields[0]])] }), { code: "type_exists" }, "same name, fewer fields");
  await assert.rejects(() => R.define(o, { add_types: [dup("a1", "Alpha", [MATTER.fields[0]]), dup("a2", "alpha", [MATTER.fields[0]])] }), { code: "type_exists" }, "two new types with one label");
  assert.equal((await R.define(o, { add_types: [{ ...MATTER }] })).applied, false, "the same definition again changes nothing");
  assert.equal((await R.define(o, { add_types: [dup("alpha", "Alpha", [MATTER.fields[0]])] })).applied, true, "another label is a new type");
});

test("a field owned by the kernel is written only by the kernel's own service", async () => {
  const k = await boot(), o = ownerChain(k), R = k.gateway.records;
  await R.define(o, { add_types: [{ name: "job", label: "Job", fields: [{ name: "title", kind: "text", label: "Title", required: true }, { name: "status", kind: "choice", label: "Status", options: ["ready", "done"], owned_by: "kernel" }] }] });
  const j = await R.create(o, "job", { title: "Call Sam" });
  await assert.rejects(() => R.update(o, "job", j.id, { status: "done" }, j.version), { code: "field_not_allowed" });
  await assert.rejects(() => R.create(o, "job", { title: "x", status: "ready" }), { code: "field_not_allowed" });
  assert.equal((await R.update(o, "job", j.id, { title: "Call Sam back" }, j.version)).data.title, "Call Sam back", "the rest of the record is the person's");
  // a change to the type cannot take the ownership away, nor drop the field
  const job = { name: "job", label: "Job", fields: [{ name: "title", kind: "text", label: "Title", required: true }, { name: "status", kind: "choice", label: "Status", options: ["ready", "done"] }] };
  await assert.rejects(() => R.define(o, { change_types: [job] }), (e) => e.code === "bad_input" && /kept by the kernel/.test(e.message));
  await assert.rejects(() => R.define(o, { change_types: [{ ...job, fields: [job.fields[0]] }] }), { code: "bad_input" });
  // only the acting (last) hop counts: the kernel's own service may write a kernel-owned field, a chain with the kernel earlier and anyone acting after it may not
  const kernelChain = k.chains.appendService(o, "kernel", true), after = k.chains.appendService(kernelChain, "someone", true);
  assert.equal(actsAsKernel(kernelChain), true);
  assert.equal(actsAsKernel(after), false);
  assert.equal(actsAsKernel(o), false);
  assert.equal(actsAsKernel(undefined), false);
  await assert.rejects(() => R.define(o, { add_types: [{ name: "bad", label: "Bad", fields: [{ name: "x", kind: "text", label: "X", owned_by: "me" }] }] }), { code: "bad_input" });
});

test("a time_zone field holds an IANA zone and nothing else", async () => {
  const k = await boot(), o = ownerChain(k), R = k.gateway.records;
  await R.define(o, { add_types: [{ name: "person_x", label: "Person x", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "time_zone", kind: "text", label: "Time zone", format: "time_zone" }] }] });
  assert.equal((await R.create(o, "person_x", { name: "Sam", time_zone: "America/Los_Angeles" })).data.time_zone, "America/Los_Angeles");
  assert.ok(await R.create(o, "person_x", { name: "No zone" }));
  for (const bad of ["Pacific", "not/a/zone", "", "America/"]) await assert.rejects(() => R.create(o, "person_x", { name: "x", time_zone: bad }), (e) => /time zone/.test(e.message) || e.code === "bad_input", bad);
  await assert.rejects(() => R.define(o, { add_types: [{ name: "bad_f", label: "Bad f", fields: [{ name: "x", kind: "text", label: "X", format: "nope" }] }] }), { code: "bad_input" });
});
