// Parallel branches and sub-flows (R032-08): lanes are runs that the parent waits for; a sub-flow is a Flow run as a step and gives back what it returns.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { SPACE } from "./testing/fixtures.js";
import { checkFlow } from "./schema.js";
import { compileFlow, deriveCaps } from "./compile.js";
import { printLines, parseLines } from "./lines.js";
import { sameFlow } from "./text.js";
import { explainRun } from "./describe.js";
import { applyPatch } from "./patch.js";
import { graph, paintRun } from "./canvas.js";

const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const flowOf = (steps, extra = {}) => ({ format: 1, name: "par", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const lane = (id, steps) => ({ id, kind: "branch", steps });
const roots = async (w, id) => (await w.runner.listRuns({ flow: id })).filter(r => !r.parent);
const kids = async (w, id) => (await w.runner.listRuns({ flow: id })).filter(r => r.parent);
const taskOf = (w, title) => w.kernel.tasks.find(t => t.title === title);

test("parallel: both lanes start at once and the step after waits for all of them", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([
    { id: "p", kind: "parallel", steps: [
      lane("left", [{ id: "a1", kind: "assign", to: "role:manager", title: "Left lane work", output: { kind: "note" }, how: "person", await: true }]),
      lane("right", [{ id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.client" } } }]),
    ] },
    { id: "after", kind: "create", type: "payment", set: { client: { expr: "trigger.client" }, amount: 1 } },
  ]));
  w.kernel.inbound("payment.received", { client: "Harlow" });
  await settle(w);

  const [parent] = await roots(w, id);
  assert.equal(parent.state, "waiting", "the left lane waits for a person, so the parent waits");
  assert.equal(parent.waiting.kind, "children");
  assert.match(explainRun(parent, (await w.runner.store.getVersion(parent.flow, parent.version)).flow), /waiting for the runs p started to finish/);
  assert.equal(mine(w, "matter").length, 1, "the right lane ran at once");
  assert.equal(mine(w, "payment").length, 0, "the step after the join has not run");
  const lanes = await kids(w, id);
  assert.deepEqual(lanes.map(r => [r.parent.lane, r.state]).sort(), [["left", "waiting"], ["right", "done"]]);
  assert.ok(lanes.every(r => r.parent.run === parent.id && r.record === undefined), "a lane names its parent");

  w.kernel.completeTask(taskOf(w, "Left lane work").id, { outcome: "approved" });
  await settle(w);
  const done = await w.runner.getRun(parent.id);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  assert.equal(mine(w, "payment").length, 1, "the step after the join ran once");
  assert.deepEqual(Object.keys(done.steps.p.output.branches).sort(), ["left", "right"]);
  assert.ok(done.steps.p.output.branches.right.steps.m.record, "what a lane made is in the step's output");
});

test("parallel: lanes and sub-flows work the same when runs are records in the kernel", async () => {
  const w = await world({ store: "records" });
  await install(w, { format: 1, name: "inner", authorship: "human", trigger: { on: "manual" }, returns: { n: { expr: "steps.c.record.data.amount" } }, steps: [{ id: "c", kind: "create", type: "payment", set: { client: "Inner", amount: 5 } }] });
  const { id } = await install(w, flowOf([
    { id: "p", kind: "parallel", steps: [
      lane("left", [{ id: "a1", kind: "assign", to: "role:manager", title: "Left lane work", output: { kind: "note" }, how: "person", await: true }]),
      lane("right", [{ id: "s", kind: "subflow", flow: "inner" }]),
    ] },
    { id: "after", kind: "create", type: "payment", set: { client: "After", amount: { expr: "steps.s.result.n" } } },
  ]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [parent] = await roots(w, id);
  assert.equal(parent.state, "waiting");
  w.kernel.completeTask(taskOf(w, "Left lane work").id, { outcome: "approved" });
  await settle(w);
  const done = await w.runner.getRun(parent.id);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  assert.deepEqual(mine(w, "payment").map(p => [p.data.client, p.data.amount]).sort(), [["After", 5], ["Inner", 5]]);
});

test("parallel: a step after the join reads any lane's step as steps.<id>, and a lane reads what ran before the split", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([
    { id: "first", kind: "create", type: "matter", set: { client: "Before" } },
    { id: "p", kind: "parallel", steps: [
      lane("one", [{ id: "x", kind: "create", type: "payment", set: { client: { expr: "steps.first.record.data.client" }, amount: 1 } }]),
      lane("two", [{ id: "y", kind: "create", type: "payment", set: { client: "Two", amount: 2 } }]),
    ] },
    { id: "sum", kind: "create", type: "payment", set: { client: { expr: "steps.x.record.data.client + steps.y.record.data.client" }, amount: 3 } },
  ]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await roots(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(mine(w, "payment").map(p => p.data.client).sort(), ["BeforeTwo", "Before", "Two"].sort());
});

test("parallel: a lane that does not finish fails the step after the others settle, naming it; a failure path can carry on", async () => {
  const w = await world();
  const lanes = () => [
    lane("good", [{ id: "m", kind: "create", type: "matter", set: { client: "Fine" } }]),
    lane("bad", [{ id: "q", kind: "ask", to: "role:member", title: "Anyone?" }]),
  ];
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", label: "Both checks", steps: lanes() }, { id: "after", kind: "create", type: "payment", set: { amount: 1 } }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await roots(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "branch_failed");
  assert.equal(run.error.step, "p");
  assert.match(run.error.message, /the lane bad of Both checks did not finish/);
  assert.equal(mine(w, "matter").length, 1, "the other lane finished its work");
  assert.equal(mine(w, "payment").length, 0, "nothing after the join ran");

  const w2 = await world();
  const { id: id2 } = await install(w2, flowOf([{ id: "p", kind: "parallel", steps: lanes(), on_fail: { then: "continue", steps: [{ id: "note", kind: "create", type: "matter", set: { client: "Handled" } }] } }, { id: "after", kind: "create", type: "payment", set: { amount: 1 } }]));
  w2.kernel.inbound("payment.received", {});
  await settle(w2);
  const [r2] = await roots(w2, id2);
  assert.equal(r2.state, "done", JSON.stringify(r2.error));
  assert.equal(mine(w2, "payment").length, 1, "its failure path let the run go on");
});

test("parallel: the picture of a run paints each lane by how far its steps got, and the lane that failed is the one marked", async () => {
  const w = await world();
  const flow = flowOf([{ id: "p", kind: "parallel", steps: [
    lane("good", [{ id: "m", kind: "create", type: "matter", set: { client: "Fine" } }]),
    lane("bad", [{ id: "q", kind: "ask", to: "role:member", title: "Anyone?" }]),
    lane("slow", [{ id: "t", kind: "assign", to: "role:manager", title: "Slow lane", output: { kind: "note" }, how: "person", await: true }]),
  ] }]);
  const { id } = await install(w, flow);
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [parent] = await roots(w, id);
  const lanes = await kids(w, id);
  const shown = { ...parent, steps: Object.assign({}, ...lanes.map(k => k.steps), parent.steps) };
  const state = Object.fromEntries(paintRun(flow, shown, w.cat).nodes.map(n => [n.id, n.state]));
  assert.equal(state.good, "done", "its step ran, so the lane is done, not 'not reached'");
  assert.equal(state.bad, "failed");
  assert.equal(state.m, "done");
  assert.equal(state.q, "failed");
});

test("parallel: a failed lane is one row in Needs attention, the parent's, and it says which lane and why", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", label: "Both checks", steps: [
    lane("good", [{ id: "m", kind: "create", type: "matter", set: { client: "Fine" } }]),
    lane("bad", [{ id: "q", kind: "ask", to: "role:member", title: "Anyone?" }]),
  ] }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [parent] = await roots(w, id);
  assert.equal(parent.state, "failed");
  const lanes = await kids(w, id);
  assert.ok(lanes.some(r => r.state === "failed" && r.attention), "the lane itself is failed and flagged");
  const rows = await w.runner.attention();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].run, parent.id);
  assert.match(rows[0].message, /the lane bad of Both checks did not finish/);
  const h = await w.runner.health(id);
  assert.deepEqual([h.week.total, h.week.failed, h.week.ok], [1, 1, 0], "the Flow ran once and failed once, not three times");
});

test("parallel: retrying the parent sends the failed lane round again and keeps the one that finished", async () => {
  const holders = {};
  const w = await world({ ports: { roles: (_s, role) => holders[role] || (role === "manager" ? [BOB] : role === "attorney" ? [ALEX, BOB] : []) } });
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", steps: [
    lane("good", [{ id: "m", kind: "create", type: "matter", set: { client: "Once" } }]),
    lane("late", [{ id: "q", kind: "ask", to: "role:member", title: "Sign off?" }]),
  ] }, { id: "after", kind: "create", type: "payment", set: { amount: 1 } }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [failed] = await roots(w, id);
  assert.equal(failed.state, "failed");

  holders.member = [ALEX];
  await w.runner.retry(failed.id);
  await settle(w);
  const waiting = await w.runner.getRun(failed.id);
  assert.equal(waiting.state, "waiting", "the lane went round again and now asks a person");
  w.kernel.completeTask(taskOf(w, "Sign off?").id, { outcome: "approved" });
  await settle(w);
  const done = await w.runner.getRun(failed.id);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  assert.equal(mine(w, "matter").length, 1, "the lane that had finished was not run again");
  assert.equal(mine(w, "payment").length, 1);
  assert.equal((await kids(w, id)).length, 2, "no third run was made");
});

