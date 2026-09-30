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

// ---- reviewer-2 M1: only a Vyre tool's output is actionable ----------------------------------------
const { firstParty } = await import("./index.js");
const { $, $$, text } = await import("../../test/fake-dom.js");
const REPORT = { kind: "report", title: "Devices", text: "Two devices.", actions: [
  { label: "Refresh", run: { tool: "devices.refresh" } }, { label: "Approve", run: { tool: "github.project.pr.merge", input: { project: "p", pr: 1 } } }, { label: "Docs", href: "https://example.com" }] };

test("firstParty: a registry name or Vyre's own MCP server, never a shell, a fetch or another server", () => {
  for (const t of ["github.project.pr.review", "report.make", "mcp__vyre__team_list"]) assert.equal(firstParty(t), true, t);
  for (const t of ["Bash", "WebFetch", "Read", "mcp__gmail__read", "", null, "devices"]) assert.equal(firstParty(t), false, String(t));
});

test("a report from a page the agent read (Bash) draws with no buttons, and from a Vyre tool only its allowlisted ones", () => {
  const read = /** @type {any} */ (toolDisplay({ tool: "Bash", render: REPORT }));
  assert.equal($$(read, "button").filter(b => /Refresh|Approve|Docs/.test(text(b))).length, 0);
  const own = /** @type {any} */ (toolDisplay({ tool: "report.make", render: REPORT }));
  const labels = $$(own, "button").map(b => text(b));
  assert.ok(labels.some(l => l.includes("Refresh")));
  assert.ok(labels.some(l => l.includes("Docs")));
  assert.ok(!labels.some(l => l.includes("Approve")), "a tool named in the payload that is not on the allowlist never gets a button");
});

test("a pull request and a calendar event from another source are read-only", () => {
  const pr = /** @type {any} */ (toolDisplay({ tool: "WebFetch", render: { kind: "pr_review", project: "harlow-legal", pr: 7, title: "Fix", state: "open", files: [] } }));
  assert.equal($(pr, "[data-act=merge]"), null);
  assert.match(text(pr), /reading only/);
  const cal = /** @type {any} */ (toolDisplay({ tool: "WebFetch", render: { kind: "calendar_event", id: "e1", title: "Sync", start: Date.now() + 3600e3, end: Date.now() + 7200e3, response: "needsAction" } }));
  assert.equal($(cal, ".cv-ce-foot"), null);
});
