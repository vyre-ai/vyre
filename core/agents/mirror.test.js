// The agent records follow the roster, and a record store that is still starting is looked at again, not given up on.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMirror } from "./mirror.js";

const ROW = { uid: "agt_1", name: "research", kind: "agent", owner: "per_x", builtin: false, model: "", tags: "" };
const until = async (/** @type {() => boolean} */ f, /** @type {string} */ what) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > 5000) assert.fail(what); await new Promise(r => setTimeout(r, 10)); } };

test("a store that is away when the roster changes gets the agent records once it joins, with one line in the log", async () => {
  const lines = /** @type {string[]} */ ([]);
  let away = 3;
  const made = /** @type {any[]} */ ([]);
  const k = { serviceChain: () => ({}), records: {
    query: async () => { if (away-- > 0) throw Object.assign(new Error("the record store for this space is not available yet: the record store is still starting"), { code: "unavailable" }); return { rows: [] }; },
    create: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {any} */ d) => { made.push(d); return d; } } };
  const m = createMirror({ kernel: () => k, rows: () => [ROW], log: l => lines.push(l), retryMs: 5 });
  await m.schedule();
  assert.equal(made.length, 0, "the store was away");
  await until(() => made.length === 1, "the agent record to be made after the store joined");
  assert.equal(made[0].name, "research");
  assert.equal(lines.length, 1, "one line said so, not one for each look");
});

test("a failure that is not the store being away is said and not retried", async () => {
  const lines = /** @type {string[]} */ ([]);
  let calls = 0;
  const k = { serviceChain: () => ({}), records: { query: async () => { calls++; throw new Error("no such type agent"); } } };
  const m = createMirror({ kernel: () => k, rows: () => [ROW], log: l => lines.push(l), retryMs: 5 });
  await m.schedule();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(calls, 1);
  assert.match(lines[0], /did not follow the roster \(no such type agent\)/);
});
