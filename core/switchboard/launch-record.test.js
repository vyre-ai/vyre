// @ts-check
// What a thread's saved launch record can hold. A member's own key is lent for ONE turn (vault.me.lend, via member-key.js), put in the spawn environment of that one process and moved to a private
// descriptor by spawn.js; none of it is written to threads_runs. The launch options kept with a thread are an allow-list (KEPT): the environment, a key, a token or a credential is not on it, and the
// account run's own shape carries ids only. A name that could carry a value joining the list fails this test.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { KEPT } from "./index.js";

test("the launch options kept with a thread name no environment, key, token, secret or credential", () => {
  assert.ok(Array.isArray(KEPT) && KEPT.length > 0);
  for (const name of KEPT) assert.doesNotMatch(String(name), /env|key|token|secret|credential|password|auth/i, `${name} could carry a value into threads_runs.opts`);
  assert.ok(!KEPT.includes("env") && !KEPT.includes("fallback"), "the spawn environment and the fallback credential are never saved");
});
