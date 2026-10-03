import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { SPACE } from "./testing/fixtures.js";
import { sourceHash } from "./schema.js";

const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const flowOf = (steps, extra = {}) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const last = async (w, id) => (await w.runner.listRuns({ flow: id }))[0];

test("steps: find pushes simple conditions to the store and checks every row in memory; pick takes the first; filter narrows a list", async () => {
  const w = await world();
  for (const [client, fee] of [["A", 10], ["B", 200], ["B", 300], ["C", 5]]) await w.kernel.records.create(w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE }), "matter", { client, fee });
  const { id } = await install(w, flowOf([
    { id: "f", kind: "find", type: "matter", where: "record.client == trigger.who and record.fee > 100", limit: 10 },
    { id: "p", kind: "pick", type: "matter", where: "record.client == \"C\"" },
    { id: "g", kind: "filter", from: "steps.f.rows", where: "record.fee > 250" },
    { id: "out", kind: "create", type: "payment", set: { amount: { expr: "len(steps.f.rows) * 1000 + len(steps.g.rows)" }, client: { expr: "steps.p.record.data.client" } } },
  ]));
  w.kernel.inbound("payment.received", { who: "B" });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.steps.f.output.count, 2);
  assert.equal(run.steps.p.output.found, true);
  assert.equal(mine(w, "payment")[0].data.amount, 2001);
  assert.equal(mine(w, "payment")[0].data.client, "C");
  const q = w.kernel.calls.find(c => c[0] === "query" && c[2] && c[2].and);
  assert.ok(q, "the comparison went to the store as a filter");
});

test("steps: update, upsert, stage and remove act on the records they name, and a version conflict is retried once", async () => {
  const w = await world();
  const c = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  const m = await w.kernel.records.create(c, "matter", { client: "Old", stage: "Intake" });
  const { id } = await install(w, flowOf([
    { id: "u", kind: "update", type: "matter", record: { expr: "trigger.id" }, set: { client: "New" } },
    { id: "s", kind: "stage", type: "matter", record: { expr: "trigger.id" }, to: "Engagement" },
    { id: "up1", kind: "upsert", type: "payment", match: { client: "Z" }, set: { amount: 1 } },
    { id: "up2", kind: "upsert", type: "payment", match: { client: "Z" }, set: { amount: 2 } },
    { id: "r", kind: "remove", type: "matter", record: { expr: "trigger.other" } },
  ]));
  const other = await w.kernel.records.create(c, "matter", { client: "Gone" });
  w.kernel.inbound("payment.received", { id: m.id, other: other.id });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(mine(w, "matter").find(x => x.id === m.id).data.client, "New");
  assert.equal(mine(w, "matter").find(x => x.id === m.id).data.stage, "Engagement");
  assert.equal(mine(w, "payment").length, 1, "the second upsert updated");
  assert.equal(mine(w, "payment")[0].data.amount, 2);
  assert.ok(mine(w, "matter").find(x => x.id === other.id).deleted_at);
  assert.equal(run.steps.up1.output.created, true);
  assert.equal(run.steps.up2.output.created, false);
});

test("steps: repeat runs its steps once per item, each turn keyed apart, and a replay does not repeat a turn", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "each", kind: "repeat", over: "trigger.names", as: "n", steps: [{ id: "mk", kind: "create", type: "matter", set: { client: { expr: "n" } } }] }]));
  w.kernel.inbound("payment.received", { names: ["a", "b", "c"] });
  await settle(w);
  assert.deepEqual(mine(w, "matter").map(m => m.data.client), ["a", "b", "c"]);
  const run = await last(w, id);
  assert.deepEqual(Object.keys(run.steps).filter(k => k.startsWith("mk")).sort(), ["mk@0", "mk@1", "mk@2"]);
  const again = structuredClone(run);
  again.state = "running"; again.finished_at = undefined; again.steps["mk@2"] = { status: "started", at: 0 };
  await w.store.putRun(again);
  await w.runner.recover(); await settle(w);
  assert.equal(mine(w, "matter").length, 3);
});

test("steps: a loop is capped, and a runaway run stops at the step limit", async () => {
  const w = await world({ limits: { steps_per_run: 8 } });
  const { id } = await install(w, flowOf([{ id: "each", kind: "repeat", over: "trigger.names", as: "n", max: 1000, steps: [{ id: "mk", kind: "create", type: "matter", set: { client: { expr: "n" } } }] }]));
  w.kernel.inbound("payment.received", { names: Array.from({ length: 50 }, (_, i) => "n" + i) });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "too_many_steps");
  assert.ok(mine(w, "matter").length <= 8);
});

