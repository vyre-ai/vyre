// @ts-check
// "@design" made a teammate a moment ago: the handoff card says so and offers Undo until a reply lands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
const calls = /** @type {any[]} */ ([]);
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, input: JSON.parse(o.body) });
  return { status: 200, statusText: "", json: async () => ({ data: { ok: true } }) };
});

const { handoffCard } = await import("./blocks.js");
const { markMade, madeNow } = await import("./core/made.js");

const block = (extra = {}) => ({ kind: "tool", tool: "team_ask", input: { to: "design", text: "calm the intake form" }, project: "northwind", ts: 1, ...extra });

test("a role made a moment ago says so and undoes through team.retire; a reply ends the offer", async () => {
  markMade("northwind", "design", "design-northwind");
  const el = /** @type {any} */ (handoffCard(block()));
  assert.match(text($(el, ".cv-made")), /Made design, a new teammate/);
  await $(el, ".cv-made-undo").click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(calls.at(-1).input, { project: "northwind", role: "design", undo: true });
  assert.equal(calls.at(-1).tool, "team.retire");
  assert.match(text($(el, ".cv-made")), /Undone/);
  assert.equal(madeNow("northwind", "design"), null);

  markMade("northwind", "review", null);
  const done = /** @type {any} */ (handoffCard(block({ input: { to: "review", text: "check" }, reply: "Looks fine." })));
  assert.equal($(done, ".cv-made"), null, "a teammate that has replied has run: no Undo");
});
