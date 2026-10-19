// @ts-check
// A peer call that got no answer (timeout) or lost its stream (unreachable) is made once more on a fresh stream, and the stalled stream is dropped; a second failure is refused in plain words.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { callAgainOnce, retriesOnce, NO_ANSWER, CLOSED } from "./peer-retry.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** A pretend pair of streams: the first stalls, the second answers as told. @param {(peer: string) => Promise<any>} call */
const world = (call) => {
  /** @type {string[]} */ const dropped = [];
  let opened = 0;
  return { dropped, opens: () => opened, o: { stuck: "first", drop: (/** @type {string} */ p) => { dropped.push(p); }, reopen: async () => `fresh${++opened}`, call } };
};

test("a timeout and a closed stream earn one more try; anything the server answered does not", () => {
  assert.equal(retriesOnce(fail("timeout", "no answer to stream.send")), true);
  assert.equal(retriesOnce(fail("unreachable", "the connection is closed")), true);
  for (const code of ["denied", "slow_step", "server_offline", "person_session_required", "bad_input"]) assert.equal(retriesOnce(fail(code, "x")), false, code);
  assert.equal(retriesOnce(null), false);
});

test("after a timeout the stalled stream is dropped, a fresh one opened, and the call made once more: its answer is the answer", async () => {
  /** @type {string[]} */ const on = [];
  const w = world(async (p) => { on.push(p); return { message: "m1" }; });
  assert.deepEqual(await callAgainOnce(w.o), { message: "m1" });
  assert.deepEqual(w.dropped, ["first"], "the stalled stream is dropped, so no later call waits on it");
  assert.equal(w.opens(), 1);
  assert.deepEqual(on, ["fresh1"], "the call went out once more, on the fresh stream");
});

test("a second timeout is refused in plain words, and the fresh stream is dropped too", async () => {
  const w = world(async () => { throw fail("timeout", "no answer to stream.send"); });
  await assert.rejects(callAgainOnce(w.o), (/** @type {any} */ e) => e.code === "timeout" && e.message === NO_ANSWER && !/stream\.send/.test(e.message));
  assert.deepEqual(w.dropped, ["first", "fresh1"]);
  assert.equal(w.opens(), 1, "only once more, never a loop");
  const c = world(async () => { throw fail("unreachable", "the connection closed: ended"); });
  await assert.rejects(callAgainOnce(c.o), (/** @type {any} */ e) => e.code === "unreachable" && e.message === CLOSED);
});

test("what the server answers on the second try is passed on as it is", async () => {
  const w = world(async () => { throw fail("slow_step", "slow_step: kernel-append: the server took too long, so this message was not saved. Try again."); });
  await assert.rejects(callAgainOnce(w.o), (/** @type {any} */ e) => e.code === "slow_step");
  assert.deepEqual(w.dropped, ["first"], "a stream that answered is kept");
});

test("peer.ts takes the one retry from peer-retry.js for both a timeout and a closed stream", () => {
  const src = fs.readFileSync(new URL("./peer.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ callAgainOnce, retriesOnce \} from "\.\/peer-retry\.js";/);
  assert.match(src, /if \(!retriesOnce\(e\)\) throw e;/);
  assert.match(src, /return await callAgainOnce\(\{ stuck: p, drop, reopen: \(\) => openPeer\(id\), call: sent \}\);/);
  assert.doesNotMatch(src, /code !== "unreachable"/, "a timeout is no longer sent straight to the screen");
});