test("parallel: retrying the failed lane itself finishes the parent too", async () => {
  const holders = {};
  const w = await world({ ports: { roles: (_s, role) => holders[role] || (role === "manager" ? [BOB] : role === "attorney" ? [ALEX, BOB] : []) } });
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", steps: [
    lane("good", [{ id: "m", kind: "create", type: "matter", set: { client: "Once" } }]),
    lane("late", [{ id: "q", kind: "ask", to: "role:member", title: "Sign off?" }]),
  ] }, { id: "after", kind: "create", type: "payment", set: { amount: 1 } }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [parent] = await roots(w, id);
  assert.equal(parent.state, "failed");
  const bad = (await kids(w, id)).find(r => r.state === "failed");
  holders.member = [ALEX];
  await w.runner.retry(bad.id);
  await settle(w);
  w.kernel.completeTask(taskOf(w, "Sign off?").id, { outcome: "approved" });
  await settle(w);
  const done = await w.runner.getRun(parent.id);
  assert.equal(done.state, "done", `the parent finished (${done.state}) ${JSON.stringify(done.error)}`);
  assert.equal(mine(w, "payment").length, 1);
  assert.equal((await w.runner.attention()).length, 0, "nothing is left to ask about");
});

test("parallel: replaying the parent after a restart starts no lane twice", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", steps: [
    lane("a", [{ id: "t1", kind: "assign", to: "role:manager", title: "Task A", output: { kind: "note" }, how: "person", await: true }]),
    lane("b", [{ id: "t2", kind: "assign", to: "role:manager", title: "Task B", output: { kind: "note" }, how: "person", await: true }]),
  ] }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  await w.runner.recover(); await settle(w);
  await w.runner.recover(); await settle(w);
  assert.equal((await kids(w, id)).length, 2);
  assert.equal(w.kernel.tasks.filter(t => /^Task [AB]$/.test(t.title)).length, 2, "each lane asked once");
  for (const t of ["Task A", "Task B"]) w.kernel.completeTask(taskOf(w, t).id, { outcome: "approved" });
  await settle(w);
  assert.equal((await roots(w, id))[0].state, "done");
});

