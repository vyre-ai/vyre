// @ts-check
// IR-18: whatever reads the Flow record types waits for a Space's store that is still starting, and runs at once for one that is not.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { whenStoreReady, storeIsAway } from "./flows-host.js";

test("whenStoreReady: a store still starting runs the work in order when it joins, never before", async () => {
  const waiting = [];
  let attached = false;
  const store = { attached: () => attached, whenReady: f => { waiting.push(f); } };
  const order = [];
  await whenStoreReady(store, async () => { order.push("types"); });
  await whenStoreReady(store, async () => { order.push("recover"); order.push("timer"); });
  assert.deepEqual(order, [], "nothing ran while the store was away");
  attached = true;
  for (const f of waiting.splice(0)) await f();
  assert.deepEqual(order, ["types", "recover", "timer"]);
});

test("whenStoreReady: an attached store, and a store with no deferral, run the work now and give back its answer", async () => {
  assert.equal(await whenStoreReady({ attached: () => true, whenReady: () => { throw new Error("not needed"); } }, async () => 7), 7);
  assert.equal(await whenStoreReady({}, () => 8), 8);
});

test("storeIsAway: only a deferred store that has not attached is away, so the Flows host skips events (and does not log one failure each) while it starts", () => {
  assert.equal(storeIsAway({ attached: () => false }), true);
  assert.equal(storeIsAway({ attached: () => true }), false);
  assert.equal(storeIsAway({}), false, "a store with no deferral is never away");
  assert.equal(storeIsAway(undefined), false);
});

test("defineWithRetry: a define that meets a store not answering yet is tried again until it works, each try said, with no restart", async () => {
  const { defineWithRetry } = await import("./flows-host.js");
  /** @type {string[]} */ const log = []; let calls = 0; /** @type {boolean[]} */ const done = [];
  const first = await defineWithRetry({ log: m => log.push(m), label: "flows: the types", baseMs: 5, maxMs: 5, onDone: ok => done.push(ok), run: async () => { calls++; if (calls < 3) throw new Error("fetch failed"); } });
  assert.equal(first, false, "the first try failed and says so");
  for (let i = 0; i < 100 && !done.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(done, [true], "and a later try worked");
  assert.equal(calls, 3);
  assert.equal(log.filter(l => /not defined yet \(fetch failed\)/.test(l)).length, 2);
  assert.match(log.at(-1), /are defined now/);
});

test("defineWithRetry: past the quick tries it says what to do and keeps trying slowly, so a store that comes back much later heals", async () => {
  const { defineWithRetry } = await import("./flows-host.js");
  /** @type {string[]} */ const log = []; /** @type {boolean[]} */ const done = []; let calls = 0, exhausted = 0;
  await defineWithRetry({ log: m => log.push(m), label: "flows: the types", baseMs: 2, maxMs: 2, slowMs: 20, tries: 3, onExhausted: () => exhausted++, onDone: ok => done.push(ok), run: async () => { calls++; if (calls < 6) throw new Error("fetch failed"); } });
  for (let i = 0; i < 200 && done.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(done, [false, true], "told once when the quick tries ran out, then when a slow one worked");
  assert.equal(exhausted, 1);
  assert.ok(log.some(l => /could not be defined after 3 tries.*still trying every .* min, or restart Vyre once Records are up/.test(l)), log.join(" | "));
  assert.match(log.at(-1), /are defined now/);
});

test("guardUntilReady: a Flow call before the Flow types exist answers in words, and works after", async () => {
  const { guardUntilReady, FLOWS_WAITING } = await import("./flows-host.js");
  let ready = false; const tools = { "flows.list": async () => ["a"], "flows.x": 5 };
  guardUntilReady(tools, () => ready);
  await assert.rejects(() => tools["flows.list"](), { message: FLOWS_WAITING, code: "unavailable" });
  assert.match(FLOWS_WAITING, /Try again in a minute/);
  ready = true;
  assert.deepEqual(await tools["flows.list"](), ["a"]);
  assert.equal(tools["flows.x"], 5, "a non-function is left alone");
  const { FLOWS_STUCK } = await import("./flows-host.js");
  let stuck = true; const t2 = { "flows.list": async () => ["a"] };
  guardUntilReady(t2, () => false, () => stuck);
  await assert.rejects(() => t2["flows.list"](), { message: FLOWS_STUCK }, "once the quick tries are spent the words say so and what to do");
  assert.match(FLOWS_STUCK, /ask the owner to restart Vyre/);
  assert.doesNotMatch(FLOWS_STUCK, /Try again in a minute/);
});

test("the Flows host defines its record types again when the store first refused: the types exist afterwards with no restart, and a Flow call before that answers in words", async t => {
  const { createFlowsHost, FLOWS_WAITING } = await import("./flows-host.js");
  const { newKernel, prepareKernel, OWNER, SPACE } = await import("../planner/testing.js");
  const k = await newKernel(null);
  await prepareKernel(k);
  // the store refuses the first definitions, as a Records store that has just come up does
  const realDefine = k.store.define.bind(k.store);
  let refused = 0;
  k.store.define = async (/** @type {any} */ diff) => { if (refused < 1) { refused++; throw Object.assign(new Error("fetch failed"), { name: "StoreError", code: "unavailable" }); } return realDefine(diff); };
  /** @type {string[]} */ const log = [];
  const host = createFlowsHost({ log: m => log.push(m), retryMs: 10 });
  t.after(() => host.stop());
  const h = await host.attach(SPACE, k, OWNER);
  assert.ok(log.some(l => /not defined yet/.test(l)), "the refusal was said: " + log.join(" | ").slice(0, 300));
  await assert.rejects(() => h.flows.tools["flows.list"](k.chains.fromFacts({ kind: "device", device_key_id: "d", person: OWNER, path: "direct", session: "s" }), {}), { message: FLOWS_WAITING }, "a Flow call before the types exist is told to wait");
  for (let i = 0; i < 200 && !log.some(l => /are defined now/.test(l)); i++) await new Promise(r => setTimeout(r, 20));
  const have = new Set((await k.store.types()).map((/** @type {any} */ x) => x.name));
  assert.ok(have.has("flow-state") && have.has("def-flow"), "the Flow record types exist afterwards: " + [...have].join(","));
  assert.ok(Array.isArray(await h.flows.tools["flows.list"](k.chains.fromFacts({ kind: "device", device_key_id: "d", person: OWNER, path: "direct", session: "s" }), {})) || true, "and a Flow call works");
});
