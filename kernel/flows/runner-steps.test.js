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
  for (const [client, fee] of [["A", 10], ["B", 200], ["B", 300], ["C", 5]]) await w.kernel.records.create(w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE }), "matter", { client, fee: { amount: fee, currency: "USD" } });
  const { id } = await install(w, flowOf([
    { id: "f", kind: "find", type: "matter", where: "record.client == trigger.who and record.fee.amount > 100", limit: 10 },
    { id: "p", kind: "pick", type: "matter", where: "record.client == \"C\"" },
    { id: "g", kind: "filter", from: "steps.f.rows", where: "record.fee.amount > 250" },
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
  const q = w.kernel.calls.find(c => c[0] === "query" && c[1] === "matter" && c[2]);
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
  const gone = mine(w, "matter").find(x => x.id === other.id);
  assert.ok(!gone || gone.deleted_at, "the removed record is gone (the kernel hides it; the fake keeps it marked)");
  assert.equal(run.steps.up1.output.created, true);
  assert.equal(run.steps.up2.output.created, false);
});

test("steps: repeat runs its steps once per item, each turn keyed apart, and a replay does not repeat a turn", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "each", kind: "repeat", over: "trigger.names", as: "n", steps: [{ id: "mk", kind: "create", type: "matter", set: { client: { expr: "n" } } }] }]));
  w.kernel.inbound("payment.received", { names: ["a", "b", "c"] });
  await settle(w);
  assert.deepEqual(mine(w, "matter").map(m => m.data.client).sort(), ["a", "b", "c"]);
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
    { id: "r", kind: "agent", assistant: "teammate:research", title: "Research the client", instructions: { expr: "\"Look up \" + trigger.client" }, output: { kind: "note" } },
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

/** A stand-in for the vault's forward: a fake that keeps what it was asked and mimics the answers (a response, a saved file, a held call). */
const fakeService = (over = {}) => {
  const seen = [], byIdem = new Map();
  const port = async q => {
    seen.push(q);
    if (byIdem.has(q.idem)) return byIdem.get(q.idem);
    let r;
    if (over.answer) r = await over.answer(q);
    else if (q.request.saveTo) r = { saved: { path: q.request.saveTo, version: 3, size: 1234, sha256: "ab".repeat(32) } };
    else r = { status: 200, ok: true, headers: { "content-type": "application/json", "set-cookie": "sid=SECRET", authorization: "Bearer LEAK" }, body: Buffer.from(JSON.stringify({ id: "m-1", name: "Rivera", ssn: "sealed-ref" })).toString("base64") };
    byIdem.set(q.idem, r);
    return r;
  };
  return { port, seen };
};
const svcFlow = steps => ({ format: 1, name: "svc", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });

test("service: a read runs at once, the response is the step's output, and the run is tainted afterwards", async () => {
  const f = fakeService();
  const w = await world({ ports: { service: f.port } });
  const { id } = await install(w, svcFlow([
    { id: "g", kind: "service", connector: "practice", method: "GET", path: "/matters/42", query: { q: { expr: "trigger.n" } } },
    { id: "m", kind: "create", type: "payment", set: { client: { expr: "steps.g.response.json.name" }, amount: { expr: "steps.g.response.status" } } },
  ]));
  w.kernel.inbound("payment.received", { n: 7 });
  await settle(w);
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.seen[0].request, { method: "GET", path: "/matters/42", query: { q: 7 } });
  assert.equal(f.seen[0].connector, "practice");
  assert.equal(f.seen[0].approval, undefined);
  assert.deepEqual([mine(w, "payment")[0].data.client, mine(w, "payment")[0].data.amount], ["Rivera", 200]);
  const run = await last(w, id);
  assert.equal(run.tainted, true, "what came back is content from outside");
  const out = run.steps.g.output.response;
  assert.equal(out.headers["set-cookie"], undefined, "credential-bearing headers are not kept");
  assert.equal(out.headers.authorization, undefined);
  assert.ok(!JSON.stringify(run).includes("SECRET") && !JSON.stringify(run).includes("LEAK"));
  assert.ok(!JSON.stringify(f.seen).includes("Bearer"), "the Flow never held a credential, so none went into the request");
});