test("parallel: stopping a lane stops the wait, and a parent that is stopped stops its lanes", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", steps: [
    lane("a", [{ id: "t1", kind: "assign", to: "role:manager", title: "Task A", output: { kind: "note" }, how: "person", await: true }]),
    lane("b", [{ id: "t2", kind: "assign", to: "role:manager", title: "Task B", output: { kind: "note" }, how: "person", await: true }]),
  ] }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [parent] = await roots(w, id);
  await w.runner.cancel(parent.id, { by: "per_alex" });
  await settle(w);
  assert.deepEqual((await kids(w, id)).map(r => r.state), ["cancelled", "cancelled"]);
  assert.equal((await w.runner.getRun(parent.id)).state, "cancelled");
});

test("parallel: a run may start only so many lanes in all, so a loop of parallel steps cannot make thousands", async () => {
  const w = await world({ limits: { children_per_run: 5 } });
  const { id } = await install(w, flowOf([{ id: "each", kind: "repeat", over: "trigger.items", as: "item", steps: [{ id: "p", kind: "parallel", steps: [
    lane("a", [{ id: "m1", kind: "create", type: "matter", set: { client: "A" } }]),
    lane("b", [{ id: "m2", kind: "create", type: "matter", set: { client: "B" } }]),
  ] }] }]));
  w.kernel.inbound("payment.received", { items: [1, 2, 3] });
  await settle(w);
  const [run] = await roots(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "too_many_runs");
  assert.equal((await kids(w, id)).length, 4, "two turns of two lanes started before the third was refused");
});

