import { test } from "node:test";
import assert from "node:assert/strict";
import { perfFlag } from "./flag.js";

function memory() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), m };
}

test("?perf=1 turns it on and keeps it for a launch with no query", () => {
  const s = memory();
  assert.equal(perfFlag("?perf=1", s), true);
  assert.equal(perfFlag("", s), true);
  assert.equal(perfFlag(undefined, s), true);
});

test("?perf=0 forgets it", () => {
  const s = memory();
  perfFlag("?perf=1", s);
  assert.equal(perfFlag("?perf=0", s), false);
  assert.equal(perfFlag("", s), false);
  assert.equal(s.m.size, 0);
});

test("off by default, and another value reads what was kept", () => {
  const s = memory();
  assert.equal(perfFlag("", s), false);
  assert.equal(perfFlag("?perf=yes", s), false);
  perfFlag("?perf=1", s);
  assert.equal(perfFlag("?perf=yes", s), true);
  assert.equal(perfFlag("", s), true);
});

test("storage that throws or is missing: the query decides this page", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(perfFlag("?perf=1", broken), true);
  assert.equal(perfFlag("", broken), false);
  assert.equal(perfFlag("?perf=1", undefined), true);
  assert.equal(perfFlag("", undefined), false);
});
