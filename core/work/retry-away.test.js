import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { retryWhileAway, storeAway } from "./retry-away.js";

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
