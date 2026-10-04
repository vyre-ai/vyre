import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { onPayment, SPACE } from "./testing/fixtures.js";
import { sourceHash } from "./schema.js";

const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const flowOf = (steps, extra = {}) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });

test("runner: a payment opens a matter, asks the attorney, and finishes when they answer", async () => {
  const w = await world();
  const { id } = await install(w, onPayment());
  w.kernel.inbound("payment.received", { amount: 500, client: "Jane Doe" });
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "waiting", "it waits on the attorney");
  assert.equal(mine(w, "matter").length, 1);
  assert.equal(mine(w, "matter")[0].data.client, "Jane Doe");
  assert.equal(mine(w, "matter")[0].data.stage, "Intake");
  const ask = w.kernel.tasks.find(t => t.source === "flow_step" && t.output.kind === "decision" && /Send the engagement letter to Jane Doe/.test(t.title));
  assert.ok(ask, "an ask card for the attorney");
  assert.equal(ask.doer.id, "per_alex");
  assert.deepEqual(ask.helpers.map(h => h.id), ["per_bob"], "the other holders of the role are helpers");
  assert.equal(w.kernel.tasks.find(t => t.title === "Repeat client"), undefined, "the decide step took no branch for a first-time client");
  w.kernel.completeTask(ask.id, { outcome: "approved", answer: { ok: true } });
  await settle(w);
  const done = await w.runner.getRun(runs[0].id);
  assert.equal(done.state, "done");
  assert.equal(done.steps.ok.output.outcome, "approved");
  assert.ok(w.emitted.some(e => e.type === "flow.started") && w.emitted.some(e => e.type === "flow.finished" && e.data.state === "done"));
  assert.ok(w.emitted.every(e => e.corr === runs[0].id), "every event carries the run id as corr");
});

test("runner: the same trigger delivered twice is one run and one effect", async () => {
  const w = await world();
  await install(w, onPayment());
  const e = w.kernel.inbound("payment.received", { amount: 5, client: "A" });
  await settle(w);
  await Promise.all([w.runner.onEvent(e), w.runner.onEvent(e)]);
  await settle(w);
  assert.equal((await w.runner.listRuns()).length, 1);
  assert.equal(mine(w, "matter").length, 1);
});

test("runner: a crash between an effect and its record replays with the same idempotency key and does not act twice", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([
    { id: "a", kind: "create", type: "matter", set: { client: "X" } },
    { id: "b", kind: "create", type: "matter", set: { client: "Y" } },
  ]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.equal(run.state, "done");
  // rewind the stored run as if the process died after step b acted but before it was written down
  const crashed = structuredClone(run);
  crashed.state = "running"; crashed.finished_at = undefined; crashed.steps.b = { status: "started", at: run.steps.b.at };
  await w.store.putRun(crashed);
  await w.runner.recover();
  await settle(w);
  assert.equal(mine(w, "matter").length, 2, "b was not made a second time");
  assert.equal((await w.runner.getRun(run.id)).state, "done");
  assert.equal((await w.runner.getRun(run.id)).steps.b.output.record.data.client, "Y");
});

test("runner: the run is pinned to the version it started on", async () => {
  const w = await world();
  const v1 = await install(w, flowOf([{ id: "w", kind: "wait", for_ms: 60000 }, { id: "c", kind: "create", type: "matter", set: { client: "one" } }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const v2 = await w.runner.define(v1.id, flowOf([{ id: "c", kind: "create", type: "matter", set: { client: "two" } }]), ALEX);
  await w.runner.approve(v1.id, v2.version, ALEX, v2.hash);
  w.advance(61000);
  await w.runner.tick();
  await settle(w);
  assert.deepEqual(mine(w, "matter").map(m => m.data.client), ["one"]);
  w.kernel.inbound("payment.received", {});
  await settle(w);
  assert.deepEqual(mine(w, "matter").map(m => m.data.client).sort(), ["one", "two"], "a new trigger runs the new version");
});

test("runner: an approval for other content than the version is refused, and an uncompilable version cannot be saved", async () => {
  const w = await world();
  const d = await w.runner.define(null, flowOf([{ id: "c", kind: "create", type: "matter", set: { client: "q" } }]), ALEX);
  await assert.rejects(() => w.runner.approve(d.id, d.version, ALEX, "someotherhash"), /different content/);
  const bad = await w.runner.define(null, flowOf([{ id: "c", kind: "create", type: "ghost", set: {} }]), ALEX);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /no record type ghost/);
  w.kernel.inbound("payment.received", {});
  await settle(w);
  assert.equal((await w.runner.listRuns()).length, 0, "nothing runs before approval");
});

test("runner: every step is authorized as [automation, approver], and a denial for a lost grant pauses the Flow and says why", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "X" } }, { id: "b", kind: "create", type: "matter", set: { client: "Y" } }]));
  w.kernel.denied.add("per_alex");
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.equal(run.state, "paused");
  assert.match(run.error.message, /per_alex can no longer .*paused until that is fixed/);
  assert.equal(mine(w, "matter").length, 0);
  const row = await w.store.flowRow(id);
  assert.equal(row.status, "paused");
  const chain = w.kernel.authorizeCalls[0].chain;
  assert.deepEqual(chain.hops.map(h => `${h.actor.kind}:${h.actor.id}`), [`automation:${id}`, "person:per_alex"]);
  // fixed: the grant is back, the Flow resumes, the paused run goes on
  w.kernel.denied.clear();
  await w.runner.resumeFlow(id);
  await w.runner.retry(run.id);
  await settle(w);
  assert.equal((await w.runner.getRun(run.id)).state, "done");
  assert.equal(mine(w, "matter").length, 2);
});

