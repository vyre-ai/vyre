// @ts-check
// Who a template's task is given to when a project enters a stage: a role, a person, an assistant, and the project's lead (the person in the Lead seat, else its owner). Each doer is made from the project it is for.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { snapshotOf, problems } from "../../lib/project-template.js";
import { createStages } from "./stages.js";

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
  t.stages[0].tasks = [{ title: "Watched", doer: "teammate:research", checker: "person:per_bob", followers: ["person:per_bob", "role:attorney", "role:nobody-holds-this"], notes: { approver: "Check the dates against [[field:this#due]].", followers: "Read along; do not edit." }, brief: "Do the work.", output: { kind: "note" } }];
  assert.deepEqual(problems(t), []);
  await start(w, {}, t);
  const all = await w.kernel.allTasks();
  const main = all.find((/** @type {any} */ x) => x.title === "Watched");
  assert.ok(main, "the task is made");
  assert.equal(main.helpers, undefined, "a follower is not a helper: it may not act on the task");
  assert.doesNotMatch(main.note, /Read along|Check the dates/, "neither box is on the doer's task");
  const follows = all.filter((/** @type {any} */ x) => x.title === "Following: Watched");
  assert.deepEqual(follows.map((/** @type {any} */ x) => x.doer.id).sort(), ["per_bob", ALEX.id].sort(), "one note task per follower who can be one");
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

test("a follower's note task gives her no read on the project or on the doer's task: what she can read is the same whether or not she follows", async () => {
  const can = async (/** @type {() => Promise<any>} */ f) => { try { await f(); return true; } catch { return false; } };
  const readsOf = async (/** @type {boolean} */ follows) => {
    const w = await mk();
    const t = tpl();
    t.stages[0].tasks = [{ title: "Quiet", doer: "teammate:research", ...(follows ? { followers: ["person:per_bob"], notes: { followers: "FYI" } } : {}), output: { kind: "note" } }];
    const r = await start(w, {}, t);
    const bob = w.kernel.chainFor({ flow: "probe", space: w.cat.space, approver: BOB, tainted: false });
    const main = (await w.kernel.allTasks()).find((/** @type {any} */ x) => x.title === "Quiet");
    const note = (await w.kernel.allTasks()).find((/** @type {any} */ x) => x.title === "Following: Quiet");
    assert.equal(Boolean(note), follows, follows ? "she is given a note task" : "no note task without a follower");
    if (follows) assert.equal(note.helpers, undefined, "and the note task names no helper");
    return { project: await can(() => w.kernel.records.get(bob, "project", r.id)), task: await can(() => w.kernel.tasksApi.get(bob, main.id)) };
  };
  assert.deepEqual(await readsOf(true), await readsOf(false));
});

