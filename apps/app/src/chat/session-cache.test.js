// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { hasSessionCache, loadSessionCache, saveSessionCache } from "./session-cache.js";

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