test("steps: assign and agent make tasks with their output, checker and instructions; agent waits for the assistant, assign does not", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([
    { id: "a1", kind: "assign", to: "role:manager", title: { expr: "\"Review \" + trigger.client" }, output: { kind: "note" }, how: "person" },
    { id: "r", kind: "agent", assistant: "teammate:research", title: "Research the client", instructions: { expr: "\"Look up \" + trigger.client" }, output: { kind: "fields", target: ["practice_area", "size"] } },
    { id: "m", kind: "create", type: "matter", set: { client: { expr: "steps.r.output.summary" } } },
  ]));
  w.kernel.inbound("payment.received", { client: "Harlow" });
  await settle(w);
  const t1 = w.kernel.tasks.find(t => t.title === "Review Harlow");
  assert.equal(t1.doer.id, "per_bob");
  assert.equal(t1.output.kind, "note");
  const t2 = w.kernel.tasks.find(t => t.title === "Research the client");
  assert.equal(t2.doer.kind, "agent");
  assert.equal(t2.doer.id, "research");
  assert.equal(t2.how, "assistant");
  assert.equal(t2.form.instructions, "Look up Harlow");
  assert.equal((await last(w, id)).state, "waiting");
  const e = w.kernel.completeTask(t2.id, { outcome: "approved" });
  void e;
  w.kernel.tasks.find(t => t.id === t2.id).output_value = 1;
  await settle(w);
  assert.equal((await last(w, id)).state, "done");
});

test("steps: asking a role nobody holds fails with a plain reason", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "q", kind: "ask", to: "role:member", title: "Anyone?" }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "failed");
  assert.match(run.error.message, /nobody holds the role member/);
});

test("steps: classify returns one of the labels or null; fn runs only in the sandbox and may return only what it declared", async () => {
  const src = "return { n: 1 };";
  const calls = [];
  const w = await world({ ports: { sandbox: async req => { calls.push(req); return { outputs: { n: 1, ...(req.inputs.leak ? { extra: 2 } : {}) } }; } } });
  const { id } = await install(w, flowOf([
    { id: "c", kind: "classify", input: { expr: "trigger.text" }, labels: ["urgent", "normal"] },
    { id: "f", kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: { leak: { expr: "trigger.leak" } }, outputs: ["n"] },
    { id: "m", kind: "create", type: "payment", set: { amount: { expr: "steps.f.n" }, client: { expr: "steps.c.label" } } },
  ]));
  w.kernel.modelLabel = "urgent";
  w.kernel.inbound("payment.received", { text: "help!", leak: false });
  await settle(w);
  assert.equal(mine(w, "payment")[0].data.client, "urgent");
  assert.equal(mine(w, "payment")[0].data.amount, 1);
  assert.equal(calls[0].hash, sourceHash(src));
  assert.deepEqual(calls[0].needs, []);
  w.kernel.modelLabel = "gibberish";
  w.kernel.inbound("payment.received", { text: "x", leak: true });
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.ok(runs.find(r => r.state === "failed" && r.error.code === "bad_output"), "an undeclared output is refused");
});

test("steps: http goes through the port as an outward act and marks the run tainted afterwards", async () => {
  const seen = [];
  const w = await world({ ports: { http: async (chain, req) => { seen.push(req); return { status: 200, body: { ok: true } }; } } });
  const { id } = await install(w, flowOf([{ id: "h", kind: "http", method: "POST", url: "https://example.com/hook", body: { n: { expr: "trigger.n" } } }]));
  w.kernel.inbound("payment.received", { n: 7 });
  await settle(w);
  assert.deepEqual(seen[0], { method: "POST", url: "https://example.com/hook", headers: undefined, body: { n: 7 } });
  assert.equal((await last(w, id)).tainted, true);
});

