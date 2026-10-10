import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lazySocket } from "./lazy-socket.js";

const fakeSocket = () => { const s = /** @type {any} */ ({ readyState: 0, sent: [], closedWith: null, send(d) { this.sent.push(d); }, close(c, r) { this.closedWith = [c, r]; } }); return s; };
const tick = () => new Promise(r => setTimeout(r, 5));

test("what the page sends before the real socket is open is held and sent once, in order, when it opens; its messages and end come back", async () => {
  const real = fakeSocket();
  const s = lazySocket(async () => real, "/v1/streams/computers/glass?ticket=t");
  const events = /** @type {string[]} */ ([]);
  s.onopen = () => events.push("open"); s.onmessage = (/** @type {any} */ e) => events.push("msg:" + e.data); s.onclose = (/** @type {any} */ e) => events.push("close:" + e.code);
  s.send("a"); s.send("b");
  await tick();
  assert.deepEqual(real.sent, [], "nothing goes before it is open");
  real.readyState = 1; real.onopen({});
  assert.deepEqual(real.sent, ["a", "b"]);
  assert.equal(s.readyState, 1);
  real.onmessage({ data: "hello" }); real.onclose({ code: 1000, reason: "" });
  assert.deepEqual(events, ["open", "msg:hello", "close:1000"]);
  s.send("late"); // after it ended, a send goes to the real socket, which refuses it
  assert.equal(s.readyState, 3);
});

test("a socket that cannot be had is a close the page hears (1006), and a close before it opens closes the real one when it arrives", async () => {
  const s = lazySocket(async () => { throw new Error("no channel"); }, "/x");
  const heard = /** @type {any[]} */ ([]);
  s.onclose = (/** @type {any} */ e) => heard.push(e.code);
  await tick();
  assert.deepEqual(heard, [1006]);
  const real = fakeSocket();
  const t = lazySocket(async () => real, "/y");
  t.close(1000, "done");
  await tick();
  assert.deepEqual(real.closedWith, [1000, "closed before it opened"]);
});
