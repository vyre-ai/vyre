// @ts-check
// iq/retrieve: the passages Vyre IQ reads (ADR 0034, phase 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { retriever, timeWindow, contentWords } from "./retrieve.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00Z");

test("retrieve: a question's content words, and the time it points at", () => {
  assert.deepEqual(contentWords("which file had the refund bug in harlow-site?"), ["file", "refund", "bug", "harlow-site"]);
  assert.deepEqual(timeWindow("what did we deploy last week", NOW), [NOW - 8 * DAY, NOW]);
  assert.deepEqual(timeWindow("what broke in june", NOW), [Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 1)]);
  // A month after this one is last year's.
  assert.deepEqual(timeWindow("the invoice bug in december", NOW), [Date.UTC(2025, 11, 1), Date.UTC(2026, 0, 1)]);
  assert.equal(timeWindow("what port does the api use", NOW), null);
});

const hit = (session, seq, ts, extra = {}) => ({ session, seq, role: "assistant", ts, text: `${session} ${seq}`, name: null, cwd: "/home/alex/Work/northwind", ...extra });

test("retrieve: searches are fused by rank, ties break the same way, and the Capsule's asks are never read", async () => {
  const lists = {
    "northwind invoice total": [hit("a", 1, NOW - 40 * DAY), hit("b", 2, NOW - 3 * DAY), hit("ask", 0, NOW, { name: "Capsule: invoice total" })],
    "Northwind Bakery northwind invoice total": [hit("b", 2, NOW - 3 * DAY), hit("c", 0, NOW - 90 * DAY)],
  };
  const seen = [];
  const graph = {
    phrases: () => ({ phrases: new Map([["northwind", [{ node: "org:northwind", weight: 1, via: "short" }]]]), longest: 1 }),
    node: () => ({ label: "Northwind Bakery" }),
    view: () => null,
  };
  const r = retriever({ graph, now: () => NOW, search: async q => { seen.push(q); return lists[q.q] || []; } });
  const out = await r({ question: "what was the northwind invoice total" });
  assert.deepEqual(out.expanded, ["Northwind Bakery"]);
  assert.equal(out.passages[0].id, "b:2", "found by both searches, it comes first");
  assert.ok(!out.passages.some(p => p.session === "ask"));
  assert.deepEqual((await r({ question: "what was the northwind invoice total" })).passages, out.passages);
  // Switched off, the graph widens nothing.
  const bare = await r({ question: "what was the northwind invoice total", expand: false });
  assert.deepEqual(bare.expanded, []);
  // The scope goes to every search.
  seen.length = 0;
  await r({ question: "invoice total", project_cwds: ["/home/alex/Work/northwind"] });
  assert.ok(seen.every(q => q.project_cwds?.[0] === "/home/alex/Work/northwind"));
});

test("retrieve: personal names widen a question only for a caller that may see them", async () => {
  const personal = { entity: a => (/wife/.test(a) ? { label: "Noor" } : null) };
  const r = retriever({ personal, now: () => NOW, search: async () => [] });
  assert.deepEqual((await r({ question: "when did my wife move the demo", personal: true })).expanded, ["Noor"]);
  assert.deepEqual((await r({ question: "when did my wife move the demo" })).expanded, []);
});
