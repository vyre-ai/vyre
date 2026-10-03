// @ts-check
// The one thread row (js/thread-row.js): emblem, title, last line, a stack of at most three participants, and the state as a word.

import test from "node:test";
import assert from "node:assert/strict";

async function load() {
  const { install, $, $$, text } = await import("./fake-dom.js");
  install();
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  /** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
  const mod = await import("../js/thread-row.js");
  return { ...mod, $, $$, text };
}

test("thread row: the person first, then each distinct agent, three at most", async () => {
  const { participantsOf } = await load();
  assert.deepEqual(participantsOf({ agent: "juno" }), [{ kind: "person" }, { kind: "who", id: "juno" }]);
  assert.deepEqual(participantsOf({ agent: "juno", participants: ["juno", "kit", "scout", "extra"] }).length, 3);
  assert.deepEqual(participantsOf({ human: false, agent: "kit" }), [{ kind: "who", id: "kit" }], "an agent's own thread has no person in it");
});

test("thread row: title, a last line with where it is, and the state in words, with no id", async () => {
  const { threadRow, $, text } = await load();
  const el = threadRow({ href: "/chat/t1", title: "Fix the footer", project: "acme", agent: "juno", where: "Acme", turns: 4, status: "running", asks: 0, at: Date.now() - 60000, thread: "t1" });
  assert.equal(el.getAttribute("href"), "/chat/t1");
  assert.ok(el.className.includes("thread-row") && el.className.includes("trow"));
  assert.equal(text($(el, ".trow-title")), "Fix the footer");
  assert.equal(text($(el, ".trow-last")), "Acme · 4 messages");
  assert.equal(text($(el, ".trow-run")), "Running");
  assert.doesNotMatch(text(el), /#t1|t1\b.*t1/);
  const needs = threadRow({ href: "/x", title: "T", asks: 2 });
  assert.equal(text($(needs, ".trow-needs")), "2 need you");
  assert.equal($(needs, ".trow-run"), null, "needs you outranks running");
  assert.equal(text($(threadRow({ href: "/x", title: "T" }), ".trow-last")), "No messages yet");
});
