// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AGE_MS, keptKey, packKept, saidError, unpackKept, within } from "./kept.js";

test("a kept copy is per screen and per Space", () => {
  assert.equal(keptKey("flows", "s1"), "kept.flows.s1");
  assert.equal(keptKey("flows", null), "kept.flows.home");
});

test("a copy comes back until it is a week old, and a stranger's shape is not shown", () => {
  const raw = packKept([1, 2], () => 1000);
  assert.deepEqual(unpackKept(raw, () => 2000), [1, 2]);
  assert.equal(unpackKept(raw, () => 1000 + MAX_AGE_MS + 1), undefined);
  assert.equal(unpackKept({ v: 2, at: 1, value: [] }, () => 2), undefined);
  assert.equal(unpackKept(undefined), undefined);
});

test("a read that never answers ends in a plain sentence", async () => {
  await assert.rejects(within(new Promise(() => {}), 5), /taking too long/);
  assert.equal(await within(Promise.resolve(3), 50), 3);
  await assert.rejects(within(Promise.reject(new Error("no")), 50), /no/);
});

test("an error says its real reason, and a blank one says the fallback", () => {
  assert.equal(saidError(new Error("The box is asleep."), "x"), "The box is asleep.");
  assert.equal(saidError(new Error(""), "Flows did not answer."), "Flows did not answer.");
  assert.equal(saidError(undefined, "fb"), "fb");
});
