// @ts-check
// Navigation budgets (#35, the app feel). Against a far-away server (every tool call takes LAG ms), each main screen must ask for everything it
// needs in at most two rounds, never a chain of three, and the same read asked for twice at once must be one request. The unit is rounds, not
// milliseconds, so a slow runner cannot make it flaky: round n starts when the first call of round n-1 ended. Sample world only.

import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { install } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
});
Object.defineProperty(globalThis, "history", { value: { state: null, pushState() {}, replaceState() {} }, configurable: true, writable: true });

const LAG = 80;
/** @type {{ tool: string, at: number }[]} */ let calls = [];
let t0 = 0;
globalThis.fetch = /** @type {any} */ (async (url) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, at: Date.now() - t0 });
  await new Promise(r => setTimeout(r, LAG));
  const data = tool === "projects.list" ? { projects: [{ slug: "a", name: "A", threads: 1 }] } : tool === "system.info" ? { owner: { name: "alex" } }
    : tool === "memory.facts" ? { facts: [{ id: "f1", text: "A fact", seen: Date.now(), subject: { id: "n1" } }] }
    : /\.(?:list|held|asks|pending|targets|keys|macs|catalog)$/.test(tool) ? [] : {};
  return { status: 200, statusText: "", json: async () => ({ data }) };
});

/** How many sequential rounds a screen's calls form: a call is in a later round when it started after an earlier one had finished. */
function rounds() {
  const starts = calls.map(c => c.at).sort((a, b) => a - b);
  let n = 0, edge = -1;
  for (const s of starts) if (s > edge) { n++; edge = s + LAG - 15; }
  return n;
}
async function open(view) {
  calls = []; t0 = Date.now();
  const mod = await import(`../views/${view}.js`);
  const root = new /** @type {any} */ (globalThis).Element("div");
  const ctx = { root, params: {}, query: new URLSearchParams(), on() {}, cleanup() {}, alive: () => true, shown: () => true, onShow() {}, rail() {} };
  await mod.default(ctx);
  await new Promise(r => setTimeout(r, LAG * 4));
  return { rounds: rounds(), tools: calls.map(c => c.tool) };
}

for (const view of ["now", "chat", "projects", "vault", "files", "planner"]) {
  test(`${view}: everything it needs is asked for in at most two rounds`, async () => {
    const r = await open(view);
    assert.ok(r.tools.length > 0, "it asked your server for something");
    assert.ok(r.rounds <= 2, `${view} took ${r.rounds} rounds: ${r.tools.join(", ")}`);
  });
}

test("the same read asked for several times at once is one request", async () => {
  const { call } = await import("../js/api.js");
  calls = []; t0 = Date.now();
  const all = await Promise.all([call("projects.list", {}, { share: true }), call("projects.list", {}, { share: true }), call("projects.list", {}, { share: true })]);
  assert.equal(calls.filter(c => c.tool === "projects.list").length, 1);
  assert.deepEqual(all[0], all[2]);
  calls = [];
  await Promise.all([call("projects.list", {}, { share: true }), call("projects.list", { archived: true }, { share: true })]);
  assert.equal(calls.length, 2, "different input is a different read");
  calls = [];
  await Promise.all([call("projects.list", {}), call("projects.list", {})]);
  assert.equal(calls.length, 2, "a caller that did not ask to share never shares");
  calls = [];
  await Promise.all([call("threads.send", { text: "a" }), call("threads.send", { text: "a" })]);
  assert.equal(calls.length, 2, "a write is never shared");
});

// The screens leave listeners and timers behind (they are built to run for the life of a page): end the process once the results are printed.
after(() => { setTimeout(() => process.exit(process.exitCode || 0), 300).unref?.(); });
