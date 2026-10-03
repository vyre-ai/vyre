import test from "node:test";
import assert from "node:assert/strict";
import { TRIGGER_REGISTRY, TRIGGER_ONS, kindOf, describeTrigger, whyRan, recordTrigger, scrubInput } from "./triggers.js";
import { checkFlow } from "./schema.js";
import { compileFlow, nextCron } from "./compile.js";
import { paintRun } from "./canvas.js";
import { printFlow, parseFlowText } from "./text.js";
import { world, install, settle, ALEX } from "./testing/world.js";
import { catalog, onPayment } from "./testing/fixtures.js";
import { FlowRunner } from "./runner.js";
import { bridgeWatchers } from "./watcher-bridge.js";

const step = { id: "open", kind: "create", type: "payment", set: { client: { expr: "trigger.who" }, amount: 1 } };
const flow = (trigger, extra = {}) => ({ format: 1, name: "t_flow", label: "T", authorship: "human", trigger, steps: [step], ...extra });
const DAY = 86_400_000, MIN = 60_000;

// ---- the registry ----
test("registry: five kinds and no others, each covering its stored forms; an unknown trigger is refused", () => {
  assert.deepEqual(Object.keys(TRIGGER_REGISTRY).sort(), ["form", "person", "record", "schedule", "watcher"]);
  assert.deepEqual([...TRIGGER_ONS].sort(), ["event", "manual", "stage", "time", "watcher", "web"]);
  const cases = [
    { on: "watcher", watcher: "harlow-mail" }, { on: "time", cron: "15 7 * * 1-5", tz: "America/Los_Angeles" }, { on: "event", event: "payment.received" },
    { on: "stage", type: "matter", stage: "Intake" }, { on: "web", path: "intake-form" }, { on: "manual" },
  ];
  for (const t of cases) {
    assert.deepEqual(checkFlow(flow(t)), [], JSON.stringify(t));
    assert.ok(kindOf(t), t.on);
    assert.ok(describeTrigger(t).length > 3);
    assert.deepEqual(parseFlowText(printFlow(flow(t)), { handlers: {} }).problems ?? [], [], `${t.on} survives the text form`);
  }
  const bad = checkFlow(flow({ on: "carrier-pigeon" }));
  assert.match(bad[0].message, /a trigger is one of/);
  assert.ok(checkFlow(flow({ on: "watcher" })).some(p => p.path === "trigger.watcher"), "a watcher needs a name");
  assert.ok(checkFlow(flow({ on: "watcher", watcher: "Bad Name!" })).some(p => p.path === "trigger.watcher"));
  assert.ok(checkFlow(flow({ on: "time", every_ms: 300000, tz: "UTC" })).some(p => p.path === "trigger.tz"), "a zone goes with a cron");
  assert.ok(checkFlow(flow({ on: "time", cron: "0 7 * * *", tz: "Mars/Olympus" })).some(p => p.path === "trigger.tz"));
  assert.ok(checkFlow(flow({ on: "web", path: "Bad Path" })).some(p => p.path === "trigger.path"));
});

test("registry: a watcher's item is readable in the Flow as trigger.item, and an unknown name is a compile error", () => {
  const cat = catalog();
  const ok = compileFlow(flow({ on: "watcher", watcher: "harlow-mail", where: "trigger.item.about == \"court\"" }, { steps: [{ id: "open", kind: "create", type: "payment", set: { client: { expr: "trigger.item.about" } } }] }), cat);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const bad = compileFlow(flow({ on: "watcher", watcher: "harlow-mail", where: "nothing.here == 1" }), cat);
  assert.equal(bad.ok, false);
});

