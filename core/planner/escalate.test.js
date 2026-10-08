// @ts-check
// Task escalation (SPEC-0.3.0 part 3): a task's escalate_after and escalate_to were stored and never read. The planner's one scheduler now reads them through a wake hook, so nothing here adds a timer.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, newKernel, prepareKernel, MIN, HOUR, T0, OWNER, SPACE, FACTS } from "./testing.js";

const person = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
const until = async (/** @type {() => any} */ fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise(r => setTimeout(r, 20)); } };

/** A planner world whose kernel keeps the planner's fake time, so a task's created_at is on the same clock the scheduler uses. */
async function rig(/** @type {any} */ t) {
  const clock = { t: T0 };
  const k = await newKernel(null, { clock: () => clock.t });
  await prepareKernel(k);
  const w = await world(t, { kernel: k });
  clock.t = w.clock.t;
  w.clock = new Proxy(w.clock, { set(o, key, v) { /** @type {any} */ (o)[key] = v; if (key === "t") clock.t = v; return true; } });
  const escalated = /** @type {any[]} */ ([]);
  w.events.on("planner.escalated", (/** @type {any} */ e) => escalated.push(e.payload));
  return { w, k, owner: k.chains.fromFacts(FACTS), escalated };
}

test("escalation: an unfinished task past escalate_after puts a to-do in front of escalate_to, once, on the planner's one timer", async t => {
  const { w, k, owner, escalated } = await rig(t);
  const task = await k.tasks.request(owner, { title: "File the Harlow motion", doer: person(OWNER), output: { kind: "note" }, escalate_after: 10 * MIN, escalate_to: person("per_member") });
  await w.handle.scheduler.tick();
  await w.handle.scheduler.arm();
  await w.advance(9 * MIN);
  assert.equal(escalated.length, 0, "not late yet");
  await w.advance(2 * MIN);
  const e = await until(() => escalated[0]);
  assert.deepEqual([e.task, e.doer, e.to, e.after_ms], [task.id, OWNER, "per_member", 10 * MIN]);
  const late = (await k.tasks.list(owner, {})).filter((/** @type {any} */ x) => x.title.startsWith("Late:"));
  assert.deepEqual(late.map((/** @type {any} */ x) => [x.title, x.doer.id, x.parent]), [["Late: File the Harlow motion", "per_member", task.id]]);
  await w.advance(3 * HOUR);
  assert.equal(escalated.length, 1, "once");
  assert.equal((await k.tasks.list(owner, {})).filter((/** @type {any} */ x) => x.title.startsWith("Late:")).length, 1);
  assert.equal(w.timers.size <= 1, true, "one timer, the scheduler's");
});

test("escalation: a task that is skipped before the time is never escalated, and a task with no escalate_to is left alone", async t => {
  const { w, k, owner, escalated } = await rig(t);
  const a = await k.tasks.request(owner, { title: "Call the court", doer: person(OWNER), output: { kind: "note" }, escalate_after: 10 * MIN, escalate_to: person("per_member") });
  await k.tasks.request(owner, { title: "Water the plants", doer: person(OWNER), output: { kind: "note" }, escalate_after: 10 * MIN });
  await w.handle.scheduler.tick();
  await k.tasks.skip(owner, a.id, "not needed");
  await w.advance(HOUR);
  assert.deepEqual(escalated, []);
});
