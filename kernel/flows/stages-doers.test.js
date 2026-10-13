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
async function start(/** @type {any} */ w, /** @type {any} */ data = {}, /** @type {any} */ template = tpl()) {
  const k = w.kernel, sys = k.sysChain();
  const r = await k.records.create(sys, "project", { name: "Rivera", slug: `r-${Math.random().toString(36).slice(2, 7)}`, status: "active", template: "tpl_matter", template_version: "1", template_stage: "Opening", template_snapshot: snapshotOf(template, { id: "tpl_matter", version: 1 }), ...data });
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

test("a task's followers each get a note task of their own and the approver gets one; the main task gains no helper and carries neither box; a follower nobody can be is reported and the task is still made", async () => {
  const w = await mk();
  const t = tpl();
  t.stages[0].tasks = [{ title: "Watched", doer: "teammate:research", checker: "person:per_bob", followers: ["person:per_cy", "role:attorney", "role:nobody-holds-this"], notes: { approver: "Check the dates against [[field:this#due]].", followers: "Read along; do not edit." }, brief: "Do the work.", output: { kind: "note" } }];
  assert.deepEqual(problems(t), []);
  await start(w, {}, t);
  const all = await w.kernel.allTasks();
  const main = all.find((/** @type {any} */ x) => x.title === "Watched");
  assert.ok(main, "the task is made");
  assert.equal(main.helpers, undefined, "a follower is not a helper: it may not act on the task");
  assert.doesNotMatch(main.note, /Read along|Check the dates/, "neither box is on the doer's task");
  const follows = all.filter((/** @type {any} */ x) => x.title === "Following: Watched");
  assert.deepEqual(follows.map((/** @type {any} */ x) => x.doer.id).sort(), ["per_cy", ALEX.id].sort(), "one note task per follower who can be one");
  assert.ok(follows.every((/** @type {any} */ x) => x.output.kind === "note" && /Read along; do not edit\./.test(x.note) && /Task: Watched/.test(x.note)), "each carries the followers' box and what the task is");
  const check = all.find((/** @type {any} */ x) => x.title === "To check: Watched");
  assert.equal(check.doer.id, "per_bob", "the approver gets a note task");
  assert.match(check.note, /Check the dates against/);
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.notice" && /nobody-holds-this/.test(e.data.why)), "the follower nobody can be is said");
});

test("the shape of followers and notes: actor strings, and plain text of at most 4000 characters", () => {
  const bad = (/** @type {(k: any) => void} */ f, /** @type {RegExp} */ re, /** @type {string} */ at) => { const t = tpl(); f(t.stages[0].tasks[0]); assert.ok(problems(t).some((p) => re.test(p.message) && p.path.endsWith(at)), JSON.stringify(problems(t))); };
  bad((k) => { k.followers = "person:x"; }, /followers are a list/, "followers");
  bad((k) => { k.followers = ["somebody"]; }, /followers are a list/, "followers");
  bad((k) => { k.followers = Array.from({ length: 21 }, (_, i) => `person:p${i}`); }, /at most 20/, "followers");
  bad((k) => { k.notes = { approver: 5 }; }, /notes is/, "notes");
  bad((k) => { k.notes = { other: "x" }; }, /notes is/, "notes");
  bad((k) => { k.notes = { followers: "x".repeat(4001) }; }, /at most 4000/, "notes");
});