test("a template task may carry a reviewer and an approver, each { who, skills?, instructions? }: checked as a Flow step is, and made as the task's slots", { timeout: 60_000 }, async () => {
  const slotsTpl = () => { const t = tpl(); t.stages[0].tasks = [{ title: "Draft it", doer: "teammate:research", output: { kind: "note" }, reviewer: { who: "person:per_bob", instructions: "Check the tone" }, approver: { who: "person:per_alex" } }]; return t; };
  assert.deepEqual(problems(slotsTpl()), []);
  const bad = (/** @type {(t: any) => void} */ f, /** @type {RegExp} */ re) => { const t = slotsTpl(); f(t.stages[0].tasks[0]); assert.ok(problems(t).some(p => re.test(p.message)), JSON.stringify(problems(t))); };
  bad(k => { k.reviewer = "person:per_bob"; }, /reviewer is \{ who/);
  bad(k => { k.approver = { who: "pool:x" }; }, /approver is person/);
  bad(k => { k.checker = "person:per_bob"; }, /not both/);
  bad(k => { k.reviewer.skills = ["a", "a"]; }, /up to 10 different/);
  const w = await mk();
  await start(w, {}, slotsTpl());
  const t = await by(w, "Draft it");
  assert.equal(t.reviewer.id, "per_bob", JSON.stringify(t));
  assert.equal(t.checker.id, "per_alex");
  assert.equal(t.state, "ready");
});

test("a template that names a skill the stage cannot pin for everyone is refused in plain words for that task, and nothing half-made is left", { timeout: 60_000 }, async () => {
  const t = tpl(); t.stages[0].tasks = [{ title: "Draft it", doer: "teammate:research", output: { kind: "note" }, reviewer: { who: "person:per_bob", skills: ["personal/mine"] } }, { title: "Plain one", doer: "teammate:research", output: { kind: "note" } }];
  const w = await mk();
  await start(w, {}, t);
  assert.equal(await by(w, "Draft it"), undefined, "the task that names the skill is not made");
  assert.ok(await by(w, "Plain one"), "the stage's other task is made");
});

test("a gated template task that could not be made holds the stage: the other tasks finishing does not move the record on, and the event says why; with the cause fixed the stage advances", { timeout: 90_000 }, async () => {
  const stageOfProject = async (/** @type {any} */ w, /** @type {any} */ r) => (await w.kernel.records.get(w.kernel.sysChain(), "project", r.id)).data.template_stage;
  const gated = (/** @type {any} */ skills) => { const t = tpl(); t.stages[0].tasks = [
    { title: "Plain one", doer: "teammate:research", output: { kind: "note" } },
    { title: "Needs a check", doer: "teammate:research", output: { kind: "note" }, approver: { who: "person:per_alex", ...(skills ? { skills } : {}) } },
  ]; return t; };
  const w = await mk();
  const r = await start(w, {}, gated(["personal/mine"]));
  assert.equal(await by(w, "Needs a check"), undefined, "the gated task could not be made");
  const plain = await by(w, "Plain one");
  await w.kernel.completeTask(plain.id, {});
  await settle(w);
  assert.equal(await stageOfProject(w, r), "Opening", "the stage did not settle on the task that was made");
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.blocked" && /approval step could not be made.*Needs a check/.test(e.data.why)), JSON.stringify(w.stageEvents.map((/** @type {any} */ e) => e.type)));
  // the same template without the unusable skill: both tasks are made, and the stage moves on only when the approval is done
  const w2 = await mk();
  const r2 = await start(w2, {}, gated(null));
  assert.ok(await by(w2, "Needs a check"));
  await w2.kernel.completeTask((await by(w2, "Plain one")).id, {});
  await settle(w2);
  assert.equal(await stageOfProject(w2, r2), "Opening", "the check is still waiting");
  await w2.kernel.completeTask((await by(w2, "Needs a check")).id, {});
  await settle(w2);
  assert.equal(await stageOfProject(w2, r2), "Done");
});

test("the hold on an unmade gated task survives a restart: the module that takes the open gate back still refuses to move the record on, and says why", { timeout: 90_000 }, async () => {
  const t = tpl(); t.stages[0].tasks = [
    { title: "Plain one", doer: "teammate:research", output: { kind: "note" } },
    { title: "Needs a check", doer: "teammate:research", output: { kind: "note" }, approver: { who: "person:per_alex", skills: ["personal/mine"] } },
  ];
  const w = await mk();
  const r = await start(w, {}, t);
  await w.kernel.completeTask((await by(w, "Plain one")).id, {});
  await settle(w);
  const stageOfProject = async () => (await w.kernel.records.get(w.kernel.sysChain(), "project", r.id)).data.template_stage;
  assert.equal(await stageOfProject(), "Opening");
  const events = /** @type {any[]} */ ([]);
  const fresh = createStages({ kernel: w.kernel, catalog: () => w.cat, chain: () => w.kernel.moduleChain({ module: "stages", approver: ALEX }), gates: w.runner.gatePort(), clock: () => w.clock.t, emit: (type, data) => events.push({ type, data }), hook: true, isAdmin: who => who.id === ALEX.id,
    ports: { roles: () => [ALEX, BOB] } });
  assert.equal(fresh.entries().length, 0, "it starts knowing nothing");
  assert.equal(await fresh.resume(), 1, "it takes the open gate back");
  await fresh.idle();
  assert.equal(await stageOfProject(), "Opening", "the restarted module does not move the record on");
  assert.ok(events.some(e => e.type === "stage.blocked" && /approval step could not be made.*Needs a check/.test(e.data.why)), JSON.stringify(events.map(e => e.type)));
});

test("a template task may be given to a group: the task is made for the group and the first holder to start it takes it", { timeout: 60_000 }, async () => {
  const t = tpl(); t.stages[0].tasks = [{ title: "Anyone", doer: "group:attorney", output: { kind: "note" } }];
  assert.deepEqual(problems(t), []);
  const w = await mk();
  await start(w, {}, t);
  const task = await by(w, "Anyone");
  assert.equal(task.pool.role, "attorney");
  assert.equal(task.doer.kind, "service");
  const taken = await w.kernel.tasksApi.start(w.kernel.as(BOB), task.id);
  assert.equal(taken.doer.id, BOB.id);
});
