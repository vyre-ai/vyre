// @ts-check
// Needs you as data (needs-model.ts): rows from the box's two lists, oldest first, kept live by
// events, and the cache read back. Loaded through Node's type stripping, so skipped on a Node
// without it.
import "../../scripts/test-guard.mjs";

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./needs-model.ts");

const ctx = {
  projects: { "harlow-legal": "Harlow Legal", northwind: "Northwind Bakery" },
  threads: { t1: { agent: "kit", project: "harlow-legal" }, t2: { agent: "juno", project: "northwind" } },
};
const gate = (o = {}) => ({ id: "g1", kind: "send", via: "mail", to: ["sam@northwind.test"], summary: "Q3 report, the short version",
  why: null, agent: "kit", thread: "t1", project: "harlow-legal", at: 1000, presence: { required: true, covered: false, since: null }, ...o });
const ask = (o = {}) => ({ id: "a1", thread: "t1", tool: "Bash", summary: "git push origin q3-report", destination: null, reason: null,
  at: 2000, state: "open", decision: null, presence: { required: false, covered: false, since: null }, ...o });

test("needs: held items and asks are one list, oldest first, ties by id", { skip: !strip }, async () => {
  const { merge } = await load();
  const list = merge([gate({ id: "g2", at: 3000 }), gate()], [ask(), ask({ id: "a0", at: 1000 })], ctx);
  assert.deepEqual(list.map((n) => n.id), ["ask:a0", "gate:g1", "ask:a1", "gate:g2"]);
  const g = list[1];
  assert.equal(g.title, "Send email to sam");
  assert.equal(g.detail, "Q3 report, the short version");
  assert.equal(g.project, "Harlow Legal", "the project's name, not its slug");
  assert.equal(g.mono, false);
  const a = list[2];
  assert.equal(a.title, "Run a command");
  assert.equal(a.mono, true, "a command reads in mono");
  assert.equal(a.agent, "kit", "an ask has no agent: joined from threads.list");
  assert.deepEqual(a.presence, { required: false, covered: false, since: null });
});

test("needs: a question is titled by who asks, and shows the question", { skip: !strip }, async () => {
  const { fromAsk } = await load();
  const n = fromAsk(ask({ kind: "question", tool: "AskUserQuestion", questions: [{ question: "Which intake form should the Estate branch use?" }] }), ctx);
  assert.ok(n);
  assert.equal(n.title, "kit has a question");
  assert.equal(n.detail, "Which intake form should the Estate branch use?");
  assert.equal(n.mono, false);
});

test("needs: events keep the list live without a read", { skip: !strip }, async () => {
  const { merge, applyNeedsEvent } = await load();
  let list = merge([gate()], [], ctx);
  let r = applyNeedsEvent(list, { type: "ask.raised", at: 500, payload: { thread: "t2", ask: "a9", tool: "Write", summary: "Write notes.txt" } }, ctx);
  assert.deepEqual(r.list.map((n) => n.id), ["ask:a9", "gate:g1"], "an older ask goes first");
  assert.equal(r.refetch, false);
  assert.equal(r.list[0].agent, "juno");
  list = [...r.list];
  r = applyNeedsEvent(list, { type: "ask.raised", at: 500, payload: { thread: "t2", ask: "a9" } }, ctx);
  assert.equal(r.list, list, "a repeat changes nothing");
  r = applyNeedsEvent(list, { type: "ask.answered", payload: { ask: "a9", decision: "allow" } }, ctx);
  assert.deepEqual(r.list.map((n) => n.id), ["gate:g1"]);
  r = applyNeedsEvent(r.list, { type: "gate.held", at: 9000, payload: { id: "g5", kind: "spend", via: "billing", to: ["billing.northwind.test"], summary: "POST https://billing.northwind.test/pay" } }, ctx);
  assert.equal(r.refetch, true, "an event says nothing of presence: read the list again");
  const g5 = r.list.find((n) => n.id === "gate:g5");
  assert.ok(g5);
  assert.deepEqual(g5.presence, { required: true, covered: false, since: null }, "a spend needs a proof until the box says it is covered");
  assert.equal(g5.mono, true);
  r = applyNeedsEvent(r.list, { type: "gate.failed", payload: { id: "g5", error: "billing host said 502" } }, ctx);
  assert.equal(r.list.find((n) => n.id === "gate:g5")?.error, "billing host said 502");
  r = applyNeedsEvent(r.list, { type: "gate.released", payload: { id: "g1" } }, ctx);
  r = applyNeedsEvent(r.list, { type: "gate.rejected", payload: { id: "g5" } }, ctx);
  assert.deepEqual(r.list, []);
});

