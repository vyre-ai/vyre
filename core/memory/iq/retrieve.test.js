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
    "northwind invoice total": [hit("a", 1, NOW - 40 * DAY), hit("b", 2, NOW - 3 * DAY), hit("ask", 0, NOW, { name: "Capsule: invoice total" }), hit("quick", 0, NOW, { cwd: "/home/alex/.vyre/quick/memory" })],
    "Northwind Bakery northwind invoice total": [hit("b", 2, NOW - 3 * DAY), hit("c", 0, NOW - 90 * DAY)],
  };
  const seen = [];
  const graph = {
    phrases: () => ({ phrases: new Map([["northwind", [{ node: "org:northwind", weight: 1, via: "short" }]]]), longest: 1 }),
    node: () => ({ label: "Northwind Bakery" }),
    view: () => null,
  };
  const r = retriever({ graph, quickDir: "/home/alex/.vyre/quick", now: () => NOW, search: async q => { seen.push(q); return lists[q.q] || []; } });
  const out = await r({ question: "what was the northwind invoice total" });
  assert.deepEqual(out.expanded, ["Northwind Bakery"]);
  assert.equal(out.passages[0].id, "b:2", "found by both searches, it comes first");
  assert.ok(!out.passages.some(p => p.session === "ask" || p.session === "quick"));
  assert.deepEqual((await r({ question: "what was the northwind invoice total" })).passages, out.passages);
  // Switched off, the graph widens nothing.
  const bare = await r({ question: "what was the northwind invoice total", expand: false });
  assert.deepEqual(bare.expanded, []);
  // The scope goes to every search.
  seen.length = 0;
  await r({ question: "invoice total", project_cwds: ["/home/alex/Work/northwind"] });
  assert.ok(seen.every(q => q.project_cwds?.[0] === "/home/alex/Work/northwind"));
});

test("retrieve: a project reads its attached sessions, and a user turn carries the reply that followed", async () => {
  const seen = [];
  const graph = { phrases: () => ({ phrases: new Map(), longest: 1 }), node: () => null, view: () => null };
  const turns = { "a:3": { seq: 3, role: "assistant", text: "The cause was floats: use integer cents." } };
  const r = retriever({ graph, now: () => NOW, picks: cwds => cwds[0] === "/home/alex/Work/northwind" ? ["planning"] : [],
    next: async (session, seq) => turns[`${session}:${seq + 1}`] || null,
    search: async q => { seen.push(q); return [hit("a", 2, NOW, { role: "user", text: "the croissant order shows $10.049999, why" }), hit("b", 1, NOW)]; } });
  const out = await r({ question: "croissant order $10.049999 cause", project_cwds: ["/home/alex/Work/northwind"] });
  assert.ok(seen.every(q => q.sessions?.[0] === "planning"), "the attached session goes to every search");
  assert.deepEqual(out.passages.find(p => p.session === "a").reply, { seq: 3, text: "The cause was floats: use integer cents." });
  assert.equal(out.passages.find(p => p.session === "b").reply, undefined, "an assistant turn has no reply");
  assert.equal((await r({ question: "croissant order cause", replies: false })).passages.find(p => p.session === "a").reply, undefined);
  seen.length = 0;
  await r({ question: "invoice", project_cwds: ["/home/alex/Work/harlow-site"] });
  assert.ok(seen.every(q => !q.sessions), "no picks, no sessions");
});

test("retrieve: personal names widen a question only for a caller that may see them", async () => {
  const personal = { entity: a => (/wife/.test(a) ? { label: "Noor" } : null) };
  const r = retriever({ personal, now: () => NOW, search: async () => [] });
  assert.deepEqual((await r({ question: "when did my wife move the demo", personal: true })).expanded, ["Noor"]);
  assert.deepEqual((await r({ question: "when did my wife move the demo" })).expanded, []);
});

test("retrieve: names the graph knows on the screen widen the search; the screen text itself is not searched", async () => {
  const seen = [];
  const graph = {
    phrases: () => ({ phrases: new Map([["priya shah", [{ node: "name:Priya Shah", weight: 1, via: "label" }]]]), longest: 2 }),
    node: () => ({ label: "Priya Shah" }), view: () => null,
  };
  const r = retriever({ graph, now: () => NOW, search: async q => { seen.push(q.q); return []; } });
  const out = await r({ question: "who sent this", hint: "From: Priya Shah <priya@harlowlegal.com> please sign the retainer" });
  assert.deepEqual(out.expanded.sort(), ["Priya Shah", "priya@harlowlegal.com"].sort());
  assert.ok(!seen.some(q => /retainer/.test(q)), "the screen's own words were searched");
});
