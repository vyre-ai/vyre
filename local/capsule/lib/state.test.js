// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaiting, fromHeld, reply, applyReply, replyText, cancel, dm, applyDm, dmPending, dmDrop, dmHistory, dmCarry, dmView, sentText } from "./state.js";

const ev = (id, type, payload, extra = {}) => ({ id, at: 1000 * id, type, source: "x", project: null, thread: null, payload, ...extra });

test("state: asks and holds wait together, oldest first, until answered", () => {
  let w = [];
  w = applyWaiting(w, ev(2, "gate.held", { id: "g1", kind: "send", via: "mail", to: ["Dana Reyes <dana@harlowlegal.com>"], summary: "Re: Q3 report", agent: "juno", thread: null, project: "harlow-legal" }, { project: "harlow-legal" }));
  w = applyWaiting(w, ev(1, "ask.raised", { ask: "a1", agent: "pax", tool: "Bash", summary: "run npm publish" }, { thread: "t1" }));
  assert.deepEqual(w.map(x => x.id), ["a1", "g1"], "the one kept waiting longest comes first");
  assert.equal(w[1].title, "juno drafted a message to Dana Reyes");
  assert.equal(w[1].sub, "Re: Q3 report · harlow-legal");
  assert.equal(w[0].title, "pax asks to run npm publish");
  const named = applyWaiting([], ev(9, "ask.raised", { ask: "a2", summary: "x" }, { project: "harlow-legal" }), () => "Harlow Legal");
  assert.equal(named[0].sub, "Harlow Legal", "people read a project's name, not its slug");
  const same = applyWaiting(w, ev(3, "thread.text", { text: "hi" }));
  assert.equal(same, w, "an unrelated event changes nothing");
  w = applyWaiting(w, ev(4, "ask.answered", { ask: "a1" }));
  w = applyWaiting(w, ev(5, "gate.released", { id: "g1", edited: true }));
  assert.deepEqual(w, []);
});

test("state: a repeated event does not add a second row", () => {
  const e = ev(1, "ask.raised", { ask: "a1", summary: "x" });
  assert.equal(applyWaiting(applyWaiting([], e), e).length, 1);
});

test("state: a hold reads as a sentence, whatever it carries", () => {
  assert.equal(fromHeld({ id: "g2" }).title, "an agent drafted a message to someone");
  assert.equal(fromHeld({ id: "g3", agent: "kit", kind: "spend", to: ["a@x.example", "b@x.example"] }).title, "kit drafted a payment to a@x.example and 1 more");
});

test("state: a reply streams in pieces and the whole message wins", () => {
  let r = reply("t1");
  // The switchboard's shapes: pieces are {message, delta}, the whole block {message, text, done: true}.
  r = applyReply(r, ev(1, "thread.text", { message: "m1", delta: "The Q3 " }, { thread: "t1" }));
  r = applyReply(r, ev(2, "thread.text", { message: "m1", delta: "numbers" }, { thread: "t1" }));
  assert.equal(replyText(r), "The Q3 numbers");
  r = applyReply(r, ev(3, "thread.text", { message: "m9", text: "other thread" }, { thread: "t2" }));
  assert.equal(replyText(r), "The Q3 numbers", "another thread's words never land here");
  r = applyReply(r, ev(4, "thread.tool", { id: "u1", tool: "Read", summary: "Read deck.md", phase: "started" }, { thread: "t1" }));
  r = applyReply(r, ev(5, "thread.tool", { id: "u1", phase: "done" }, { thread: "t1" }));
  assert.deepEqual(r.tools, [{ id: "u1", summary: "Read deck.md", done: true, error: false }]);
  r = applyReply(r, ev(6, "thread.text", { message: "m1", text: "The Q3 numbers are in.", done: true }, { thread: "t1" }));
  r = applyReply(r, ev(7, "thread.finished", { ok: true }, { thread: "t1" }));
  assert.equal(replyText(r), "The Q3 numbers are in.");
  assert.equal(r.finished, true);
  r = applyReply(r, ev(8, "lease.changed", { holder: "deck", previous: "capsule" }, { thread: "t1" }));
  assert.equal(r.lease, "deck");
  r = applyReply(r, ev(9, "lease.changed", { holder: null, previous: "deck" }, { thread: "t1" }));
  assert.equal(r.lease, null);
  r = applyReply(r, ev(10, "thread.stopped", { code: 0, reason: "stopped" }, { thread: "t1" }));
  assert.deepEqual([r.finished, r.ok, r.error], [true, false, "the thread stopped: stopped"]);
});