// ---- schedule in the Space's zone ----
const iso = ms => new Date(ms).toISOString().slice(0, 16) + "Z";
test("schedule: cron is read in the zone (07:15 on weekdays in Los Angeles), not in UTC", () => {
  const tz = "America/Los_Angeles";
  const a = nextCron("15 7 * * 1-5", Date.UTC(2026, 9, 5, 0, 0), tz);              // Mon 5 Oct 2026, PDT = UTC-7
  assert.equal(iso(a), "2026-10-05T14:15Z");
  const sat = nextCron("15 7 * * 1-5", Date.UTC(2026, 9, 9, 15, 0), tz);            // after Fri 07:15 -> Monday
  assert.equal(iso(sat), "2026-10-12T14:15Z");
  assert.equal(iso(nextCron("15 7 * * 1-5", Date.UTC(2026, 9, 5, 0, 0))), "2026-10-05T07:15Z", "UTC when no zone");
});
test("schedule: spring forward runs a time that does not exist once, at the first real minute after the gap, and never twice", () => {
  const tz = "America/New_York";                                                      // 8 Mar 2026: 02:00 EST jumps to 03:00 EDT (07:00Z)
  const before = Date.UTC(2026, 2, 8, 6, 0);                                         // 01:00 EST
  const first = nextCron("30 2 * * *", before, tz);
  assert.equal(iso(first), "2026-03-08T07:00Z", "02:30 does not exist: it runs at 03:00 EDT");
  const second = nextCron("30 2 * * *", first, tz);
  assert.equal(iso(second), "2026-03-09T06:30Z", "the next day it is 02:30 EDT as usual");
  const both = nextCron("0,30 2 * * *", before, tz); assert.equal(both, first);
  assert.equal(iso(nextCron("0,30 2 * * *", first, tz)), "2026-03-09T06:00Z", "02:00 and 02:30 in the gap are one run, not two");
});
test("schedule: fall back runs a time that happens twice once, the first time", () => {
  const tz = "America/New_York";                                                      // 1 Nov 2026: 02:00 EDT falls back to 01:00 EST
  const first = nextCron("30 1 * * *", Date.UTC(2026, 10, 1, 4, 0), tz);
  assert.equal(iso(first), "2026-11-01T05:30Z", "the first 01:30 (EDT)");
  assert.equal(iso(nextCron("30 1 * * *", first, tz)), "2026-11-02T06:30Z", "not the second 01:30 (EST, 06:30Z): the next is tomorrow");
});

// ---- the runner: schedule survives a restart and catches up once ----
async function scheduled(w, trigger) {
  const f = flow(trigger, { steps: [{ id: "open", kind: "create", type: "payment", set: { client: "tick", amount: 1 } }] });
  return install(w, f);
}
test("schedule: the Space's zone comes from the catalog; the run record says which trigger fired", async () => {
  const w = await world({ cat: { ...catalog(), tz: "America/Los_Angeles" } });
  await scheduled(w, { on: "time", cron: "15 7 * * 1-5" });
  await w.runner.tick();                                          // first sight: counting starts now
  const wake = await w.runner.nextWake();
  assert.equal(iso(wake), "2026-10-05T14:15Z", "Mon 07:15 PDT, from a clock of Sat 3 Oct 12:00Z");
  w.clock.t = wake + 5_000; await w.runner.tick(); await w.runner.drain();
  const [run] = await w.store.listRuns({});
  assert.equal(run.trigger.kind, "time"); assert.equal(run.trigger.source, "schedule:cron 15 7 * * 1-5"); assert.equal(run.trigger.tz, "America/Los_Angeles");
  assert.equal(run.trigger.caught_up, undefined, "on time is not a catch-up");
});
test("schedule: a restart remembers when it last ran, and catches up ONCE for any number of missed ticks", async () => {
  const w = await world();
  await scheduled(w, { on: "time", cron: "*/15 * * * *" });
  await w.runner.tick();
  w.advance(20 * MIN); await w.runner.tick(); await w.runner.drain();
  assert.equal((await w.store.listRuns({})).length, 1, "one tick, one run");
  // the server goes down for six hours; a NEW runner on the same store comes up (a restart)
  const runner2 = new FlowRunner({ kernel: w.kernel, store: w.store, catalog: () => w.cat, chains: { forFlow: x => w.kernel.chainFor(x) }, clock: () => w.clock.t, emit: () => {}, ports: {} });
  w.advance(6 * 60 * MIN);
  await runner2.tick(); await runner2.drain();
  const runs = await w.store.listRuns({});
  assert.equal(runs.length, 2, "one catch-up run, not twenty-four");
  const [late] = runs;
  assert.equal(late.trigger.caught_up, true);
  assert.ok(late.trigger.missed >= 20 && late.trigger.missed <= 24, `it says how many it skipped (${late.trigger.missed})`);
  assert.match(whyRan(late.trigger), /server had been off/);
  await runner2.tick(); await runner2.drain();
  assert.equal((await w.store.listRuns({})).length, 2, "and it carries on from now: no second catch-up");
});
test("schedule: a Flow that did not exist yet is not run retroactively, and nothing is due until its time", async () => {
  const w = await world();
  await scheduled(w, { on: "time", every_ms: 10 * MIN });
  await w.runner.tick(); await w.runner.drain();
  assert.equal((await w.store.listRuns({})).length, 0);
  w.advance(9 * MIN); await w.runner.tick(); assert.equal((await w.store.listRuns({})).length, 0);
  assert.ok((await w.runner.nextWake()) >= w.clock.t, "the host's timer is never set in the past");
});

