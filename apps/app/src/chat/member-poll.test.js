import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { pollDuplex, PAGE, POLL_MS } from "./member-poll.js";

/** A fake door: a log of frames; `read` answers after a cursor like chat.read (200 a page). @param {number} n */
const door = (n) => {
  const frames = Array.from({ length: n }, (_, i) => ({ cur: i + 1, type: "chat.user-message", data: { text: `m${i + 1}` } }));
  const calls = /** @type {any[]} */ ([]);
  return {
    calls, frames,
    call: async (/** @type {string} */ name, /** @type {any[]} */ args) => {
      const a = args[0]; calls.push({ name, ...a });
      const got = frames.filter((f) => f.cur > a.from).slice(0, a.limit);
      return { chat: a.chat, viewer: "person:per_me", head: frames.length, floor: 1, frames: got, next: got.length ? got[got.length - 1].cur : a.from };
    },
  };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

test("history comes in full pages and each frame is handed over once, in order, then a heartbeat when caught up", async () => {
  const d = door(PAGE + 30);
  const got = /** @type {any[]} */ ([]);
  let slept = 0;
  const dx = await pollDuplex({ call: d.call, chat: "chat_1", from: 0, sleep: async () => { slept++; await tick(); } });
  assert.deepEqual(dx.info, { viewer: "person:per_me", head: PAGE + 30, floor: 1 });
  dx.onMessage((m) => got.push(m)); dx.send({ t: "subscribe", from: 0 });
  await tick(); await tick(); await tick();
  dx.close();
  const real = got.filter((m) => m.type === "chat.user-message");
  assert.deepEqual(real.map((m) => m.cur), Array.from({ length: PAGE + 30 }, (_, i) => i + 1), "every frame once, in order");
  assert.ok(got.some((m) => m.type === "chat.heartbeat" || (m.type && /heartbeat/.test(m.type)) || m.data?.head === PAGE + 30), "a heartbeat at the head");
  assert.ok(d.calls.some((c) => c.limit === PAGE), "pages of 200");
  assert.equal(d.calls[0].limit, 0, "the first call only asks where the log is");
});

test("it asks after its cursor, not from the start, and a new frame arrives once", async () => {
  const d = door(2);
  const got = /** @type {any[]} */ ([]);
  const dx = await pollDuplex({ call: d.call, chat: "chat_1", from: 2, sleep: async () => { await tick(); } });
  dx.onMessage((m) => got.push(m)); dx.send({ t: "subscribe", from: 2 });
  await tick();
  d.frames.push({ cur: 3, type: "chat.user-message", data: { text: "m3" } });
  await tick(); await tick();
  dx.close();
  assert.deepEqual(got.filter((m) => m.type === "chat.user-message").map((m) => m.cur), [3]);
  assert.ok(d.calls.slice(1).every((c) => c.from >= 2), "never from the start again");
});

test("it does not ask while the screen is hidden, and closing stops it and ends the session", async () => {
  const d = door(1);
  let shown = false, ended = 0, closedCb = 0;
  const dx = await pollDuplex({ call: d.call, chat: "chat_1", from: 0, visible: () => shown, sleep: async () => { await tick(); }, onEnd: () => { ended++; } });
  dx.onClose(() => { closedCb++; }); dx.send({ t: "subscribe", from: 0 });
  const before = d.calls.length;
  await tick(); await tick();
  assert.equal(d.calls.length, before, "no call while hidden");
  shown = true; await tick(); await tick();
  assert.ok(d.calls.length > before, "asks again when visible");
  dx.close(); dx.close();
  const after = d.calls.length;
  await tick(); await tick();
  assert.equal(d.calls.length, after, "no call after close");
  assert.deepEqual([ended, closedCb], [1, 1], "the session is ended once and the client told once");
  assert.equal(POLL_MS, 3500);
});

test("three failures in a row end it (the client reconnects with its own backoff); a reset from the door is passed on and ends it", async () => {
  let n = 0;
  const failing = async (/** @type {string} */ _n, /** @type {any[]} */ args) => { if (args[0].limit === 0) return { viewer: "x", head: 1, floor: 1, frames: [] }; n++; throw new Error("rate_limited"); };
  let closed = 0;
  const a = await pollDuplex({ call: failing, chat: "c", from: 0, sleep: async () => { await tick(); } });
  a.onClose(() => { closed++; }); a.send({ t: "subscribe", from: 0 });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(closed, 1);
  assert.equal(n, 3, "three tries, then it gives up");
  const got = /** @type {any[]} */ ([]);
  const b = await pollDuplex({ call: async (_n, args) => (args[0].limit === 0 ? { head: 1, floor: 1, frames: [] } : { reset: "behind", head: 1, frames: [] }), chat: "c", from: 0, sleep: async () => { await tick(); } });
  b.onMessage((m) => got.push(m)); b.send({ t: "subscribe", from: 0 });
  let ended = 0; b.onClose(() => { ended++; });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(got.some((m) => /reset/.test(String(m.type))), "the reset frame is handed to the client");
  assert.equal(ended, 1);
});
