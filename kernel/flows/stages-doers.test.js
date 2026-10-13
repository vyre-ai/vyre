// @ts-check
// Who a template's task is given to when a project enters a stage: a role, a person, an assistant, and the project's lead (the person in the Lead seat, else its owner). Each doer is made from the project it is for.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { snapshotOf, problems } from "../../lib/project-template.js";

const tpl = () => ({
  name: "Matter", noun: { one: "Matter", many: "Matters" }, roles: [{ role: "attorney" }],
  stages: [
    { name: "Opening", tasks: [
      { title: "Lead task", doer: "lead", output: { kind: "note" }, due_offset_ms: 2 * 86_400_000 },
      { title: "Role task", doer: "role:attorney", output: { kind: "note" } },
      { title: "Person task", doer: "person:per_bob", output: { kind: "note" } },
      { title: "Agent task", doer: "teammate:research", output: { kind: "draft" }, needs_yes: ["sending it out"] },
    ] },
    { name: "Done" },
  ],
});
const mk = () => world({ kernel: "real", cat: stagedCatalog() });
async function start(/** @type {any} */ w, /** @type {any} */ data = {}) {
  const k = w.kernel, sys = k.sysChain();
  const r = await k.records.create(sys, "project", { name: "Rivera", slug: `r-${Math.random().toString(36).slice(2, 7)}`, status: "active", template: "tpl_matter", template_version: "1", template_stage: "Opening", template_snapshot: snapshotOf(tpl(), { id: "tpl_matter", version: 1 }), ...data });
  await w.stages.enter({ urn: r.urn, type: "project", id: r.id, stage: "Opening", entry: "start" });
  await settle(w);
  return r;
}
const by = async (/** @type {any} */ w, /** @type {string} */ title) => (await w.kernel.allTasks()).find((/** @type {any} */ t) => t.title === title);

test("a template may give a task to the project's lead, and says so in words when it is wrong", () => {
  assert.deepEqual(problems(tpl()), []);
  const t = tpl(); t.stages[0].tasks[0].doer = "leader";
  assert.ok(problems(t).some((p) => /lead/.test(p.message) && p.path.endsWith("doer")));
});

const seat = (/** @type {any} */ w, /** @type {any} */ r, /** @type {string} */ person, /** @type {string} */ level, kind = "person") => w.kernel.records.create(w.kernel.sysChain(), "team-member", { name: person, actor: { actor: { kind: kind === "person" ? "person" : "agent", id: person, space: w.cat.space } }, kind: kind === "person" ? "person" : "assistant", level, project: { urn: r.urn } });
const startSeated = async (/** @type {any} */ w, /** @type {(r: any) => Promise<void>} */ seats, /** @type {any} */ data = {}) => {
  const k = w.kernel, sys = k.sysChain();
  const r = await k.records.create(sys, "project", { name: "Rivera", slug: `r-${Math.random().toString(36).slice(2, 7)}`, status: "active", template: "tpl_matter", template_version: "1", template_stage: "Opening", template_snapshot: snapshotOf(tpl(), { id: "tpl_matter", version: 1 }), ...data });
  await seats(r);
  await w.stages.enter({ urn: r.urn, type: "project", id: r.id, stage: "Opening", entry: "start" });
  await settle(w);
  return r;
};

test("the lead task goes to the person who holds the Lead seat on the project, not to a lead assistant; the other doer kinds are made too, and the due is the offset", async () => {
  const w = await mk();
  await startSeated(w, async (r) => { await seat(w, r, "per_bob", "lead"); await seat(w, r, "per_cy", "contributor"); await seat(w, r, "research", "lead", "assistant"); }, { lead: "research" });
  const lead = await by(w, "Lead task");
  assert.deepEqual([lead.doer.kind, lead.doer.id], ["person", "per_bob"]);
  assert.ok(lead.due > 0);
  assert.deepEqual([(await by(w, "Role task")).doer.id, (await by(w, "Person task")).doer.id, (await by(w, "Agent task")).doer.id], [ALEX.id, "per_bob", "research"]);
  assert.match((await by(w, "Agent task")).note, /sending it out/, "what needs a yes is in the brief");
});

test("with nobody in the Lead seat the lead task goes to the project's owner and says so; with neither it is reported, not lost", async () => {
  const w = await mk();
  await startSeated(w, async () => {}, { owner: { actor: { kind: "person", id: "per_bob", space: w.cat.space } } });
  assert.equal((await by(w, "Lead task")).doer.id, "per_bob");
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.notice" && /Lead seat/.test(e.data.why)), "the owner is told nobody holds the Lead seat");
  const w2 = await mk();
  await startSeated(w2, async () => {});
  assert.equal(await by(w2, "Lead task"), undefined);
  assert.ok(w2.stageEvents.some((/** @type {any} */ e) => e.type === "stage.error" && /Lead seat/.test(e.data.why)), "it says nobody holds the Lead seat");
  assert.ok(await by(w2, "Role task"), "the other tasks are still made");
});
