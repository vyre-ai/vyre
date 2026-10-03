import { test } from "node:test";
import assert from "node:assert/strict";
import { world, ALEX } from "./testing/world.js";
import { SPACE } from "./testing/fixtures.js";

const DAY = 86_400_000;
const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const flow = (steps, extra = {}) => ({ format: 1, name: "sim", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });

test("simulate: replays past events with actions stubbed and says what the Flow would have done", async () => {
  const w = await world();
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  w.kernel.rules.push({ match: i => i.action === "email.send", effect: "ask", reason: "needs_approval" });
  const t0 = w.clock.t;
  for (let i = 0; i < 14; i++) { w.advance(DAY); w.kernel.inbound("payment.received", { amount: i + 1, client: "C" + i }); }
  w.kernel.inbound("invoice.sent", {});
  const f = flow([
    { id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.client" } } },
    { id: "t", kind: "assign", to: "role:manager", title: "Look at it", output: { kind: "note" } },
    { id: "e", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com" } },
  ]);
  const before = { tasks: w.kernel.tasks.length, events: w.kernel.log.length };
  const r = await w.runner.simulate(f, { approver: ALEX, since: t0, until: w.clock.t });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.matched, 14);
  const inWindow = w.kernel.log.filter(e => e.time >= t0 && e.time <= w.clock.t && !/^actor\.|^member\./.test(e.type)).length;
  assert.equal(r.events_seen, inWindow, "every event in the window was looked at, 14 matched");
  assert.ok(r.events_seen >= 15);
  assert.equal(r.totals.asks, 14);
  assert.equal(r.totals.tasks, 14);
  assert.deepEqual(r.totals.writes, { matter: 14 });
  assert.deepEqual(r.totals.outward.map(o => [o.action, o.count]), [["email.send", 14]]);
  assert.match(r.summary, /would have run 14 times in 2 weeks and asked for 14 approvals/);
  assert.ok(r.cannot_prove.length >= 3);
  assert.equal(mine(w, "matter").length, 0, "nothing was written");
  assert.equal(w.kernel.tasks.length, before.tasks, "no task was made");
  assert.equal(w.kernel.log.length, before.events, "no event was written");
  assert.equal(w.emitted.length, 0, "no flow event was emitted");
});

test("simulate: a Flow that would hit a denial says it would pause, and a draft that does not compile is refused with reasons", async () => {
  const w = await world();
  for (let i = 0; i < 3; i++) w.kernel.inbound("payment.received", { client: "X" });
  w.kernel.denied.add("per_alex");
  const r = await w.runner.simulate(flow([{ id: "m", kind: "create", type: "matter", set: { client: "X" } }]), { approver: ALEX, events: w.kernel.log });
  assert.equal(r.totals.paused, 3);
  assert.match(r.summary, /3 would have paused/);
  const bad = await w.runner.simulate(flow([{ id: "m", kind: "create", type: "ghost", set: {} }]), { approver: ALEX });
  assert.equal(bad.ok, false);
});

test("simulate: reads are real, so a find sees today's data and the later steps follow it", async () => {
  const w = await world();
  const c = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  await w.kernel.records.create(c, "matter", { client: "Repeat" });
  w.kernel.inbound("payment.received", { client: "Repeat" });
  w.kernel.inbound("payment.received", { client: "New" });
  const r = await w.runner.simulate(flow([
    { id: "f", kind: "find", type: "matter", where: "record.client == trigger.client" },
    { id: "d", kind: "decide", if: "len(steps.f.rows) > 0", then: [{ id: "n", kind: "assign", to: "role:manager", title: "Repeat client", output: { kind: "note" } }] },
  ]), { approver: ALEX, events: w.kernel.log.filter(e => e.type === "payment.received") });
  assert.equal(r.totals.tasks, 1, "only the repeat client reaches the assign");
});

test("simulate: a cron Flow over a window counts its fire times, and a manual Flow uses the samples it is given", async () => {
  const w = await world();
  const t0 = Date.UTC(2026, 8, 1), t1 = Date.UTC(2026, 9, 1);
  const r = await w.runner.simulate({ format: 1, name: "n", authorship: "human", trigger: { on: "time", cron: "0 3 * * *" }, steps: [{ id: "m", kind: "create", type: "payment", set: { amount: 1 } }] }, { approver: ALEX, since: t0, until: t1 });
  assert.equal(r.matched, 30);
  assert.match(r.summary, /in 4 weeks|in 1 months?|in 4 weeks/);
  const m = await w.runner.simulate({ format: 1, name: "m", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "m", kind: "create", type: "payment", set: { amount: { expr: "trigger.n" } } }] }, { approver: ALEX, samples: [{ n: 1 }, { n: 2 }] });
  assert.equal(m.matched, 2);
});
