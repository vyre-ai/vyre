// @ts-check
// needs.js on cohesion's waiting (ADR 0036 decision 4): waiting.list says what waits and
// waiting.count is the one number; the owners' reads still give each draft's words and each
// question's options. A box without waiting keeps today's merge (deck/js/needs.test.js).

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

install();
/** @type {string[]} */
const calls = [];
/** @type {Record<string, any>} */
let answers = {};
globalThis.dispatchEvent = () => true;
// @ts-ignore: a fake fetch that answers each tool from `answers`.
globalThis.fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
  const name = decodeURIComponent(String(url).replace("/v1/tools/", ""));
  calls.push(name);
  const data = typeof answers[name] === "function" ? answers[name](JSON.parse(init?.body || "{}")) : answers[name];
  return { ok: true, status: 200, json: async () => (data === undefined ? { error: { code: "no_such_tool", message: "no" } } : { data }) };
};
const needs = await import("./needs.js");
const { elsewhere } = await import("./need-rows.js");

const T = 1_800_000_000_000;
const owners = {
  "gate.held": [{ id: "g1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Q3 report", agent: "juno", at: T + 3 },
    { id: "g2", kind: "send", via: "mail", to: ["sam@northwindbakery.com"], summary: "Invoice", agent: "juno", at: T + 4 }],
  "gate.get": { draft: { subject: "Q3 report", body: "Hi Dana" }, final: null },
  "threads.asks": [
    { id: "a1", kind: "permission", thread: "t2", tool: "Bash", summary: "git push origin q3-report", at: T + 1, agent: "kit" },
    { id: "m1", kind: "permission", thread: "t9", tool: "Bash", summary: "npm test", at: T + 2, agent: "kit", source: "mac", machine: "alex's MacBook Pro", node: "n1" },
  ],
  "threads.list": [], "projects.list": { projects: [] },
};
const row = (/** @type {string} */ id, /** @type {string} */ kind, /** @type {number} */ at, /** @type {any} */ extra = {}) =>
  ({ id, kind, title: `row ${id}`, at, source: id.split(":")[0], answer: { tool: "threads.answer", input: {}, fill: ["decision"] }, ...extra });

test("waiting.list is the one list: only what it names, from the owners' reads, and its count", async () => {
  answers = { ...owners, "waiting.list": { count: 5, by_kind: { ask: 3, draft: 1, reminder: 1, pairing: 0 }, rows: [
    row("threads:a1", "ask", T + 1),
    row("threads:m1", "ask", T + 2, { machine: "alex's MacBook Pro", answer: { tool: null, input: null, fill: [], on: "alex's MacBook Pro" } }),
    row("gate:g1", "draft", T + 3, { answer: { tool: "gate.approve", input: { id: "g1" }, fill: [] } }),
    // Not in threads.asks yet (raised a moment ago): answerable from its id and title.
    row("threads:a9", "ask", T + 5),
    row("planner:f1", "reminder", T + 6, { answer: { tool: "planner.done", input: { firing: "f1" }, fill: [] } }),
  ] } };
  const { items } = await needs.load();
  assert.deepEqual(items.map(n => [n.id, n.kind]), [["a1", "ask"], ["m1", "ask"], ["g1", "draft"], ["a9", "ask"]],
    "g2 is not waiting any more, so it is gone; the reminder counts but draws on the Planner");
  assert.equal(items[2].gate?.draft?.subject, "Q3 report", "the draft's words from gate.get");
  assert.equal(items[3].title, "row threads:a9");
  assert.equal(needs.count(), 5, "waiting's count, not the rows drawn");
  assert.equal(elsewhere(/** @type {any} */ (items[1])), "alex's MacBook Pro", "your server cannot answer it: Answer it on the Mac");
  await assert.rejects(needs.answer(items[1], { label: "Allow once", decision: "allow" }), /Answer it on alex's MacBook Pro\./);
  assert.ok(!calls.includes("threads.answer"), "nothing was sent for it");
});

test("waiting.changed moves the count at once; an answer takes one off before your server says so", async () => {
  needs.heardWaiting({ payload: { count: 2, by_kind: { ask: 2 } } });
  assert.equal(needs.count(), 2);
  needs.heardWaiting({ payload: { count: -1 } });
  needs.heardWaiting({ payload: {} });
  assert.equal(needs.count(), 2, "a bad count is ignored");
  answers["threads.answer"] = { answered: true };
  await needs.answer(/** @type {any} */ (needs.current().find(n => n.id === "a1")), { label: "Allow once", decision: "allow" });
  assert.equal(needs.count(), 1);
});

test("a question waiting names before threads.asks has it is left for the next load (its options come from there)", async () => {
  answers = { ...owners, "waiting.list": { count: 1, by_kind: { ask: 1 }, rows: [row("threads:q7", "ask", T + 7, { answer: { tool: "threads.answer", input: {}, fill: ["decision", "answers"] } })] } };
  const { items } = await needs.load();
  assert.deepEqual(items, []);
  assert.equal(needs.count(), 1);
});

test("waiting's partial sources reach the views; the rows it could read still show", async () => {
  answers = { ...owners, "waiting.list": { count: 1, by_kind: { ask: 1 }, rows: [row("threads:a1", "ask", T + 1)], partial: ["planner"] } };
  const { items, errors } = await needs.load();
  assert.deepEqual(items.map(n => n.id), ["a1"]);
  assert.deepEqual(/** @type {any} */ (errors).partial, ["planner"]);
});
