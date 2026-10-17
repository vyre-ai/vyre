// @ts-check
// The end of a member's turn lend is called for the person whose turn it was, and a failure is logged, never thrown into the turn.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { endLends } from "./lend-end.js";

const tick = () => new Promise(r => setTimeout(r, 5));

test("it calls the vault for that person and thread, and for no one when nobody asked", async () => {
  const calls = /** @type {any[]} */ ([]);
  const sb = { deps: { call: async (/** @type {string} */ t, /** @type {any} */ i) => { calls.push([t, i]); return { data: { ended: 1 } }; }, log: () => {} } };
  endLends(sb, "t1", "per_bob");
  endLends(sb, "t1", null);
  endLends(sb, "t1", undefined);
  await tick();
  assert.deepEqual(calls, [["vault.me.mention.end", { asker: "per_bob", thread: "t1" }]]);
});

test("a refusal, a rejection and a throw are each logged, and none reaches the caller", async () => {
  const said = /** @type {string[]} */ ([]);
  const log = (/** @type {string} */ m) => said.push(m);
  endLends({ deps: { call: async () => ({ error: { code: "locked" } }), log } }, "t1", "per_bob");
  endLends({ deps: { call: async () => { throw new Error("boom"); }, log } }, "t2", "per_bob");
  endLends({ deps: { call: () => { throw new Error("sync boom"); }, log } }, "t3", "per_bob");
  await tick();
  assert.equal(said.length, 3, said.join(" | "));
  assert.ok(said[0].includes("t1") && said[0].includes("locked"));
  assert.ok(said[1].includes("boom") && said[2].includes("sync boom"));
  assert.ok(said.every(m => m.includes("expiry")), "each says the expiry is the backstop");
});
