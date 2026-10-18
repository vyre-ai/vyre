import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { retryWhileAway, storeAway, whenStoreJoins } from "./retry-away.js";

// (the pauses are unref'd timers, as on a server where other work keeps the process alive: the tests hold it open themselves)
const hold = () => { const t = setInterval(() => {}, 20); return () => clearInterval(t); };
const away = () => Object.assign(new Error("the record store for this space is not available yet: the record store is still starting"), { code: "unavailable" });

test("work that needs the store is tried again while the store is away, and gets its answer once it joins", async () => {
  let calls = 0;
  const release = hold();
  const r = await retryWhileAway(async () => { if (++calls < 4) throw away(); return "made"; }, { firstMs: 1, maxMs: 4 }).finally(release);
  assert.equal(r, "made");
  assert.equal(calls, 4);
});

test("any other failure is not retried, and a stop ends the waiting", async () => {
  let calls = 0;
  await assert.rejects(() => retryWhileAway(async () => { calls++; throw new Error("no such type"); }, { firstMs: 1 }), /no such type/);
  assert.equal(calls, 1);
  let stop = false;
  const release = hold();
  await assert.rejects(() => retryWhileAway(async () => { stop = calls++ > 2; throw away(); }, { firstMs: 1, maxMs: 2, stop: () => stop }).finally(release), /still starting/);
  assert.equal(storeAway(away()), true);
  assert.equal(storeAway(new Error("boom")), false);
  assert.equal(storeAway(undefined), false);
});

test("whenStoreJoins runs the work the moment a store that is still starting joins, once, and does nothing for one already attached", () => {
  const ready = /** @type {Array<() => void>} */ ([]);
  let attached = false, ran = 0;
  const store = { attached: () => attached, whenReady: (/** @type {() => void} */ f) => ready.push(f) };
  whenStoreJoins(store, () => { ran++; });
  assert.equal(ran, 0, "not before the store joins");
  attached = true; for (const f of ready) f();
  assert.equal(ran, 1, "once, when it joins");
  whenStoreJoins(store, () => { ran++; });
  assert.equal(ran, 1, "an attached store: the caller's own first try covers it");
  whenStoreJoins({}, () => { ran++; }); whenStoreJoins(null, () => { ran++; });
  assert.equal(ran, 1, "a store without the hooks is left alone");
  whenStoreJoins({ attached: () => false, whenReady: (/** @type {() => void} */ f) => f() }, () => { throw new Error("boom"); });
});
