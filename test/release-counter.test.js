// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseCounter } from "../scripts/release-counter.mjs";

test("release counter: it orders exactly as semver does, a prerelease below its release, and never repeats", () => {
  const order = ["0.2.2", "0.2.3-beta.1", "0.2.3-beta.2", "0.2.3-rc.1", "0.2.3-rc.2", "0.2.3", "0.2.4-rc.1", "0.2.4", "0.3.0-beta.1", "0.3.0-rc.1", "0.3.0", "0.3.1", "0.10.0", "1.0.0-rc.1", "1.0.0"];
  const counters = order.map(releaseCounter);
  for (let i = 1; i < counters.length; i++) assert.ok(counters[i] > counters[i - 1], `${order[i]} (${counters[i]}) must be above ${order[i - 1]} (${counters[i - 1]})`);
  assert.equal(new Set(counters).size, counters.length);
  assert.equal(releaseCounter("v0.3.0"), releaseCounter("0.3.0"));
});

test("release counter: a version it cannot number is refused, not numbered wrongly", () => {
  for (const v of ["0.3", "0.3.0-alpha.1", "0.3.0-rc.0", "0.3.0-rc.40", "1000.0.0", "x"]) assert.throws(() => releaseCounter(v), v);
});
