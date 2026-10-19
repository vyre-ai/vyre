import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendFirst, watchReadiness } from "./new-thread-model.js";

const calls = () => {
  const log = [];
  return { log, c: { start: async (a) => { log.push(["start", a]); return { thread: "t1" }; }, send: async (t, x) => { log.push(["send", t, x]); }, keep: (t, x) => log.push(["keep", t, x]) } };
};

test("a new thread makes nothing on the server until the first message, and the first message makes exactly one thread and posts the words", async () => {
  const { log, c } = calls();
  assert.equal(await sendFirst({ name: "Qi", text: "   " }, c), null, "an empty message makes nothing");
  assert.deepEqual(log, [], "nothing was called before there were words");
  const r = await sendFirst({ name: "Qi", text: "  Draft the lease reply  " }, c);
  assert.deepEqual(r, { thread: "t1" });
  assert.deepEqual(log, [["start", "Qi"], ["send", "t1", "Draft the lease reply"]], "one thread, then the trimmed words into it");
});

test("a thread that cannot be made says why and posts nothing; words that cannot be posted wait in the thread's box", async () => {
  const log = [];
  assert.deepEqual(await sendFirst({ name: "Qi", text: "hi" }, { start: async () => ({ problem: "This device isn't ready for private chats yet." }), send: async () => { log.push("sent"); }, keep: () => log.push("kept") }), { problem: "This device isn't ready for private chats yet." });
  assert.deepEqual(log, [], "no message was posted and no draft kept");
  const { log: l2, c } = calls();
  c.send = async () => { throw new Error("offline"); };
  assert.deepEqual(await sendFirst({ name: "Qi", text: "hi" }, c), { thread: "t1" });
  assert.deepEqual(l2, [["start", "Qi"], ["keep", "t1", "hi"]]);
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
