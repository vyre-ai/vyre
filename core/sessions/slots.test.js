// @ts-check
// The concurrency ledger alone: limits per project and for the box, a fair line, timeouts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Slots } from "./slots.js";

function ledger({ box = { teammate: 6, subagent: 8 }, project = {} } = {}) {
  const events = [];
  const s = new Slots({ limits: () => ({ box, project: p => project[p] || {} }), emit: (type, payload) => events.push({ type, ...payload }) });
  return { s, events };
}
const want = (kind, project, owner, key = owner) => ({ kind, project, owner, key });
const tick = () => new Promise(r => setImmediate(r));

test("slots: room is taken at once, the box limit makes the next one wait, a release lets it in", async () => {
  const { s, events } = ledger({ box: { teammate: 6, subagent: 2 } });
  const a = await s.take(want("subagent", "harlow-legal", "t1"));
  const b = await s.take(want("subagent", "harlow-legal", "t2"));
  let got = null;
  s.take(want("subagent", "harlow-legal", "t3")).then(x => { got = x; });
  await tick();
  assert.equal(got, null, "the third waits");
  assert.deepEqual(events.filter(e => e.type === "slot.queued").map(e => [e.owner, e.position]), [["t3", 1]]);
  s.release(a.id);
  await tick();
  assert.equal(got && got.owner, "t3");
  assert.equal(s.count("subagent"), 2);
  assert.ok(b.id);
});

test("slots: a project's own limit holds its subagents while another project runs", async () => {
  const { s } = ledger({ box: { teammate: 6, subagent: 8 }, project: { "northwind-bakery": { subagent: 1 } } });
  await s.take(want("subagent", "northwind-bakery", "t1"));
  let second = null;
  s.take(want("subagent", "northwind-bakery", "t2")).then(x => { second = x; });
  const other = await s.take(want("subagent", "harlow-legal", "t3"));
  await tick();
  assert.equal(second, null);
  assert.equal(other.project, "harlow-legal", "another project is not held up");
});

test("slots: the line is oldest first in a project and projects take turns across the box", async () => {
  const { s } = ledger({ box: { teammate: 6, subagent: 1 } });
  const first = await s.take(want("subagent", "a", "a0"));
  const order = [];
  for (const [p, o] of [["a", "a1"], ["a", "a2"], ["b", "b1"], ["b", "b2"]]) s.take(want("subagent", p, o)).then(x => { order.push(x.owner); s.release(x.id); });
  await tick();
  s.release(first.id);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(order, ["a1", "b1", "a2", "b2"], "round robin across projects, FIFO within one");
});

test("slots: a wait gives up after its timeout; an owner's release takes its slots and its place in line", async () => {
  const { s } = ledger({ box: { teammate: 1, subagent: 8 } });
  await s.take(want("teammate", "harlow-legal", "kit"));
  const awake = setTimeout(() => {}, 1000);                       // the ledger's own timers never hold a process open
  await assert.rejects(/** @type {Promise<any>} */ (s.take(want("teammate", "harlow-legal", "juno"), { timeoutMs: 30 })), { code: "slot_timeout" });
  const waiting = /** @type {Promise<any>} */ (s.take(want("teammate", "harlow-legal", "alex")));
  const cancelled = assert.rejects(waiting, { code: "slot_cancelled" });
  s.releaseOwner("alex");
  await cancelled;
  assert.equal(s.releaseOwner("kit"), 1);
  assert.equal(s.count("teammate"), 0);
  clearTimeout(awake);
  const nowait = s.take(want("teammate", "harlow-legal", "kit2"), { wait: false });
  assert.ok(nowait instanceof Promise, "room again");
});

test("slots: without waiting, a full box answers the position; the same key twice is one slot", async () => {
  const { s } = ledger({ box: { teammate: 6, subagent: 1 } });
  const a = await s.take(want("subagent", "p", "t1", "k1"));
  assert.equal((await s.take(want("subagent", "p", "t1", "k1"))).id, a.id);
  assert.deepEqual(s.take(want("subagent", "p", "t2"), { wait: false }), { queued: true, position: 1 });
  assert.equal(s.status().subagent.held, 1);
});
