// @ts-check
// Draft persistence (Paseo's input/state.ts): what you were mid-typing survives a thread switch
// (a fresh mountComposer for the same thread) and a reload (the localStorage-backed store), and
// goes away once the words are actually sent. Sample world only, real random thread ids per test
// so this file never collides with another test's drafts in the same localStorage.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});

const { mountComposer } = await import("./composer.js");
const thread = () => "draft-test-" + Math.random().toString(36).slice(2);

test("typing is restored in a fresh composer for the same thread, and clears once sent", async () => {
  const t = thread();
  const a = mountComposer({ thread: t });
  a.input.value = "half a thought about the ";
  a.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
  await new Promise(r => setTimeout(r, 220)); // past the 200 ms debounce
  a.stop();

  const b = mountComposer({ thread: t });
  assert.equal(b.value(), "half a thought about the ", "a fresh box for the same thread starts with the unsent draft");
  b.setText("");
  b.stop();

  const c = mountComposer({ thread: t });
  assert.equal(c.value(), "", "cleared: a later box for the same thread starts empty again");
  c.stop();
});

test("a thread switch mid-key (before the debounce fires) still keeps the draft: stop() flushes it", async () => {
  const t = thread();
  const a = mountComposer({ thread: t });
  a.input.value = "no time to debounce";
  a.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
  a.stop(); // no wait: this is the case a debounced-only save would lose

  const b = mountComposer({ thread: t });
  assert.equal(b.value(), "no time to debounce");
  b.stop();
});

test("two threads keep their own drafts", async () => {
  const t1 = thread(), t2 = thread();
  const a = mountComposer({ thread: t1 });
  a.input.value = "for thread one";
  a.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
  a.stop();
  const b = mountComposer({ thread: t2 });
  assert.equal(b.value(), "", "a different thread has no draft of its own");
  b.stop();
  const a2 = mountComposer({ thread: t1 });
  assert.equal(a2.value(), "for thread one");
  a2.stop();
});
