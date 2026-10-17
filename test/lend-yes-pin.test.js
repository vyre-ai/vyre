// @ts-check
// The two ends of her yes cannot drift: what the app signs for the lend (signOf "vault" over the fields) is exactly what the Vault rebuilds and checks (yesFields). One input, both functions.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signOf } from "../lib/one-yes-sign.js";
import { yesFields, OP } from "../core/vault/mention-yes.js";

const ASKER = "per_" + "b".repeat(26);

test("the fields the app signs are the fields the Vault checks, with and without an origin", () => {
  for (const input of [
    { id: "clio", thread: "thr_1", agent: "kit" },
    { id: "clio", thread: "thr_1", agent: "kit", origin: "https://app.clio.com" },
  ]) {
    const checked = yesFields(ASKER, input);
    // what the app puts in the signed fields (src/chat/lend-yes.ts): the four, and origin exactly when the tag names one
    const signedByApp = { asker: ASKER, id: input.id, thread: input.thread, agent: input.agent, ...(input.origin ? { origin: input.origin } : {}) };
    assert.deepEqual(signOf("vault", { op: OP, fields: signedByApp }), signOf("vault", { op: OP, fields: checked }));
    assert.equal(OP, "vault.me.mention.lend");
  }
});

test("an extra field the Vault would not check changes what is signed, so the app never adds one", () => {
  const input = { id: "clio", thread: "thr_1", agent: "kit" };
  const wider = { ...yesFields(ASKER, input), extra: "x" };
  assert.notDeepEqual(signOf("vault", { op: OP, fields: wider }), signOf("vault", { op: OP, fields: yesFields(ASKER, input) }));
});
