import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../kernel/index.js";
import { createDoor } from "../../kernel/door/door.js";
import { createSessionBudget } from "./budget.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const key = Buffer.alloc(32, 7);
const USD = 1_000_000;

function rig({ perCall = 0.6 * USD, limit = 1 * USD, hoursLimit = 10 } = {}) {
  let T = 1_800_000_000_000;
  const clock = () => T;
  const k = createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key, clock });
  const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  // the door: a declared budget over ai_spend, a fake sealer and a fake provider that says what each call cost
  const budget = k.limits.doorBudget({ limitOf: () => limit, estimate: () => perCall, cost: (_i, u) => u.cost_micro });
  const sealer = { detect: async ({ text }) => ({ text, found: [], ledger: [] }), endSession: async () => {} };
  const calls = [];
  const door = createDoor({ sealer, sinks: [], budget, drivers: { fake: { call: async () => { calls.push(1); return { content: "ok", usage: { cost_micro: perCall } }; } } } });
  const stopped = [];
  const meter = createSessionBudget({ space: SPACE, limits: k.limits, ask: k.tasks, limitsOf: () => ({ limit_hours: hoursLimit, max_hours: 4 }), clock, stop: (s, why) => stopped.push([s, why]) });
  const say = session => door.call({ chain, purpose: "session", provider: "fake", model: "m", session, messages: [{ role: "user", content: "hi" }] });
  return { k, chain, meter, say, calls, stopped, tick: ms => { T += ms; } };
}

test("a 1 USD budget stops the session at the limit with budget_exhausted and raises a task for the person", async () => {
  const r = rig();
  await r.meter.start({ chain: r.chain, session: "s1", person: OWNER });
  assert.equal((await r.meter.turn({ chain: r.chain, session: "s1", person: OWNER }, () => r.say("s1"))).content, "ok");
  assert.equal(r.k.limits.used(OWNER, "ai_spend").settled, 0.6 * USD, "the real cost was settled");
  await assert.rejects(() => r.meter.turn({ chain: r.chain, session: "s1", person: OWNER }, () => r.say("s1")), { code: "budget_exhausted" });
  assert.equal(r.calls.length, 1, "the second call never reached the provider");
  assert.deepEqual(r.stopped, [["s1", "budget_exhausted"]]);
  const mine = await r.k.tasks.needsYou(r.chain);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].doer.id, OWNER);
  assert.match(mine[0].title, /stopped/);
  assert.equal(r.k.limits.used(OWNER, "session_hours").reserved, 0, "the hours reservation was settled when the session stopped");
});

test("session hours: reserved at start, settled with the hours run, and the person is told when they do not fit", async () => {
  const r = rig({ hoursLimit: 5 });
  await r.meter.start({ chain: r.chain, session: "a", person: OWNER });
  assert.equal(r.k.limits.used(OWNER, "session_hours").reserved, 4);
  r.tick(30 * 60_000);
  await r.meter.end({ chain: r.chain, session: "a" });
  assert.deepEqual(r.k.limits.used(OWNER, "session_hours"), { settled: 0.5, reserved: 0 });
  await r.meter.start({ chain: r.chain, session: "b", person: OWNER });          // 0.5 settled + 4 reserved fits in 5
  await assert.rejects(() => r.meter.start({ chain: r.chain, session: "c", person: OWNER }), { code: "budget_exhausted" });
  assert.equal((await r.k.tasks.needsYou(r.chain)).length, 1, "one task, in plain words");
  assert.equal(await r.meter.end({ chain: r.chain, session: "c" }), false, "a session that never started has nothing to settle");
});

test("a failed model call gives the reservation back; no limit set means nothing is counted", async () => {
  const r = rig();
  const bad = createDoor({ sealer: { detect: async ({ text }) => ({ text, found: [], ledger: [] }), endSession: async () => {} }, sinks: [], budget: r.k.limits.doorBudget({ limitOf: () => 1 * USD, estimate: () => 0.6 * USD }), drivers: { fake: { call: async () => { throw new Error("provider down"); } } } });
  await assert.rejects(() => bad.call({ chain: r.chain, purpose: "session", provider: "fake", model: "m", session: "x", messages: [{ role: "user", content: "hi" }] }));
  const none = createDoor({ sealer: { detect: async ({ text }) => ({ text, found: [], ledger: [] }), endSession: async () => {} }, sinks: [], budget: r.k.limits.doorBudget({ limitOf: () => undefined }), drivers: { fake: { call: async () => ({ content: "ok" }) } } });
  await none.call({ chain: r.chain, purpose: "session", provider: "fake", model: "m", session: "y", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(r.k.limits.used(OWNER, "ai_spend"), { settled: 0, reserved: 0 });
});