test("state: a withdrawn question is an ask.answered with decision cancelled", () => {
  const w = applyWaiting([], ev(1, "ask.raised", { ask: "a1", tool: "Write", summary: "Write /w/a.txt", destination: "/w/a.txt", reason: null, holder: null }, { thread: "t1" }));
  assert.equal(w[0].sub, "to /w/a.txt");
  assert.deepEqual(applyWaiting(w, ev(2, "ask.answered", { ask: "a1", decision: "cancelled", by: "thread stopped" }, { thread: "t1" })), []);
});

test("state: a finished turn carries its cost and time, and Stop ends the reply for good", () => {
  let r = reply("t1");
  assert.deepEqual([r.cost, r.ms], [null, null]);
  r = applyReply(r, ev(1, "thread.finished", { ok: true, cost_usd: 0.0021, duration_ms: 900 }, { thread: "t1" }));
  r = applyReply(r, ev(2, "thread.finished", { ok: true, cost_usd: 0.001, duration_ms: 400 }, { thread: "t1" }));
  assert.deepEqual([r.cost?.toFixed(4), r.ms], ["0.0031", 400], "costs add up over the reply's turns");
  let c = cancel(reply("t2"));
  assert.deepEqual([c.finished, c.ok, c.error], [true, false, "stopped"]);
  c = applyReply(c, ev(3, "thread.text", { message: "m", delta: "late" }, { thread: "t2" }));
  c = applyReply(c, ev(4, "thread.stopped", { reason: "stopped" }, { thread: "t2" }));
  assert.deepEqual([replyText(c), c.error], ["", "stopped"], "nothing after Stop changes it");
});

test("state: a DM folds a turn into one agent message, text blocks joined and tools as lines", () => {
  let d = dm("juno", "t1");
  d = applyDm(d, ev(1, "thread.sent", { text: "the Q3 numbers?", surface: "deck" }, { thread: "t1" }));
  d = applyDm(d, ev(2, "thread.text", { message: "m1", delta: "Look" }, { thread: "t1" }));
  d = applyDm(d, ev(3, "thread.text", { message: "m1", delta: "ing." }, { thread: "t1" }));
  d = applyDm(d, ev(4, "thread.tool", { id: "u1", tool: "Read", summary: "Read q3.md", phase: "started" }, { thread: "t1" }));
  d = applyDm(d, ev(5, "thread.tool", { id: "u1", phase: "done" }, { thread: "t1" }));
  d = applyDm(d, ev(6, "thread.text", { message: "m1", text: "Looking.", done: true }, { thread: "t1" }));
  d = applyDm(d, ev(7, "thread.text", { message: "m2", text: "Up 4%.", done: true }, { thread: "t1" }));
  assert.equal(d?.busy, true);
  d = applyDm(d, ev(8, "thread.finished", { ok: true }, { thread: "t1" }));
  d = applyDm(d, ev(9, "thread.text", { message: "x", text: "elsewhere", done: true }, { thread: "t2" }));
  const v = dmView(/** @type {any} */ (d));
  assert.deepEqual(v.messages, [
    { id: "e1", role: "user", text: "the Q3 numbers?", at: 1000, surface: "deck" },
    { id: "m1", role: "agent", text: "Looking.\n\nUp 4%.", at: 2000, tools: [{ id: "u1", summary: "Read q3.md", done: true, error: false }], done: true, error: null },
  ]);
  assert.equal(v.busy, false);
  assert.equal(applyDm(d, ev(8, "thread.text", { message: "m3", text: "again", done: true }, { thread: "t1" })), d, "an event already folded is not folded twice");
});

