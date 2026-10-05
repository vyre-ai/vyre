// @ts-check
// needs.js: the one list Now, the header and the phone agree on. Asks, questions and held drafts
// in one shape, oldest first, with the anchors Open session needs, and each answer sent with the
// input the switchboard and the Gate take (and the presence the no-nag rule allows).

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

install();
/** @type {{ name: string, input: any, presence: string | null }[]} */
const calls = [];
/** @type {Record<string, any>} */
let answers = {};
globalThis.dispatchEvent = () => true;
// @ts-ignore: a fake fetch that answers each tool from `answers`.
globalThis.fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
  const name = decodeURIComponent(String(url).replace("/v1/tools/", ""));
  const input = JSON.parse(init?.body || "{}");
  calls.push({ name, input, presence: init?.headers?.["x-vyre-presence"] || null });
  const data = typeof answers[name] === "function" ? answers[name](input) : answers[name];
  // { $refuse: { code, message } }: the box refuses the call with that error.
  return { ok: true, status: 200, json: async () => (data === undefined ? { error: { code: "unknown_tool", message: "no" } } : data?.$refuse ? { error: data.$refuse } : { data }) };
};
const needs = await import("./needs.js");

const T = 1_800_000_000_000;
answers = {
  "gate.held": [{ id: "g1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Q3 report", agent: "juno", thread: "t1", project: "harlow-legal", at: T + 3,
    anchor: { tool_use_id: null, event: 41, thread: "t1", at: T + 3 } }],
  "gate.get": { draft: { subject: "Q3 report, the short version", body: "Hi Dana" }, final: null, toName: "Dana Reyes" },
  "threads.asks": [
    { id: "a1", kind: "permission", thread: "t2", tool: "Bash", summary: "git push origin q3-report", detail: { command: "git push origin q3-report" }, reason: "pushes ask first",
      at: T + 1, agent: "kit", thread_name: "Q3 report", anchor: { tool_use_id: "toolu_9", event: 12 }, always: true, always_project: "harlow-legal" },
    { id: "q1", kind: "question", thread: "t3", tool: "AskUserQuestion", summary: "Which firm first?", at: T + 2, agent: "juno", thread_name: "Planning",
      questions: [{ question: "Which firm first?", options: [{ label: "Harlow Legal" }, { label: "Northwind Bakery" }] }], anchor: { tool_use_id: "toolu_q", event: 20 } },
  ],
  "threads.list": [{ id: "t2", project: "harlow-legal", name: "Q3 report", agent: "kit" }],
  "projects.list": { projects: [{ slug: "harlow-legal", name: "Harlow Legal" }] },
};

test("needs: asks, questions and drafts in one list, oldest first, with their anchors", async () => {
  const { items } = await needs.load();
  assert.deepEqual(items.map(n => [n.id, n.kind]), [["a1", "ask"], ["q1", "question"], ["g1", "draft"]]);
  const [ask, q, draft] = items;
  assert.equal(ask.agent, "kit");
  assert.equal(ask.projectName, "Harlow Legal");
  assert.equal(ask.threadName, "Q3 report");
  assert.equal(ask.tool, "Bash");
  assert.deepEqual(ask.detail, { command: "git push origin q3-report" });
  assert.equal(ask.always_project, "harlow-legal");
  assert.deepEqual(ask.anchor, { tool_use_id: "toolu_9", event: 12 });
  assert.equal(q.questions?.[0].question, "Which firm first?");
  assert.equal(q.threadName, "Planning");
  assert.equal(draft.anchor.at, T + 3);
  assert.equal(draft.gate?.draft?.subject, "Q3 report, the short version");
});

test("needs: answers go as the switchboard and the Gate take them; only Send proves presence", async () => {
  await needs.load();
  const [ask, q, draft] = needs.current();
  answers["threads.answer"] = { ok: true };
  answers["gate.reject"] = { state: "rejected" };
  calls.length = 0;
  await needs.answer(ask, { label: "Always in Harlow Legal", decision: "always" });
  assert.deepEqual(calls[0], { name: "threads.answer", input: { ask: "a1", decision: "always", surface: "deck", scope: "project" }, presence: null });
  assert.equal(needs.current().some(n => n.id === "a1"), false, "gone from the list at once");

  calls.length = 0;
  await needs.answer(q, { label: "Answer", decision: "allow", answers: { "Which firm first?": "Harlow Legal" } });
  assert.deepEqual(calls[0].input, { ask: "q1", decision: "allow", surface: "deck", answers: { "Which firm first?": "Harlow Legal" } });
  assert.equal(calls[0].presence, null);

  calls.length = 0;
  await needs.answer(draft, { label: "Discard", decision: "reject" });
  assert.deepEqual(calls[0], { name: "gate.reject", input: { id: "g1" }, presence: null });
});

test("needs: threads.answer input, without a project on offer and for a declined question", () => {
  assert.deepEqual(needs.answerInput({ id: "a", kind: "ask", always_project: null }, { decision: "always" }), { ask: "a", decision: "always", surface: "deck" });
  assert.deepEqual(needs.answerInput({ id: "a", kind: "ask" }, { decision: "deny" }), { ask: "a", decision: "deny", surface: "deck" });
  assert.deepEqual(needs.answerInput({ id: "q", kind: "question" }, { decision: "deny" }), { ask: "q", decision: "deny", surface: "deck" });
});

test("needs: an ask raised this session opens by id before the list has it, until answered", () => {
  needs.hear({ type: "ask.raised", at: T + 9, thread: "tm", project: "harlow-legal",
    payload: { ask: "r1", tool: "Bash", summary: "npm run build", kind: "permission", agent: "kit" } });
  const r = needs.find("r1");
  assert.equal(r?.kind, "ask");
  assert.equal(r?.command, "npm run build");
  assert.equal(r?.thread, "tm");
  assert.equal(needs.current().some(n => n.id === "r1"), false, "the list is your server's only");
  needs.hear({ type: "ask.answered", payload: { ask: "r1", decision: "allow" } });
  assert.equal(needs.find("r1"), null);
  assert.equal(needs.find("nope"), null);
});
