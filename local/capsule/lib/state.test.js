// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaiting, fromHeld, reply, applyReply, replyText, cancel } from "./state.js";

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
