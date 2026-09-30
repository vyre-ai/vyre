// @ts-check
// "/goal <goal>" (a local command that then builds a milestone list): Enter adds the title, then
// a milestone at a time; Cmd+Enter (or the "Set goal" chip) sends one message with the title and
// a numbered milestone list; Esc cancels. The engine (tracking it, notifying on each milestone) is
// sessions' - this only builds and sends the message. Sample world only.

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

// A bare fetch stub: finishGoal() sends a real message (threads.send) and typing leases the
// thread (threads.lease). Without this, a relative-URL fetch never settles and the test process
// never exits. Every call answers fast and generic - this test only checks composer state, never
// what reached the wire.
globalThis.fetch = /** @type {any} */ (async () => ({ status: 200, statusText: "", json: async () => ({ data: {} }) }));

const { mountComposer } = await import("./composer.js");
const thread = () => "goal-test-" + Math.random().toString(36).slice(2);

/** @param {any} composer @param {string} text @param {any} [extra] */
function type(composer, text) {
  composer.input.value = text;
  composer.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
}
/** @param {any} composer @param {any} [extra] */
function enter(composer, extra = {}) {
  const e = Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Enter", target: composer.input, ...extra });
  composer.input.dispatchEvent(e);
}
function esc(composer) {
  const e = Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Escape", target: composer.input });
  composer.input.dispatchEvent(e);
}

test("/goal, then Enter for the title, Enter per milestone, Cmd+Enter sends one message", async () => {
  const c = mountComposer({ thread: thread() });
  type(c, "/goal Ship the redesign");
  enter(c); // dispatches the local command with the typed words as the title
  assert.equal(text($(c.el, ".composer-kind")), "Goal");
  assert.equal(c.value(), "", "the composer is clear, ready for the first milestone");

  type(c, "Wireframes approved");
  enter(c);
  type(c, "Copy finalized");
  enter(c);
  assert.deepEqual($$(c.el, ".composer-scope").map(x => text(x).replace("×", "").trim()),
    ["Wireframes approved", "Copy finalized"]);

  // Cmd+Enter on an empty box finishes: enterAction would say "none" for empty text, but goal
  // mode is handled before that check, so this must still fire.
  type(c, "");
  enter(c, { metaKey: true });
  assert.equal($(c.el, ".composer-kind"), null, "goal mode closed, the normal chips are back");
  c.stop();
});

test("Esc cancels a goal in progress and clears the box", async () => {
  const c = mountComposer({ thread: thread() });
  type(c, "/goal Something");
  enter(c);
  type(c, "a milestone in progress, not yet added");
  esc(c);
  assert.equal($(c.el, ".composer-kind"), null);
  assert.equal(c.value(), "");
  c.stop();
});

test("picking /goal from the palette with no words starts with an empty title", async () => {
  const c = mountComposer({ thread: thread() });
  type(c, "/goal");
  enter(c);
  assert.equal(text($(c.el, ".composer-kind")), "Goal");
  // "Set goal" is disabled until a title exists.
  const go = $$(c.el, "button").find(b => text(b).replace(/(⌘|Ctrl)⏎/, "").trim() === "Set goal");
  assert.equal(go?.disabled, true);
  c.stop();
});
