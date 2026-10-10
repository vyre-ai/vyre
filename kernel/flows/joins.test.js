// Parallel branches and sub-flows (R032-08): lanes are runs that the parent waits for; a sub-flow is a Flow run as a step and gives back what it returns.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { SPACE } from "./testing/fixtures.js";
import { checkFlow } from "./schema.js";
import { printLines, parseLines } from "./lines.js";
import { sameFlow } from "./text.js";
import { explainRun } from "./describe.js";
import { applyPatch } from "./patch.js";

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
