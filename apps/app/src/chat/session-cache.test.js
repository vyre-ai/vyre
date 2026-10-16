// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { clearAllSessionCaches, hasSessionCache, loadSessionCache, saveSessionCache } from "./session-cache.js";

test("session cache round-trips frames in localStorage", () => {
  const mem = new Map();
  const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const g = globalThis;
  const prev = g.localStorage;
  g.localStorage = ls;
  try {
    assert.equal(hasSessionCache("chat_1"), false);
    saveSessionCache("chat_1", { head: 3, frames: [{ cur: 1, type: "chat.user-message" }] });
    assert.equal(hasSessionCache("chat_1"), true);
    const c = loadSessionCache("chat_1");
    assert.equal(c.head, 3);
    assert.equal(c.frames.length, 1);
  } finally { g.localStorage = prev; }
});

test("clearAllSessionCaches removes every chat cache key", () => {
  const mem = new Map();
  const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, length: mem.size };
  const g = globalThis;
  const prev = g.localStorage;
  g.localStorage = ls;
  try {
    saveSessionCache("chat_a", { head: 1, frames: [] });
    saveSessionCache("chat_b", { head: 2, frames: [] });
    mem.set("other", "x");
    clearAllSessionCaches();
    assert.equal(hasSessionCache("chat_a"), false);
    assert.equal(hasSessionCache("chat_b"), false);
    assert.equal(mem.get("other"), "x");
  } finally { g.localStorage = prev; }
});