// ---- watcher ----
test("watcher: an item starts the Flows armed on that watcher, once per item, tainted, with the item as trigger.item", async () => {
  const w = await world();
  const f = flow({ on: "watcher", watcher: "harlow-mail", where: "trigger.item.about != \"newsletter\"" }, { steps: [{ id: "open", kind: "create", type: "payment", set: { client: { expr: "trigger.item.about" }, amount: 1 } }] });
  await install(w, f);
  await install(w, { ...f, name: "other_flow", trigger: { on: "watcher", watcher: "harlow-folder" } });
  const item = { id: "m1", title: "Court: hearing moved", about: "court", quote: "the hearing is now at 10", at: 1 };
  const r1 = await w.runner.watcherItem({ watcher: "harlow-mail", item });
  assert.equal(r1.length, 1, "only the Flow armed on this watcher");
  await w.runner.drain();
  const run = await w.runner.getRun(r1[0].run);
  assert.equal(run.state, "done");
  assert.equal(run.tainted, true, "an item from outside is data: the run is tainted");
  assert.deepEqual([run.trigger.kind, run.trigger.source], ["watcher", "watcher:harlow-mail"]);
  assert.equal(run.trigger.input.title, "Court: hearing moved");
  assert.equal(w.kernel.calls.some(c => c[0] === "create" && c[1] === "payment" && c[2].client === "court"), true, "the item reached the step as trigger.item");
  assert.equal((await w.runner.watcherItem({ watcher: "harlow-mail", item }))[0].duplicate, true, "the same item twice is the same run");
  assert.deepEqual(await w.runner.watcherItem({ watcher: "harlow-mail", item: { id: "m2", about: "newsletter" } }), [], "the where filter holds");
  await assert.rejects(() => w.runner.watcherItem({ watcher: "x", item: null }), { code: "bad_input" });
  assert.match(whyRan(run.trigger), /watcher harlow-mail found something new \(Court: hearing moved\)/);
});
test("watcher bridge: watcher.fired reads the new items back through watchers.items and hands each to the runner, oldest first, once", async () => {
  const handlers = new Map(), calls = [], got = [];
  const stop = bridgeWatchers({
    runner: { watcherItem: async x => { got.push(x); } },
    on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); },
    call: async (tool, input) => { calls.push([tool, input]); return [{ id: "b", title: "B" }, { id: "a", title: "A" }]; },
  });
  await handlers.get("watcher.fired")({ name: "harlow-mail", items: 2 });
  assert.deepEqual(calls, [["watchers.items", { name: "harlow-mail", limit: 2 }]]);
  assert.deepEqual(got.map(g => g.item.id), ["a", "b"], "oldest first");
  assert.ok(got.every(g => g.watcher === "harlow-mail"));
  await handlers.get("watcher.fired")({ name: "harlow-mail", items: 2 });
  assert.equal(got.length, 2, "a redelivered event does not hand the same items over again");
  await handlers.get("watcher.fired")({ name: "harlow-mail", items: 0 }); assert.equal(calls.length, 2, "no new items, no call (the second call was the redelivery)");
  stop(); assert.equal(handlers.size, 0);
});

