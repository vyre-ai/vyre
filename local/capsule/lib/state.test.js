// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaiting, fromHeld, reply, applyReply, replyText } from "./state.js";

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
  r = applyReply(r, ev(1, "thread.text", { message: "m1", text: "The Q3 ", done: false }, { thread: "t1" }));
  r = applyReply(r, ev(2, "thread.text", { message: "m1", text: "numbers", done: false }, { thread: "t1" }));
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
});
