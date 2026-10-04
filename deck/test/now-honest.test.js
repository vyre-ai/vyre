// @ts-check
// The Now page tells the truth (#44): running means a turn is in progress, every thread has a real title and the same avatar a chat wears
// everywhere, and a project's chat count counts its chats. Sample world only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
});
Object.defineProperty(globalThis, "history", { value: { state: null, pushState() {}, replaceState() {} }, configurable: true, writable: true });
const { isRunning, titleOf } = await import("../views/now.js");
const { chatCounts, chatsWord } = await import("../js/chat-counts.js");

test("running is a turn in progress: an idle thread is not running, however recently it spoke", () => {
  assert.equal(isRunning({ canonical_status: "working" }), true);
  assert.equal(isRunning({ canonical_status: "starting" }), true);
  assert.equal(isRunning({ canonical_status: "asking" }), true, "blocked on a question is still a turn in progress");
  for (const c of ["waiting", "paused", "stopped", "finished", "failed"]) assert.equal(isRunning({ canonical_status: c }), false, c);
  assert.equal(isRunning({ status: "idle" }), false, "older words: idle is ready for the next message");
  assert.equal(isRunning({ status: "working" }), true);
  assert.equal(isRunning({ status: "waiting" }), true, "older words: waiting is an open ask");
  assert.equal(isRunning({}), false);
});

test("a thread's title is its name or its first words, never its id, and 'New chat' when it has neither", () => {
  assert.equal(titleOf({ id: "a1", name: "Fix the footer" }), "Fix the footer");
  assert.equal(titleOf({ id: "a1", label: "Intake form", turns: 2 }), "Intake form");
  assert.equal(titleOf({ id: "a1", name: "a1" }), "New chat");
  assert.equal(titleOf({ id: "9d0e4c1a-aaaa-bbbb-cccc-1234567890ab", name: "9d0e4c1a-aaaa-bbbb-cccc-1234567890ab" }), "New chat");
  assert.equal(titleOf({ id: "x" }), "New chat");
  assert.equal(titleOf({ id: "x", name: "  " , activity: "Writing the plan" }), "Writing the plan");
});

test("a project's chats are its indexed sessions and its running threads, each once", async () => {
  const attempt = /** @type {any} */ (async (/** @type {string} */ tool) => tool === "projects.catalog"
    ? { data: { sessions: [{ id: "s1", projects: ["test"] }, { id: "s2", projects: ["test", "other"] }, { id: "s3", projects: [] }] } }
    : { data: [{ id: "s2", project: "test" }, { id: "t9", project: "test" }, { id: "t8", project: null }] });
  const counts = await chatCounts(attempt);
  assert.equal(counts.get("test"), 3, "s1, s2 (once, though in both lists) and t9");
  assert.equal(counts.get("other"), 1);
  assert.equal(chatsWord({ slug: "test", threads: [] }, counts), "3 chats");
  assert.equal(chatsWord({ slug: "other" }, counts), "1 chat");
  assert.equal(chatsWord({ slug: "none", threads: 0 }, counts), "0 chats");
});