// ---- every run records which trigger fired, and with what ----
test("every kind records which trigger fired and with what, and paintRun answers 'why did this run'", async () => {
  const w = await world();
  const bodies = {
    event: { on: "event", event: "payment.received" }, stage: { on: "stage", type: "matter", stage: "Intake" }, web: { on: "web", path: "intake-form" }, manual: { on: "manual" },
  };
  const ids = {};
  for (const [k, t] of Object.entries(bodies)) ids[k] = (await install(w, flow(t, { name: `flow_${k}`, steps: [{ id: "open", kind: "create", type: "payment", set: { client: "x", amount: 1 } }] }))).id;
  w.kernel.inbound("payment.received", { amount: 5, who: "ann" });
  await settle(w);
  const event = (await w.store.listRuns({ flow: ids.event }))[0];
  assert.deepEqual([event.trigger.kind, event.trigger.source], ["event", "record:payment.received"]);
  assert.equal(event.trigger.event.type, "payment.received");
  w.kernel.emit("record.stage-entered", { type: "matter", id: "m1", stage: "Intake" }, w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space }), "vyre://s/matter/m1");
  await settle(w);
  const stage = (await w.store.listRuns({ flow: ids.stage }))[0];
  assert.deepEqual([stage.trigger.kind, stage.trigger.source], ["stage", "record:matter enters Intake"]);
  await w.runner.handleWeb("intake-form", { body: { who: "jane", ssn: { sealed: "ssn", ref: "sv_1", present: true } }, key: "k1", trust: "external" });
  await w.runner.drain();
  const web = (await w.store.listRuns({ flow: ids.web }))[0];
  assert.deepEqual([web.trigger.kind, web.trigger.source, web.trigger.path], ["web", "web:/intake-form", "intake-form"]);
  assert.deepEqual(web.trigger.input.ssn, { sealed: true }, "a sealed value is never copied into the run record");
  assert.equal(web.trigger.input.who, "jane");
  await w.runner.start(ids.manual, { why: "test" }, w.kernel.chainFor({ flow: "p", approver: ALEX, tainted: false, space: w.cat.space }));
  await w.runner.drain();
  const man = (await w.store.listRuns({ flow: ids.manual }))[0];
  assert.deepEqual([man.trigger.kind, man.trigger.source], ["manual", "manual"]);
  // "why did this run" is one click: the trigger node of the painted run carries it
  const painted = paintRun(flow(bodies.web), web, w.cat);
  assert.match(painted.nodes[0].why, /Something called \/intake-form/);
  assert.equal(painted.nodes[0].fired.kind, "web");
  assert.match(painted.why, /intake-form/);
  assert.equal(painted.trigger.source, "web:/intake-form");
});

test("recordTrigger caps what it keeps and scrubs sealed values at any depth", () => {
  const big = { items: Array.from({ length: 50 }, (_, i) => ({ i, text: "x".repeat(1000) })) };
  assert.equal(scrubInput(big, 4096).truncated, true);
  assert.deepEqual(scrubInput({ a: { b: [{ s: { sealed: "ssn", ref: "sv_9" } }] } }), { a: { b: [{ s: { sealed: true } }] } });
  const r = recordTrigger({ on: "web", path: "p" }, { kind: "web", key: "k", input: { s: { sealed: "x" } }, path: "p" }, e => e);
  assert.deepEqual(r.input, { s: { sealed: true } });
  assert.equal(r.source, "web:/p");
});

test("schedule: the last run is kept as a record, so the same catch-up holds when the store is the kernel's", async () => {
  const w = await world({ store: "records" });
  await scheduled(w, { on: "time", cron: "*/15 * * * *" });
  await w.runner.tick();
  assert.equal(await w.store.getSchedule((await w.store.list())[0].id), w.clock.t, "first sight is written down");
  w.advance(20 * MIN); await w.runner.tick(); await w.runner.drain();
  const runner2 = new FlowRunner({ kernel: w.kernel, store: w.store, catalog: () => w.cat, chains: { forFlow: x => w.kernel.chainFor(x) }, clock: () => w.clock.t, emit: () => {}, ports: {} });
  w.advance(5 * 60 * MIN);
  await runner2.tick(); await runner2.drain();
  const runs = await w.store.listRuns({});
  assert.equal(runs.length, 2);
  assert.equal(runs[0].trigger.caught_up, true);
});
