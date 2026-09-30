// @ts-check
// The card registry (index.js): which tool results and asks become which card, from sample data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});

const { renderOf, toolDisplay, askCardFor, DISPLAY, ASKS } = await import("./index.js");

test("renderOf reads a render payload from the block or from a JSON result, and only for a known kind", () => {
  assert.equal(renderOf({ render: { kind: "report", title: "Q3" } }).kind, "report");
  assert.equal(renderOf({ output: JSON.stringify({ render: { kind: "diff", files: [] } }) }).kind, "diff");
  assert.equal(renderOf({ render: { kind: "nope" } }), null);
  assert.equal(renderOf({ output: "plain text" }), null);
  assert.equal(renderOf(null), null);
});

test("toolDisplay is a card for a tool block with a payload, and null for one without", () => {
  assert.equal(toolDisplay({ tool: "Bash", output: "ok" }), null);
  const el = /** @type {any} */ (toolDisplay({ tool: "report.make", ts: 5, render: { kind: "report", title: "Q3", text: "Sales are up." } }));
  assert.ok(el);
  assert.equal(el._ts, 5);
  el.update({ tool: "report.make", ts: 6, render: { kind: "report", title: "Q3", text: "Sales are up again." } });
});

test("askCardFor takes the new ask kinds, and a question that carries survey fields", () => {
  assert.equal(askCardFor({ kind: "permission" }), null);
  assert.equal(askCardFor({ kind: "question", questions: [{ question: "Which?", options: [{ label: "A" }] }] }), null);
  const s = askCardFor({ id: "k1", kind: "question", questions: [{ question: "Which?", options: [{ label: "A", recommended: true }] }] });
  assert.ok(s);
  for (const k of Object.keys(ASKS)) assert.equal(typeof ASKS[k], "function", k);
  for (const k of Object.keys(DISPLAY)) assert.equal(typeof DISPLAY[k], "function", k);
});
