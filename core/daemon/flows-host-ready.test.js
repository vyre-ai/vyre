// @ts-check
// IR-18: whatever reads the Flow record types waits for a Space's store that is still starting, and runs at once for one that is not.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { whenStoreReady } from "./flows-host.js";

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