test("parallel: what a lane read from outside taints the run, so the step after the join asks before it sends", async () => {
  const one = async (readsOutside) => {
    const sends = [];
    const service = async () => ({ status: 200, ok: true, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ name: "Rivera" })).toString("base64") });
    const w = await world({ ports: { service, call: async (_c, _a, _r, input) => { sends.push(input); return { sent: true }; } } });
    w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
    w.kernel.rules.push({ match: i => i.action === "email.send" && !i.approval, effect: "allow", reason: "a standing yes" });
    const { id } = await install(w, flowOf([
      { id: "p", kind: "parallel", steps: [
        lane("read", readsOutside ? [{ id: "g", kind: "service", connector: "practice", method: "GET", path: "/matters/42" }] : [{ id: "q", kind: "create", type: "matter", set: { client: "Quiet" } }]),
        lane("other", [{ id: "m", kind: "create", type: "matter", set: { client: "Other" } }]),
      ] },
      { id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com", body: "hi" } },
    ]));
    w.kernel.inbound("payment.received", {});
    await settle(w);
    const [run] = await roots(w, id);
    return { w, run, sends };
  };
  const quiet = await one(false);
  assert.equal(quiet.run.state, "done", JSON.stringify(quiet.run.error));
  assert.equal(quiet.sends.length, 1, "lanes that read nothing from outside leave the send alone");
  const outside = await one(true);
  assert.equal(outside.run.tainted, true, "the run took the lane's taint at the join");
  assert.equal(outside.sends.length, 0, "the send is held");
  const card = outside.w.kernel.tasks.find(t => t.form && t.form.kind === "held_act");
  assert.match(card.form.why, /outside this Space/);
  outside.w.kernel.completeTask(card.id, { outcome: "approved" });
  await settle(outside.w);
  assert.equal(outside.sends.length, 1, "and goes once a person says yes");
});