test("runner: a step outside the Flow's declared caps never reaches the kernel", async () => {
  const w = await world();
  const flow = flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "X" } }], { caps: [{ action: "records.read", resource: `vyre://${SPACE}/matter/*` }] });
  const d = await w.runner.define(null, flow, ALEX);
  assert.equal(d.ok, false, "the compiler already refuses it");
  // a Flow whose caps were narrowed after the fact is still refused at run time
  const ok = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "X" } }]));
  const row = w.store.flows.get(ok.id);
  row.versions[0].flow.caps = [{ action: "records.read", resource: `vyre://${SPACE}/matter/*` }];
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: ok.id });
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "outside_caps");
  assert.equal(mine(w, "matter").length, 0);
  assert.equal(w.kernel.authorizeCalls.length, 0);
});

test("runner: an ask from authorize raises a held-act card, waits, and goes on when a person approves; a no ends the run", async () => {
  const w = await world();
  w.kernel.rules.push({ match: i => i.action === "records.create" && !i.approval, effect: "ask", reason: "needs_approval" });
  const { id } = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "X" } }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.equal(run.state, "waiting");
  assert.equal(mine(w, "matter").length, 0);
  const card = w.kernel.tasks.find(t => t.form && t.form.kind === "held_act");
  assert.equal(card.form.action, "records.create");
  w.kernel.completeTask(card.id, { outcome: "approved" });
  await settle(w);
  assert.equal((await w.runner.getRun(run.id)).state, "done");
  assert.equal(mine(w, "matter").length, 1);
  // and a refusal
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const card2 = w.kernel.tasks.filter(t => t.form && t.form.kind === "held_act")[1];
  w.kernel.completeTask(card2.id, { outcome: "rejected" });
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.find(r => r.state === "failed").error.code, "refused");
  assert.equal(mine(w, "matter").length, 1);
});

test("runner: a run started by outside content is tainted, and its outward step needs an Ask even though authorize says allow", async () => {
  const w = await world();
  const sends = [];
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const w2 = await world({ ports: { call: async (c, a, r, input) => { sends.push(input); return { sent: true }; } } });
  w2.kernel.rules.push({ match: i => i.action === "email.send" && !i.approval, effect: "allow", reason: "a standing yes" }); // authorize allows (the real kernel asks for every outward act otherwise)
  const { id } = await install(w2, flowOf([{ id: "m", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com", body: "hi" } }]));
  w2.kernel.inbound("payment.received", { n: 1 }, "member");
  await settle(w2);
  assert.equal(sends.length, 1, "a member's event sends without a card");
  w2.kernel.inbound("payment.received", { n: 2 }, "external");
  await settle(w2);
  assert.equal(sends.length, 1, "an external event holds the send");
  const card = w2.kernel.tasks.find(t => t.form && t.form.kind === "held_act");
  assert.match(card.form.why, /outside this Space/);
  w2.kernel.completeTask(card.id, { outcome: "approved" });
  await settle(w2);
  assert.equal(sends.length, 2);
  const runs = await w2.runner.listRuns({ flow: id });
  assert.equal(runs.filter(r => r.tainted).length, 1);
});

test("runner: a model-drafted Flow with a destination read from records asks on every run", async () => {
  const sends = [];
  const w = await world({ ports: { call: async (c, a, r, input) => { sends.push(input.to); return {}; } } });
  w.kernel.rules.push({ match: i => i.action === "email.send" && !i.approval, effect: "allow", reason: "a standing yes" });
  const flow = flowOf([{ id: "m", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: { expr: "trigger.email" }, body: "hi" } }], { authorship: "model" });
  await install(w, flow);
  w.kernel.inbound("payment.received", { email: "x@example.com" });
  await settle(w);
  assert.equal(sends.length, 0);
  const card = w.kernel.tasks.find(t => t.form && t.form.kind === "held_act");
  assert.match(card.form.why, /a model drafted this Flow/);
  w.kernel.completeTask(card.id, { outcome: "approved" });
  await settle(w);
  assert.deepEqual(sends, ["x@example.com"]);
});

test("runner: wait for a time, wait for an event with a timeout, and time triggers fire once", async () => {
  const w = await world();
  const wf = await install(w, flowOf([
    { id: "w1", kind: "wait", for_ms: 3_600_000 },
    { id: "c1", kind: "create", type: "matter", set: { client: "after an hour" } },
    { id: "w2", kind: "wait", event: "document.signed", where: "event.data.matter == trigger.m", timeout_ms: 7_200_000, on_timeout: "continue" },
    { id: "d", kind: "decide", if: "steps.w2.timed_out == true", then: [{ id: "c2", kind: "create", type: "matter", set: { client: "timed out" } }], else: [{ id: "c3", kind: "create", type: "matter", set: { client: "signed" } }] },
  ]));
  void wf;
  assert.equal((await w.runner.nextWake()), null);
  w.kernel.inbound("payment.received", { m: "M1" });
  await settle(w);
  assert.equal(mine(w, "matter").length, 0);
  assert.equal(await w.runner.nextWake(), w.clock.t + 3_600_000);
  w.advance(3_600_001); await w.runner.tick(); await settle(w);
  assert.equal(mine(w, "matter").length, 1);
});
