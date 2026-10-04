// @ts-check
// "/find [words]" (a local command, nothing sent to the session): opts.onFind gets the words
// typed after the command name, or "" when there were none - the composer never sends the text.
// Sample world only.

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
const thread = () => "find-test-" + Math.random().toString(36).slice(2);

/** @param {string} text */
function typeAndEnter(composer, text) {
  composer.input.value = text;
  composer.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
  const e = Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Enter", target: composer.input });
  composer.input.dispatchEvent(e);
}

test("typing /find words and Enter calls onFind with the words, sends nothing", async () => {
  /** @type {string[]} */
  const found = [];
  const c = mountComposer({ thread: thread(), onFind: q => found.push(q) });
  typeAndEnter(c, "/find harlow retainer");
  assert.deepEqual(found, ["harlow retainer"]);
  assert.equal(c.value(), "", "the composer clears like any other local command");
  c.stop();
});

test("/find with no words calls onFind with an empty string", async () => {
  /** @type {string[]} */
  const found = [];
  const c = mountComposer({ thread: thread(), onFind: q => found.push(q) });
  typeAndEnter(c, "/find");
  assert.deepEqual(found, [""]);
  c.stop();
});

test("without onFind, /find is a silent no-op (an older or bare composer)", async () => {
  const c = mountComposer({ thread: thread() });
  typeAndEnter(c, "/find anything");
  assert.equal(c.value(), "", "still consumed as a local command, not sent as a message");
  c.stop();
});

test("typing its alias /search directly (not via the menu) still routes to onFind, not sent as a message", async () => {
  /** @type {string[]} */
  const found = [];
  const c = mountComposer({ thread: thread(), onFind: q => found.push(q) });
  typeAndEnter(c, "/search harlow retainer");
  assert.deepEqual(found, ["harlow retainer"], "the dispatch checks aliases, not just the canonical name");
  assert.equal(c.value(), "", "never sent as a literal chat message");
  c.stop();
});