test("state: a DM's pending words are reconciled by thread.sent, never duplicated, and dropped on failure", () => {
  let d = dmPending(dm("juno", null), "p1", "hello  there", 5);
  assert.deepEqual(dmView(d).messages, [{ id: "p1", role: "user", text: "hello  there", at: 5, pending: true }]);
  d = /** @type {any} */ (applyDm(d, ev(1, "thread.started", { agent: "juno", resumed: false }, { thread: "t9" })));
  assert.equal(d.thread, "t9", "the agent's new thread is followed");
  d = /** @type {any} */ (applyDm(d, ev(2, "thread.sent", { text: sentText("hello  there"), surface: "capsule" }, { thread: "t9" })));
  assert.deepEqual(dmView(d).messages, [{ id: "e2", role: "user", text: "hello  there", at: 2000 }], "one message, with the whole words");
  d = /** @type {any} */ (applyDm(d, ev(3, "thread.text", { message: "m1", delta: "hi" }, { thread: "t9" })));
  assert.deepEqual(d.messages.map(m => m.role), ["user", "agent"]);
  // A second question while the first is answered: pending stays last, the answer goes on.
  d = dmPending(d, "p2", "and?", 6);
  d = /** @type {any} */ (applyDm(d, ev(4, "thread.text", { message: "m1", delta: " there" }, { thread: "t9" })));
  assert.deepEqual(dmView(d).messages.map(m => [m.role, m.text, Boolean(m.pending)]), [["user", "hello  there", false], ["agent", "hi there", false], ["user", "and?", true]]);
  assert.equal(dmDrop(d, "p2").messages.length, 2);
  // Adopting a thread needs the same words: someone else's send is not ours.
  const other = applyDm(dmPending(dm("kit", null), "p1", "mine", 1), ev(9, "thread.sent", { text: "theirs", surface: "capsule" }, { thread: "tx" }));
  assert.equal(other?.thread, null);
});

test("state: a DM's asks come and go with the thread's ask events, and the lease is followed", () => {
  let d = /** @type {any} */ (dm("kit", "t1"));
  d = applyDm(d, ev(1, "ask.raised", { ask: "a1", agent: "kit", tool: "Write", summary: "Write /w/a.txt", destination: "/w/a.txt" }, { thread: "t1" }));
  d = applyDm(d, ev(2, "ask.raised", { ask: "a2", tool: "Bash", summary: "ls" }, { thread: "t2" }));
  assert.deepEqual(d.asks.map(a => [a.id, a.title]), [["a1", "kit asks to Write /w/a.txt"]]);
  d = applyDm(d, ev(3, "lease.changed", { holder: "deck", previous: null }, { thread: "t1" }));
  assert.equal(d.holder, "deck");
  d = applyDm(d, ev(4, "ask.answered", { ask: "a1", decision: "allow" }, { thread: "t1" }));
  assert.deepEqual(d.asks, []);
});

test("state: a DM from threads.get, trimmed to its limit, with open asks from the table", () => {
  const events = [
    { id: 1, at: 1, type: "thread.started", payload: { agent: "juno" } },
    { id: 2, at: 2, type: "thread.sent", payload: { text: "one", surface: "capsule" } },
    { id: 3, at: 3, type: "thread.text", payload: { message: "m1", text: "echo: one", done: true } },
    { id: 4, at: 4, type: "thread.finished", payload: { ok: true } },
    { id: 5, at: 5, type: "thread.sent", payload: { text: "two", surface: "cli" } },
    { id: 6, at: 6, type: "ask.raised", payload: { ask: "old" } },
    { id: 7, at: 7, type: "thread.text", payload: { message: "m2", delta: "ech" } },
  ];
  const got = { thread: { id: "t1", status: "waiting", holder: "cli", project: null }, events,
    asks: [{ id: "a1", thread: "t1", tool: "Write", summary: "Write x", at: 6, state: "open" }] };
  const d = dmHistory(dm("juno", "t1", 3), got, x => ({ source: "ask", id: x.id, title: x.summary, sub: "", at: x.at }));
  assert.deepEqual(dmView(d).messages.map(m => [m.role, m.text, m.surface ?? null]), [["agent", "echo: one", null], ["user", "two", "cli"], ["agent", "ech", null]]);
  assert.deepEqual([d.busy, d.holder, d.last, d.asks.map(a => a.id)], [true, "cli", 7, ["a1"]]);
  const idle = dmHistory(dm("juno", "t1"), { ...got, thread: { ...got.thread, status: "idle" } }, x => /** @type {any} */ (x));
  assert.equal(idle.messages.at(-1)?.done, true, "a thread at rest has no open turn");
  // Words sent while the history loaded: already in it (after the open) means already shown.
  const mine = { ...got, events: events.map(e => (e.id === 5 ? { ...e, payload: { text: "two", surface: "capsule" } } : e)) };
  const carried = dmCarry(dmHistory(dm("juno", "t1"), mine, x => /** @type {any} */ (x)), [{ id: "p1", role: "user", text: "two", at: 9, pending: true }], 4);
  assert.equal(carried.messages.filter(m => m.role === "user").length, 2, "not duplicated");
});