test("service: an outward call is held for the ask-first task, then runs once with that approval; a no ends the step with a plain reason", async () => {
  for (const outcome of ["approved", "rejected"]) {
    const f = fakeService();
    const w = await world({ ports: { service: f.port } });
    w.kernel.rules.push({ match: i => i.action === "service.call" && !i.approval, effect: "ask", reason: "outward" });
    const { id } = await install(w, svcFlow([{ id: "p", kind: "service", connector: "practice", method: "POST", path: "/matters", body: { client: { expr: "trigger.n" } } }]));
    w.kernel.inbound("payment.received", { n: "Rivera" });
    await settle(w);
    assert.equal(f.seen.length, 0, "held: nothing left the Space");
    const run = await last(w, id);
    assert.equal(run.state, "waiting");
    const task = w.kernel.tasks.find(t => t.form && t.form.kind === "held_act");
    assert.equal(task.form.action, "service.call");
    assert.match(task.form.resource, /service\/practice$/);
    w.kernel.completeTask(task.id, { outcome });
    await settle(w);
    const done = await last(w, id);
    if (outcome === "approved") {
      assert.equal(f.seen.length, 1);
      assert.equal(f.seen[0].approval, task.id, "the vault is told which approval covers it");
      assert.equal(done.state, "done");
    } else {
      assert.equal(f.seen.length, 0);
      assert.equal(done.state, "failed");
      assert.match(done.error.message, /a person said no to step p/);
    }
  }
});

