// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createDoor, LOCKOUT, Bucket } from "./token-door.js";

test("a source that sends five wrong tokens in ten minutes is locked out for ten, and a right token clears the count", () => {
  let t = 1_000_000;
  const door = createDoor({ now: () => t });
  assert.deepEqual(door.admit("a"), { ok: true });
  for (let i = 0; i < LOCKOUT.bad - 1; i++) door.miss("a");
  assert.equal(door.admit("a").ok, true, "four misses are not yet a lock-out");
  door.clear("a");
  for (let i = 0; i < LOCKOUT.bad - 1; i++) door.miss("a");
  assert.equal(door.admit("a").ok, true, "a right token cleared the count");
  door.miss("a");
  assert.deepEqual(door.admit("a"), { ok: false, status: 429, why: "locked out" });
  assert.equal(door.admit("b").ok, true, "another source is not locked");
  t += LOCKOUT.forMs + 1;
  assert.equal(door.admit("a").ok, true, "the lock-out ends");
  door.miss("a"); t += LOCKOUT.windowMs + 1; for (let i = 0; i < LOCKOUT.bad - 1; i++) door.miss("a");
  assert.equal(door.admit("a").ok, true, "misses older than the window do not add up");
});

test("a source and a credential each have a bucket that refills with the clock", () => {
  let t = 0;
  const door = createDoor({ now: () => t, perSource: 3 });
  assert.deepEqual([1, 2, 3, 4].map(() => door.admit("s").ok), [true, true, true, false]);
  t += 20_000;
  assert.equal(door.admit("s").ok, true, "three a minute refills one in twenty seconds");
  assert.deepEqual([1, 2, 3].map(() => door.credit("k", 2)), [true, true, false]);
  door.forget("k");
  assert.equal(door.credit("k", 2), true);
  const b = new Bucket(1, 60, () => t);
  assert.ok(b.take() && !b.take());
});