test("parallel: a Flow that allows one run at a time still finishes: the lanes take turns and nothing waits for a place that never frees", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([
    { id: "p", kind: "parallel", steps: [
      lane("a", [{ id: "ma", kind: "create", type: "matter", set: { client: { expr: "trigger.n" } } }]),
      lane("b", [{ id: "mb", kind: "create", type: "matter", set: { client: { expr: "trigger.n" } } }]),
      lane("c", [{ id: "mc", kind: "create", type: "matter", set: { client: { expr: "trigger.n" } } }]),
    ] },
    { id: "after", kind: "create", type: "payment", set: { client: { expr: "trigger.n" }, amount: 1 } },
  ], { concurrency: 1 }));
  for (let n = 0; n < 5; n++) w.kernel.inbound("payment.received", { n: `run${n}` });
  for (let i = 0; i < 10; i++) await settle(w);
  const parents = await roots(w, id);
  assert.equal(parents.length, 5);
  assert.deepEqual([...new Set(parents.map(r => r.state))], ["done"], JSON.stringify(parents.map(r => [r.state, r.queued && r.queued.reason])));
  assert.equal(mine(w, "matter").length, 15, "every lane of every run did its work once");
  assert.equal(mine(w, "payment").length, 5, "and every run went on after its join, once");
});

test("a run held at the switch can be stopped before it starts, and then nothing of it runs when the switch is released", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "Held" } }]));
  await w.runner.pauseAll({ reason: "test" });
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [held] = await roots(w, id);
  assert.equal(held.state, "queued");
  assert.deepEqual(await w.runner.cancel(held.id, { by: "per_alex" }), { ok: true, state: "cancelled" });
  await w.runner.resumeAll({});
  await settle(w);
  assert.equal((await w.runner.getRun(held.id)).state, "cancelled");
  assert.equal(mine(w, "matter").length, 0, "it never ran");
});

test("parallel: a practice run counts what every lane would do", async () => {
  const w = await world();
  const flow = flowOf([{ id: "p", kind: "parallel", steps: [
    lane("a", [{ id: "m1", kind: "create", type: "matter", set: { client: "A" } }]),
    lane("b", [{ id: "m2", kind: "create", type: "matter", set: { client: "B" } }, { id: "m3", kind: "create", type: "matter", set: { client: "C" } }]),
  ] }]);
  w.kernel.inbound("payment.received", {});
  const r = await w.runner.simulate(flow, { approver: ALEX, events: w.kernel.log.filter(e => e.type === "payment.received") });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.totals.writes, { matter: 3 });
  assert.equal(mine(w, "matter").length, 0, "nothing was written");
});

test("sub-flow: the other Flow runs as a step and gives back what it returns", async () => {
  const w = await world();
  const child = await install(w, { format: 1, name: "double_it", label: "Double it", authorship: "human", trigger: { on: "manual" }, returns: { doubled: { expr: "steps.c.record.data.amount" } },
    steps: [{ id: "c", kind: "create", type: "payment", set: { client: "Child", amount: { expr: "trigger.n * 2" } } }] });
  const { id } = await install(w, flowOf([
    { id: "s", kind: "subflow", flow: "double_it", input: { n: { expr: "trigger.n" } } },
    { id: "after", kind: "create", type: "payment", set: { client: "Parent", amount: { expr: "steps.s.result.doubled" } } },
  ]));
  w.kernel.inbound("payment.received", { n: 7 });
  await settle(w);
  const [parent] = await roots(w, id);
  assert.equal(parent.state, "done", JSON.stringify(parent.error));
  assert.deepEqual(mine(w, "payment").map(p => [p.data.client, p.data.amount]).sort(), [["Child", 14], ["Parent", 14]], "the parent used the child's answer");
  const [kid] = (await w.runner.listRuns({ flow: child.id }));
  assert.equal(kid.parent.run, parent.id);
  assert.equal(kid.depth, 1);
  assert.deepEqual(kid.result, { doubled: 14 });
  assert.equal(parent.steps.s.output.run, kid.id);
});

test("sub-flow: a Flow that is not running, and a Flow that runs itself without end, fail the step in plain words", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "s", kind: "subflow", flow: "nobody_home" }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await roots(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "not_found");
  assert.match(run.error.message, /nobody_home is not running in this Space/);

  const w2 = await world();
  const loop = await install(w2, { format: 1, name: "again", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "s", kind: "subflow", flow: "again" }] });
  await w2.runner.start(loop.id, {}, w2.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w2.cat.space }));
  await settle(w2);
  const all = await w2.runner.listRuns({ flow: loop.id });
  assert.ok(all.length > 1 && all.length <= 10, `it stopped after a few levels (${all.length})`);
  assert.ok(all.every(r => r.state === "failed"), "and every level says it failed");
  assert.ok(all.some(r => r.error && r.error.code === "too_deep"));
});