test("triggers: a web call runs the Flow tainted with a retry-safe key; a manual run needs flows.run; a stage trigger fires on entering the stage", async () => {
  const w = await world();
  const web = await install(w, { format: 1, name: "hook", authorship: "human", trigger: { on: "web", path: "intake" }, steps: [{ id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.name" } } }] });
  const r1 = await w.runner.handleWeb("intake", { body: { name: "From the web" }, key: "k1" });
  const r2 = await w.runner.handleWeb("intake", { body: { name: "From the web" }, key: "k1" });
  await settle(w);
  assert.equal(r1.run, r2.run);
  assert.equal(r2.duplicate, true);
  assert.equal(mine(w, "matter").length, 1);
  assert.equal((await last(w, web.id)).tainted, true);
  await assert.rejects(() => w.runner.handleWeb("nope", {}), /no Flow answers/);

  const man = await install(w, { format: 1, name: "manual", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "m", kind: "create", type: "payment", set: { amount: { expr: "trigger.amount" } } }] });
  w.kernel.rules.push({ match: i => i.action === "flows.run" && i.chain.hops[0].actor.id === "per_bob", effect: "deny", reason: "no_grant" });
  const alexChain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  await w.runner.start(man.id, { amount: 3 }, alexChain);
  await settle(w);
  assert.equal(mine(w, "payment")[0].data.amount, 3);
  const bobChain = { ...alexChain, hops: [{ actor: BOB }] };
  await assert.rejects(() => w.runner.start(man.id, { amount: 4 }, bobChain), /may not run/);

  const stage = await install(w, { format: 1, name: "onstage", authorship: "human", trigger: { on: "stage", type: "matter", stage: "Drafting" }, steps: [{ id: "n", kind: "assign", to: "role:manager", title: { expr: "\"Draft for \" + trigger.id" }, output: { kind: "draft" } }] });
  void stage;
  const m = mine(w, "matter")[0];
  await w.kernel.records.update(alexChain, "matter", m.id, { stage: "Drafting" }, m.version);
  await settle(w);
  assert.ok(w.kernel.tasks.find(t => t.title === `Draft for ${m.id}`));
});

test("triggers: a cron Flow fires once per window, never twice for the same minute, and nextWake names the next time", async () => {
  const w = await world();
  await install(w, { format: 1, name: "nightly", authorship: "human", trigger: { on: "time", cron: "0 3 * * *" }, steps: [{ id: "m", kind: "create", type: "payment", set: { amount: 1 } }] });
  await w.runner.tick();
  assert.equal(await w.runner.nextWake(), Date.UTC(2026, 9, 4, 3, 0, 0));
  w.clock.t = Date.UTC(2026, 9, 4, 3, 0, 30);
  await w.runner.tick(); await settle(w);
  await w.runner.tick(); await settle(w);
  assert.equal(mine(w, "payment").length, 1);
  assert.equal(await w.runner.nextWake(), Date.UTC(2026, 9, 5, 3, 0, 0));
});

test("loop control: a chain of runs deeper than the limit is refused and pauses the Flow with a card; a rate over the limit does too", async () => {
  const w = await world({ limits: { depth: 3, rate_per_minute: 5 } });
  const { id } = await install(w, flowOf([{ id: "m", kind: "create", type: "payment", set: { amount: 1 } }]));
  const parent = { id: "run_parent", flow: "other", version: 1, hash: "h", space: SPACE, trigger: { kind: "x", key: "x" }, tainted: false, source_spaces: [SPACE], depth: 3, state: "done", started_at: 0, updated_at: 0, steps: {}, approver: ALEX };
  await w.store.putRun(parent);
  const e = w.kernel.emit("payment.received", {}, w.kernel.chainFor({ flow: "other", approver: ALEX, tainted: false, space: SPACE, run: "run_parent" }));
  await settle(w);
  assert.equal(mine(w, "payment").length, 0, "depth 4 is over the limit of 3");
  assert.equal(e.corr, "run_parent");
  assert.equal((await w.store.flowRow(id)).status, "paused");
  assert.ok(w.kernel.tasks.find(t => /was paused: it was started by its own work/.test(t.title)));
  await w.runner.resumeFlow(id);
  for (let i = 0; i < 8; i++) w.kernel.inbound("payment.received", { i });
  await settle(w);
  assert.equal(mine(w, "payment").length, 5);
  assert.equal((await w.store.flowRow(id)).status, "paused");
  assert.ok(w.kernel.tasks.find(t => /more than 5 times in a minute/.test(t.title)));
});

test("recovery: a task answered while the runner was down releases its run on the next start", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "q", kind: "ask", to: "role:attorney", title: "Ok?" }, { id: "m", kind: "create", type: "payment", set: { amount: 9 } }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const t = w.kernel.tasks.find(x => x.title === "Ok?");
  w.kernel.subs.clear(); // the runner is down: nobody hears the answer
  w.kernel.completeTask(t.id, { outcome: "approved" });
  assert.equal(mine(w, "payment").length, 0);
  await w.runner.recover(); await settle(w);
  assert.equal((await last(w, id)).state, "done");
  assert.equal(mine(w, "payment").length, 1);
});

test("stores: the same Flow works when definitions and runs are records in the kernel", async () => {
  const w = await world({ store: "records" });
  const { id } = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: { expr: "trigger.who" } } }, { id: "w", kind: "wait", for_ms: 1000 }, { id: "b", kind: "create", type: "payment", set: { amount: 1 } }]));
  w.kernel.inbound("payment.received", { who: "Records" });
  await settle(w);
  assert.equal((await last(w, id)).state, "waiting");
  assert.ok(mine(w, "def_flow").length === 1 && mine(w, "flow_run").length === 1 && mine(w, "flow_approval").length === 1, "definition, approval and run are records");
  w.advance(1500); await w.runner.tick(); await settle(w);
  assert.equal((await last(w, id)).state, "done");
  assert.equal(mine(w, "payment").length, 1);
  assert.equal(mine(w, "flow_run").length, 1, "the run record is updated in place");
});
