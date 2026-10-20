// @ts-check
// The Flows store keeps the reads the host asks for again and again at start (runs in a state, active Flows) for 2 s and shares them, and a write drops them.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { RecordsFlowStore } from "./store.js";

function fake() {
  /** @type {any[]} */ const rows = [];
  const calls = { query: 0 };
  const records = {
    async query(/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ spec) {
      calls.query++; await new Promise(r => setTimeout(r, 5));
      const f = spec && spec.filter;
      return { rows: rows.filter(r => r.type === type && (!f || (f.and || [f]).every((/** @type {any} */ x) => r.data[x.field] === x.value))) };
    },
    async get() { return null },
    async create(/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ data) { const r = { id: `r${rows.length + 1}`, type, version: 1, data }; rows.push(r); return r; },
    async update() { return null; },
  };
  return { calls, store: new RecordsFlowStore({ kernel: { records }, chain: {}, space: "spc_test" }) };
}
const run = (/** @type {string} */ id, /** @type {string} */ state) => ({ id, flow: "f1", state, started_at: 1, updated_at: 1 });

test("runs asked for together are read once, and a write makes the next read fresh", async () => {
  const { calls, store } = fake();
  await store.putRun(/** @type {any} */ (run("run_a", "waiting")));
  const before = calls.query;
  const [a, b] = await Promise.all([store.listRuns({ state: "waiting", limit: 1000 }), store.listRuns({ state: "waiting", limit: 1000 })]);
  await store.listRuns({ state: "waiting", limit: 1000 });
  assert.equal(calls.query - before, 1, "one read for three asks");
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  a[0].state = "changed";
  assert.equal((await store.listRuns({ state: "waiting", limit: 1000 }))[0].state, "waiting", "a caller changing its copy does not change the kept one");
  await store.putRun(/** @type {any} */ (run("run_b", "waiting")));
  assert.equal((await store.listRuns({ state: "waiting", limit: 1000 })).length, 2, "after a write the read is fresh");
});
