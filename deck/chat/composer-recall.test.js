// @ts-check
// "From your past sessions" (recall.related, debounced while typing in a project): up to 3 quiet
// rows above the composer with a snippet, "you said"/"you were told", when, and a tap that hands
// the hit to onRecall (opening and rendering it is the caller's job, chat's). Dismisses easily
// (its own close button, or Esc first), never steals focus (nothing here calls .focus()), hides
// when there is nothing to show. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, $$, text } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});

/** @type {any} */ let relatedAnswer = { hits: [] };
/** @type {any[]} */ let relatedCalls = [];
globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1] || "");
  if (tool === "recall.related") { relatedCalls.push(JSON.parse(o.body)); return { status: 200, statusText: "", json: async () => ({ data: relatedAnswer }) }; }
  return { status: 200, statusText: "", json: async () => ({ data: {} }) };
});

const { mountComposer } = await import("./composer.js");
const thread = () => "recall-test-" + Math.random().toString(36).slice(2);
const tick = (ms = 420) => new Promise(r => setTimeout(r, ms)); // past the 350 ms debounce

/** @param {any} c @param {string} v */
function type(c, v) { c.input.value = v; c.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input")); }

const HIT = { session: "s1", seq: 4, role: "user", ts: Date.now() - 3 * 3_600_000, name: "Harlow order form", title: null, cwd: "/home/alex/work/harlow", snippet: "the deadline is Friday" };

test("enough text, a project, and onRecall: recall.related is called after the debounce, up to 3 rows drawn", async () => {
  relatedCalls = [];
  relatedAnswer = { hits: [HIT, { ...HIT, session: "s2", role: "assistant", snippet: "moved it to Friday" }] };
  const found = /** @type {any[]} */ ([]);
  const c = mountComposer({ thread: thread(), cwd: () => "/home/alex/work/harlow", onRecall: hit => found.push(hit) });
  type(c, "what did we say about the deadline");
  await tick();
  assert.equal(relatedCalls.length, 1);
  assert.deepEqual(relatedCalls[0], { project_cwds: ["/home/alex/work/harlow"], text: "what did we say about the deadline", limit: 3 });
  const rows = $$(c.el, ".composer-hint-row");
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /the deadline is Friday/);
  assert.match(text(rows[0]), /you said/);
  assert.match(text(rows[1]), /you were told/);
  rows[0].click();
  assert.deepEqual(found, [HIT]);
  c.stop();
});

test("short text never asks; no onRecall never asks either", async () => {
  relatedCalls = [];
  const withRecall = mountComposer({ thread: thread(), cwd: () => "/home/alex/work/harlow", onRecall: () => {} });
  type(withRecall, "too short");
  await tick();
  assert.equal(relatedCalls.length, 0, "under 12 characters: no call");
  withRecall.stop();

  const bare = mountComposer({ thread: thread(), cwd: () => "/home/alex/work/harlow" });
  type(bare, "plenty of characters here to ask about");
  await tick();
  assert.equal(relatedCalls.length, 0, "no onRecall: the feature is entirely inert");
  bare.stop();
});

test("a command ('/...') never asks, even with plenty of text", async () => {
  relatedCalls = [];
  const c = mountComposer({ thread: thread(), cwd: () => "/home/alex/work/harlow", onRecall: () => {} });
  type(c, "/find something long enough to pass the length check");
  await tick();
  assert.equal(relatedCalls.length, 0);
  c.stop();
});

test("no hits hides your server; dismissing (its own close, or Esc) hides it and it stays hidden until your server empties", async () => {
  relatedAnswer = { hits: [] };
  const c = mountComposer({ thread: thread(), cwd: () => "/home/alex/work/harlow", onRecall: () => {} });
  type(c, "nothing relevant was ever said about this");
  await tick();
  assert.equal($(c.el, ".composer-hints").hidden, true, "hits:[] hides it");

  relatedAnswer = { hits: [HIT] };
  type(c, "nothing relevant was ever said about this one either");
  await tick();
  assert.equal($(c.el, ".composer-hints").hidden, false);
  $(c.el, ".composer-hints-close").click();
  assert.equal($(c.el, ".composer-hints").hidden, true);

  type(c, "nothing relevant was ever said about this one either, still typing");
  await tick();
  assert.equal($(c.el, ".composer-hints").hidden, true, "dismissed for this compose: typing more does not bring it back");

  c.setText("");
  type(c, "a brand new thought entirely, once your server is empty again");
  await tick();
  assert.equal($(c.el, ".composer-hints").hidden, false, "a fresh compose (your server went empty) gets its own hint again");
  c.stop();
});

test("Esc dismisses the hint before anything else your server's own Esc would do", async () => {
  relatedAnswer = { hits: [HIT] };
  const c = mountComposer({ thread: thread(), cwd: () => "/home/alex/work/harlow", onRecall: () => {} });
  type(c, "something worth asking recall.related about");
  await tick();
  assert.equal($(c.el, ".composer-hints").hidden, false);
  const handled = c.key(/** @type {any} */ ({ key: "Escape" }));
  assert.equal(handled, true);
  assert.equal($(c.el, ".composer-hints").hidden, true);
  assert.equal(c.value(), "something worth asking recall.related about", "Esc dismissed the hint, not the typed words");
  c.stop();
});