test("sub-flow: a Flow the approver may not run is refused by the same check as a manual start", async () => {
  const w = await world();
  await install(w, { format: 1, name: "secret_work", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "c", kind: "create", type: "payment", set: { amount: 9 } }] });
  const { id } = await install(w, flowOf([{ id: "s", kind: "subflow", flow: "secret_work" }]));
  w.kernel.rules.push({ match: i => i.action === "flows.run" && i.resource.includes("/flow/"), effect: "deny", reason: "forbidden" });
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await roots(w, id);
  assert.equal(run.state, "failed");
  assert.equal(mine(w, "payment").length, 0, "the other Flow never ran");
});

test("sub-flow, through the real kernel's authorize (no pushed rule): an approver who holds flows.run runs the other Flow; one who does not is refused", async () => {
  const CARLA = { kind: "person", id: "per_carla", space: SPACE };
  for (const holds of [true, false]) {
    const w = await world();
    w.kernel.addActor(CARLA);
    const g = w.kernel.gatewayGrants.get("gr_person_per_carla");
    if (!holds) g.actions = g.actions.filter(a => a !== "flows.run");
    assert.equal(g.actions.includes("flows.run"), holds);
    await install(w, { format: 1, name: "inner_work", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "c", kind: "create", type: "payment", set: { amount: 9 } }] }, ALEX);
    const { id } = await install(w, flowOf([{ id: "s", kind: "subflow", flow: "inner_work" }]), CARLA);
    w.kernel.inbound("payment.received", {});
    await settle(w);
    const [run] = await roots(w, id);
    const asked = w.kernel.authorizeCalls.filter(c => c.action === "flows.run" && c.resource.includes("/flow/"));
    assert.ok(asked.length >= 1, "the real authorize was asked for flows.run on the other Flow");
    if (holds) {
      assert.equal(run.state, "done", JSON.stringify(run.error));
      assert.equal(mine(w, "payment").length, 1, "the other Flow ran");
    } else {
      assert.notEqual(run.state, "done", "the run did not get through");
      assert.ok(["paused", "failed"].includes(run.state), `a refusal stops the run (${run.state})`);
      assert.equal(mine(w, "payment").length, 0, "the other Flow never ran");
      assert.equal((await kids(w, id)).length, 0, "no sub-flow run was started");
    }
  }
});

test("the schema: a lane belongs inside a parallel step, a parallel step has two to eight lanes, and the lines form round-trips", () => {
  const base = steps => checkFlow({ format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps });
  assert.match(JSON.stringify(base([lane("solo", [{ id: "m", kind: "create", type: "matter", set: {} }])])), /lane of a parallel step/);
  assert.match(JSON.stringify(base([{ id: "p", kind: "parallel", steps: [lane("only", [{ id: "m", kind: "create", type: "matter", set: {} }])] }])), /2 to 8 lanes/);
  assert.match(JSON.stringify(base([{ id: "p", kind: "parallel", steps: [{ id: "m", kind: "create", type: "matter", set: {} }, lane("b", [{ id: "n", kind: "create", type: "matter", set: {} }])] }])), /lanes only/);
  assert.match(JSON.stringify(base([{ id: "p", kind: "parallel", steps: [lane("a", [{ id: "m", kind: "create", type: "matter", set: {} }]), lane("b", [])] }])), /give the steps this lane runs/);
  const flow = flowOf([
    { id: "p", kind: "parallel", steps: [lane("a", [{ id: "m", kind: "create", type: "matter", set: { client: "A" } }]), lane("b", [{ id: "n", kind: "subflow", flow: "other", input: { x: { expr: "trigger.x" } } }])] },
  ], { returns: { done: true } });
  assert.deepEqual(checkFlow(flow), []);
  const text = printLines(flow);
  assert.ok(sameFlow(parseLines(text), flow), text);
});