test("needs: the cache is read back only when it is a list of rows", { skip: !strip }, async () => {
  const { merge, hydrate } = await load();
  const list = merge([gate()], [ask()], ctx);
  const back = hydrate(JSON.parse(JSON.stringify(list)));
  assert.deepEqual(back, list);
  assert.equal(hydrate(null), null);
  assert.equal(hydrate({ items: [] }), null);
  assert.equal(hydrate([{ id: "x" }]), null, "an older shape is not trusted");
  assert.deepEqual(hydrate([]), []);
  const shuffled = hydrate([list[1], list[0]]);
  assert.deepEqual(shuffled?.map((n) => n.id), list.map((n) => n.id), "read back oldest first");
});

test("needs: a swipe commits only what the box would take; the rest opens", { skip: !strip }, async () => {
  const { fromGate, fromAsk, canCommit, answerCall } = await load();
  const held = fromGate(gate(), ctx);
  assert.ok(held);
  assert.deepEqual(canCommit(held, "approve"), { ok: false, why: "Needs Face ID on this device" });
  assert.deepEqual(canCommit(held, "reject"), { ok: true }, "discarding sends nothing: no proof");
  const covered = fromGate(gate({ presence: { required: true, covered: true, since: 1 } }), ctx);
  assert.ok(covered);
  assert.deepEqual(canCommit(covered, "approve"), { ok: true });
  const q = fromAsk(ask({ kind: "question" }), ctx);
  assert.ok(q);
  assert.equal(canCommit(q, "approve").ok, false, "a question needs its answer");
  assert.equal(canCommit(q, "reject").ok, true);
  const a = fromAsk(ask(), ctx);
  assert.ok(a);
  assert.deepEqual(answerCall(a, "approve", "web"), { tool: "threads.answer", input: { ask: "a1", decision: "allow", surface: "web" } });
  assert.deepEqual(answerCall(a, "reject", "web"), { tool: "threads.answer", input: { ask: "a1", decision: "deny", surface: "web" } });
  assert.deepEqual(answerCall(held, "approve", "web"), { tool: "gate.approve", input: { id: "g1" } });
  assert.deepEqual(answerCall(held, "reject", "web"), { tool: "gate.reject", input: { id: "g1" } });
});

test("needs: the box's answer reads as through or refused with a reason", { skip: !strip }, async () => {
  const { fromGate, fromAsk, answerOutcome } = await load();
  const g = fromGate(gate(), ctx), a = fromAsk(ask(), ctx);
  assert.ok(g && a);
  assert.deepEqual(answerOutcome(g, { data: { id: "g1", state: "sent" } }), { ok: true });
  assert.deepEqual(answerOutcome(g, { data: { id: "g1", state: "failed", error: "mail host down" } }), { ok: false, reason: "mail host down" });
  assert.deepEqual(answerOutcome(g, { error: { code: "failed", message: "g1 is already sent" } }), { ok: false, reason: "g1 is already sent" });
  assert.deepEqual(answerOutcome(a, { data: { ask: "a1", answered: false, note: "the thread stopped" } }), { ok: false, reason: "the thread stopped" });
  assert.deepEqual(answerOutcome(a, { data: { ask: "a1", answered: true, decision: "allow" } }), { ok: true });
});

test("needs: ages read short", { skip: !strip }, async () => {
  const { age } = await load();
  assert.equal(age(0, 30_000), "now");
  assert.equal(age(0, 12 * 60_000), "12m");
  assert.equal(age(0, 3 * 3_600_000), "3h");
  assert.equal(age(0, 72 * 3_600_000), "3d");
});
