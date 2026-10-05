// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeferredStore, MAX_DEFS } from "./deferred-store.js";

const reason = () => "the store is starting";

test("deferred store: a definition made while the real store is attaching is applied, not dropped", async () => {
  const d = createDeferredStore({ reason });
  d.define({ n: 1 });
  d.define({ n: 2 });
  /** @type {any[]} */ const got = [];
  let late = false;
  const real = { async define(/** @type {any} */ diff) { got.push(diff.n); if (diff.n === 1 && !late) { late = true; await d.define({ n: 3 }); } await new Promise(r => setImmediate(r)); return { applied: true }; }, types: async () => [], health: async () => ({ ok: true }) };
  await d.attach(real);
  assert.deepEqual(got, [1, 2, 3], "every definition, including the one made during the replay, reached the real store in order");
  assert.equal(d.attached(), true);
  await d.define({ n: 4 });
  assert.deepEqual(got, [1, 2, 3, 4], "after attach everything forwards");
});

test("deferred store: the queue is capped while the store is away, and a define past it is refused in plain words", async () => {
  const d = createDeferredStore({ reason });
  for (let i = 0; i < MAX_DEFS; i++) await d.define({ n: i });
  await assert.rejects(() => d.define({ n: "over" }), e => /** @type {any} */ (e).code === "unavailable" && /too many changes are waiting/.test(/** @type {Error} */ (e).message));
  /** @type {any[]} */ const got = [];
  await d.attach({ define: async (/** @type {any} */ x) => { got.push(x.n); return {}; }, types: async () => [], health: async () => ({ ok: true }) });
  assert.equal(got.length, MAX_DEFS, "the queued ones were all applied; the refused one was not");
});

test("deferred store: after the kernel's start a define while away is refused, not queued", async () => {
  const d = createDeferredStore({ reason });
  d.bootDone();
  await assert.rejects(() => d.define({ n: 1 }), e => /** @type {any} */ (e).code === "unavailable");
});