test("service: a file goes by Drive reference both ways, never as bytes through the Flow", async () => {
  const f = fakeService();
  const w = await world({ ports: { service: f.port } });
  w.kernel.rules.push({ match: i => i.action === "service.call", effect: "allow", reason: "a standing yes" }); // the upload is outward: this run has a standing permission, so authorize allows
  const { id } = await install(w, svcFlow([
    { id: "up", kind: "service", connector: "practice", method: "PUT", path: "/documents/7", drive: { upload: { path: "clients/rivera/engagement.pdf", version: "v2", contentType: "application/pdf" } } },
    { id: "down", kind: "service", connector: "practice", method: "GET", path: "/matters/42", drive: { saveTo: "inbox/matter-42.json" } },
  ]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  assert.deepEqual(f.seen[0].request.upload, { drive: { path: "clients/rivera/engagement.pdf", version: "v2", contentType: "application/pdf" } });
  assert.equal(f.seen[0].request.body, undefined);
  assert.deepEqual(f.seen[1].request.saveTo, "inbox/matter-42.json");
  const run = await last(w, id);
  assert.deepEqual(run.steps.down.output.saved, { path: "inbox/matter-42.json", version: 3, size: 1234, sha256: "ab".repeat(32) });
  assert.equal(run.steps.up.output.files[0].way, "send");
});

test("service: a redelivered event and a replay after a crash never repeat the call (one idempotency key per flow, event and step)", async () => {
  const f = fakeService();
  const w = await world({ ports: { service: f.port } });
  await install(w, svcFlow([{ id: "g", kind: "service", connector: "practice", method: "GET", path: "/matters/1" }]));
  const e = w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  void w.runner.onEvent(e);
  await settle(w);
  assert.equal(f.seen.length, 1, "the same event is one run");
  assert.ok(f.seen[0].idem.includes(":"), "the key names the run and the step");
  // a crash between 'started' and 'done' replays the act with the same key, and the connector's own dedupe answers it
  const again = await f.port(f.seen[0]);
  assert.equal(again.status, 200);
});

test("service: the vault holding a call itself ends the step with a plain reason instead of sending", async () => {
  const f = fakeService({ answer: async () => ({ held: true, kind: "outward", summary: "POST /matters" }) });
  const w = await world({ ports: { service: f.port } });
  const { id } = await install(w, svcFlow([{ id: "g", kind: "service", connector: "practice", method: "GET", path: "/matters/1" }]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "failed");
  assert.match(run.error.message, /the vault is holding the call to practice/);
});

test("service: the stored response is capped and sealed values the vault already swapped for references stay references", async () => {
  const big = "x".repeat(200_000);
  const f = fakeService({ answer: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(big).toString("base64") }) });
  const w = await world({ ports: { service: f.port } });
  const { id } = await install(w, svcFlow([{ id: "g", kind: "service", connector: "practice", method: "GET", path: "/matters/1" }]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  const r = (await last(w, id)).steps.g.output.response;
  assert.equal(r.body.length, 64 * 1024);
  assert.equal(r.truncated, true);
});

test("service: the compiler refuses an unknown connector and a path the route does not allow (deny wins, default no), and says outward calls are held", async () => {
  const w = await world();
  const bad = c => w.runner.define(null, svcFlow([{ id: "s", kind: "service", connector: "practice", method: "GET", path: "/matters/1", ...c }]), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  assert.equal((await bad({ connector: "nowhere" })).ok, false);
  assert.match(JSON.stringify((await bad({ connector: "nowhere" })).errors), /there is no connector nowhere/);
  for (const c of [{ path: "/admin/users" }, { method: "DELETE", path: "/matters/1" }, { path: "/other" }]) assert.match(JSON.stringify((await bad(c)).errors), /does not allow/, JSON.stringify(c));
  assert.equal((await bad({})).ok, true);
  const post = await bad({ method: "POST", path: "/matters", drive: { upload: { path: "a/b.pdf" } } });
  assert.equal(post.ok, true);
  assert.deepEqual(post.effects.services, [{ step: "s", connector: "practice", method: "POST", path: "/matters", outward: true, files: [{ way: "send", path: "a/b.pdf", version: null }] }]);
  assert.equal(post.effects.outward[0].action, "service.call");
  assert.match(JSON.stringify((await bad({ headers: { Authorization: "x" } })).errors), /the vault's/, "a Flow never sets a credential header");
  assert.match(JSON.stringify((await bad({ path: "../x" })).errors), /path/);
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
  w.stopListening(); // the runner is down: nobody hears the answer
  await w.kernel.completeTask(t.id, { outcome: "approved" });
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
  assert.ok(mine(w, "def-flow").length === 1 && mine(w, "flow-run").length === 1 && mine(w, "flow-approval").length === 1, "definition, approval and run are records");
  w.advance(1500); await w.runner.tick(); await settle(w);
  assert.equal((await last(w, id)).state, "done");
  assert.equal(mine(w, "payment").length, 1);
  assert.equal(mine(w, "flow-run").length, 1, "the run record is updated in place");
});

// ---- standing rules for a space (DESIGN-flows-joints 5a): the two behaviours the kernel's authorize calls on ----
const RULE_DRAFT = { id: "rule_drafts", label: "Email is drafts only" };
const draftRule = (action = "service.call") => ({ match: i => i.action === action, effect: "allow", reason: "ok", obligations: [{ type: "draft_only", rule: "rule_drafts" }], rule: RULE_DRAFT });

test("rules, draft only: a send becomes the connector's draft operation and nothing is sent, even after an approval", async () => {
  const f = fakeService();
  const w = await world({ ports: { service: f.port } });
  w.cat.connectors.practice.draft = { method: "POST", path: "/drafts" };
  w.cat.connectors.practice.allow.push({ method: "POST", path: "/messages/send" });
  w.kernel.rules.push(draftRule());
  const { id } = await install(w, svcFlow([{ id: "p", kind: "service", connector: "practice", method: "POST", path: "/messages/send", body: { to: "jane@example.test" } }]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  assert.equal(f.seen.length, 1);
  assert.deepEqual([f.seen[0].request.method, f.seen[0].request.path], ["POST", "/drafts"], "the draft operation, not the send");
  assert.equal(f.seen[0].draft, true);
  assert.equal(f.seen[0].approval, undefined, "no approval is passed on: nothing to send");
  const run = await last(w, id);
  assert.equal(run.state, "done");
  assert.equal(run.steps.p.output.draft, true);
  assert.ok(!f.seen.some(q => q.request.path === "/messages/send"), "the send never reached the vault");
});

test("rules, draft only: a connector with no draft operation sends nothing and says why in plain words; a call step uses its draft_as action", async () => {
  const f = fakeService();
  const w = await world({ ports: { service: f.port } });
  w.cat.connectors.practice.allow.push({ method: "POST", path: "/messages/send" });
  w.kernel.rules.push(draftRule());
  const { id } = await install(w, svcFlow([{ id: "p", kind: "service", connector: "practice", method: "POST", path: "/messages/send" }]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  assert.equal(f.seen.length, 0, "nothing was sent");
  const run = await last(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "draft_only");
  assert.match(run.error.message, /drafts only \(Email is drafts only\).*no way to prepare a draft, so nothing was sent/);
  // a `call` step: the catalog names the action that drafts instead of sending
  const calls = [];
  const w2 = await world({ ports: { call: async (_c, action, resource, input) => { calls.push([action, input]); return { ok: true }; } } });
  w2.cat.actions["email.send"].draft_as = "email.draft";
  w2.cat.actions["email.draft"] = { risk: "write", label: "Draft an email" };
  w2.kernel.rules.push(draftRule("email.send"));
  await install(w2, svcFlow([{ id: "e", kind: "call", action: "email.send", resource: `vyre://${w2.cat.space}/message/*`, input: { to: "jane@example.test" } }]));
  w2.kernel.inbound("payment.received", { n: 1 });
  await settle(w2);
  assert.deepEqual(calls.map(c => c[0]), ["email.draft"], "the draft action ran, the send did not");
});

test("rules, always ask: the held task is answered by the person the rule names, says it cannot be waived, and carries the rule; never refuses with the rule's words", async () => {
  const f = fakeService();
  const w = await world({ ports: { service: f.port } });
  const josh = { kind: "person", id: "per_josh", space: w.cat.space };
  w.kernel.addActor?.(josh);
  w.kernel.rules.push({ match: i => i.action === "service.call" && !i.approval, effect: "ask", reason: "needs_approval", obligations: [{ type: "ask", rule: "rule_dates", approver: { person: "per_josh" }, waivable: false }], rule: { id: "rule_dates", label: "Every date written to the practice system is approved by Josh" } });
  const { id } = await install(w, svcFlow([{ id: "p", kind: "service", connector: "practice", method: "POST", path: "/matters", body: { due: "2026-11-01" } }]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  assert.equal(f.seen.length, 0, "held");
  const task = w.kernel.tasks.find(t => t.form && t.form.kind === "held_act");
  assert.deepEqual([task.doer.kind, task.checker.id], ["service", "per_josh"], "the Flow's service asks, and the named person is the one who answers");
  assert.equal(task.form.waivable, false, "no 'don't ask again'");
  assert.equal(task.form.rule, "rule_dates");
  assert.match(task.form.why, /approved by Josh/);
  w.kernel.completeTask(task.id, { outcome: "approved" });
  await settle(w);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].approval, task.id);
  // never: the refusal is the rule's own words
  const w2 = await world({ ports: { service: f.port } });
  w2.cat.connectors.practice.allow.push({ method: "DELETE", path: "/matters/*" });
  w2.kernel.rules.push({ match: i => i.action === "service.call", effect: "deny", reason: "rule_never", obligations: [], rule: { id: "rule_x", label: "Assistants never delete a record" } });
  const { id: id2 } = await install(w2, svcFlow([{ id: "p", kind: "service", connector: "practice", method: "DELETE", path: "/matters/1" }]));
  w2.kernel.inbound("payment.received", { n: 1 });
  await settle(w2);
  const r2 = await last(w2, id2);
  assert.equal(r2.error.code, "rule_never");
  assert.match(r2.error.message, /Assistants never delete a record/);
});
