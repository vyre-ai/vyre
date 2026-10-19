import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalWords, sendFirst, watchReadiness } from "./new-thread-model.js";

const calls = () => {
  const log = [];
  return { log, c: { start: async (a) => { log.push(["start", a]); return { thread: "t1" }; }, send: async (t, x) => { log.push(["send", t, x]); } } };
};

test("a new thread makes nothing on the server until the first message, and the first message makes exactly one thread and posts the words into it", async () => {
  const { log, c } = calls();
  assert.equal(await sendFirst({ name: "Qi", text: "   " }, c), null, "an empty message makes nothing");
  assert.deepEqual(log, [], "nothing was called before there were words");
  const r = await sendFirst({ name: "Qi", text: "  Draft the lease reply  " }, c);
  assert.deepEqual(r, { thread: "t1" });
  assert.deepEqual(log, [["start", "Qi"], ["send", "t1", "Draft the lease reply"]], "one thread, then the trimmed words into it: the message is in the thread it opens");
});

test("a refusal is a plain line and the person stays: the thread is kept, so Send again posts into the same thread and makes no second", async () => {
  const log = [];
  const refusing = { start: async (a) => { log.push(["start", a]); return { thread: "t9" }; }, send: async (t, x) => { log.push(["send", t, x]); throw new Error("an assistant in a chat belongs to the Space"); } };
  const first = await sendFirst({ name: "Juno", text: "hello" }, refusing);
  assert.deepEqual(first, { thread: "t9", problem: "an assistant in a chat belongs to the Space" }, "the box's own sentence, with the thread that was made");
  assert.equal("problem" in first && !!first.thread, true);
  const accepting = { start: async () => { log.push(["start-again"]); return { thread: "t10" }; }, send: async (t, x) => { log.push(["send", t, x]); } };
  const second = await sendFirst({ name: "Juno", text: "hello", thread: first.thread }, accepting);
  assert.deepEqual(second, { thread: "t9" }, "the retry lands in the same thread");
  assert.equal(log.some((l) => l[0] === "start-again"), false, "no second thread was made");
  assert.deepEqual(log.filter((l) => l[0] === "send").map((l) => l[1]), ["t9", "t9"]);
});

test("a thread that cannot be made says why and posts nothing; a refusal with no sentence says it was not sent", async () => {
  const log = [];
  assert.deepEqual(await sendFirst({ name: "Qi", text: "hi" }, { start: async () => ({ problem: "This device isn't ready for private chats yet." }), send: async () => { log.push("sent"); } }), { problem: "This device isn't ready for private chats yet." });
  assert.deepEqual(log, [], "no message was posted");
  const r = await sendFirst({ name: "Qi", text: "hi" }, { start: async () => ({ thread: "t2" }), send: async () => { throw new Error(""); } });
  assert.deepEqual(r, { thread: "t2", problem: "The message was not sent. Try again." });
  assert.equal(refusalWords("Error: boom").startsWith("The message"), true, "a bare Error label is not shown");
});

test("a device that is not ready is asked again on a timer and becomes ready when the check passes; coming back asks at once", async () => {
  const answers = ["This device can't start private chats yet.", "This device isn't ready for private chats yet.", null];
  const heard = [];
  let tick = null, cleared = 0, asked = 0;
  const w = watchReadiness({ check: async () => answers[asked++], on: (g) => heard.push(g), every: 5000, timers: { set: (f, ms) => { assert.equal(ms, 5000); tick = f; return 7; }, clear: (t) => { assert.equal(t, 7); cleared++; } } });
  await w.again();
  assert.deepEqual(heard, ["This device can't start private chats yet."], "the first answer is the refusal");
  tick(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(heard.slice(1), ["This device isn't ready for private chats yet."], "asked again on the timer");
  tick(); await new Promise((r) => setImmediate(r));
  assert.equal(heard.at(-1), null, "ready once the check passes");
  assert.equal(cleared, 1, "the timer stops when it is ready");
  await w.again();
  assert.equal(asked, 4, "coming back asks at once");
  w.stop();
});

test("a check that throws is a refusal, not a crash, and a stopped watcher says nothing more", async () => {
  const heard = [];
  const w = watchReadiness({ check: async () => { throw new Error("x"); }, on: (g) => heard.push(g), every: 10, timers: { set: () => 1, clear: () => {} } });
  await w.again();
  assert.deepEqual(heard, ["Vyre did not answer."]);
  w.stop(); await w.again();
  assert.equal(heard.length, 1);
});