test("edit by patch: a step goes into a lane, a lane can be removed with its steps, and the result still checks", () => {
  const base = flowOf([{ id: "p", kind: "parallel", steps: [lane("a", [{ id: "m1", kind: "create", type: "matter", set: { client: "A" } }]), lane("b", [{ id: "m2", kind: "create", type: "matter", set: { client: "B" } }]), lane("c", [{ id: "m3", kind: "create", type: "matter", set: { client: "C" } }])] }]);
  let f = applyPatch(base, [{ op: "insert", into: "b", block: "steps", line: "n create type=matter set={client: N}" }]);
  assert.deepEqual(f.steps[0].steps[1].steps.map(s => s.id), ["m2", "n"]);
  f = applyPatch(f, [{ op: "remove", step: "c" }]);
  assert.deepEqual(f.steps[0].steps.map(s => s.id), ["a", "b"]);
  assert.deepEqual(checkFlow(f), []);
});

test("the compiler sees inside lanes: an outward step in a lane is listed on the approval card and its power is derived", async () => {
  const w = await world();
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const flow = flowOf([{ id: "p", kind: "parallel", steps: [
    lane("a", [{ id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com" } }]),
    lane("b", [{ id: "m", kind: "create", type: "matter", set: { client: "B" } }]),
  ] }, { id: "again", kind: "subflow", flow: "other" }]);
  const c = compileFlow(flow, w.cat);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  assert.deepEqual(c.effects.outward.map(o => o.step), ["mail"]);
  assert.deepEqual(c.effects.writes, ["matter"]);
  const caps = deriveCaps(flow, w.cat).map(x => x.action).sort();
  assert.deepEqual(caps, ["email.send", "flows.run", "records.create"]);
  const bad = compileFlow(flowOf([{ id: "p", kind: "parallel", steps: [lane("a", [{ id: "x", kind: "create", type: "matter", set: { client: "A" } }]), lane("b", [{ id: "y", kind: "create", type: "matter", set: { client: { expr: "steps.x.record.id" } } }])] }]), w.cat);
  assert.equal(bad.ok, false, "a lane cannot read what a sibling lane makes");
  assert.match(JSON.stringify(bad.errors), /steps\.x is not a step that has already run/);
});

test("the canvas draws lanes side by side under the parallel step, each named, and a person is a person, never an id", async () => {
  const w = await world();
  const flow = flowOf([{ id: "p", kind: "parallel", steps: [
    lane("review", [{ id: "look", kind: "assign", to: "person:per_" + "a".repeat(26), title: "Look it over", output: { kind: "note" } }]),
    lane("draft", [{ id: "s", kind: "subflow", flow: "inner_note" }]),
  ] }]);
  const g = graph(flow, w.cat);
  const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  assert.deepEqual([byId.review.label, byId.draft.label], ["review", "draft"], "a lane is named by the author's word for it");
  assert.equal(byId.look.label, "Give a task to a person");
  assert.equal(byId.s.label, 'Run the Flow "inner note"', "with no label to hand, the name reads as words");
  const labelled = graph(flow, { ...w.cat, flows: { inner_note: "Write the inner note" } });
  assert.equal(labelled.nodes.find(n => n.id === "s").label, 'Run the Flow "Write the inner note"', "and the Flow's own label when the Space has it");
  assert.deepEqual(g.edges.filter(e => e.from === "p").map(e => [e.to, e.kind]), [["review", "lane"], ["draft", "lane"]]);
  assert.ok(byId.review.lane !== byId.draft.lane && byId.review.lane > byId.p.lane, "the lanes sit side by side to the right of the parallel step");
  const named = graph(flow, { ...w.cat, people: { ["per_" + "a".repeat(26)]: "Alex Rivera" } });
  assert.equal(named.nodes.find(n => n.id === "look").label, "Give a task to Alex Rivera");
});
