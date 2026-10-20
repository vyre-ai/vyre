// @ts-check
// A peer call that got no answer (timeout) or lost its stream (unreachable): the stalled stream is dropped, and the call is made once more on a fresh stream only when that cannot do anything twice
// (a read the manifests declare, a write the server keeps once by its key, a call that never left). Any other write is refused in plain words and is not made again.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterNoAnswer, callAgainOnce, retriesOnce, safeToRepeat, NO_ANSWER, CLOSED, MAYBE_DONE, MAYBE_DONE_CLOSED } from "./peer-retry.js";
import { READ_TOOLS } from "./read-tools.generated.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** A pretend pair of streams: the first failed, the next ones answer as `call` says. @param {(peer: string) => Promise<any>} call */
const world = (call) => {
  /** @type {string[]} */ const dropped = [];
  /** @type {string[]} */ const on = [];
  let opened = 0;
  return { dropped, on, opens: () => opened, o: { stuck: "first", drop: (/** @type {string} */ p) => { dropped.push(p); }, reopen: async () => `fresh${++opened}`, call: async (/** @type {string} */ p) => { on.push(p); return call(p); } } };
};
const timeout = () => fail("timeout", "no answer to stream.send");

test("only a timeout and a closed stream count; anything the server answered is passed on as it is", async () => {
  assert.equal(retriesOnce(timeout()), true);
  assert.equal(retriesOnce(fail("unreachable", "the connection is closed")), true);
  for (const code of ["denied", "slow_step", "server_offline", "person_session_required", "bad_input"]) {
    assert.equal(retriesOnce(fail(code, "x")), false, code);
    const w = world(async () => ({}));
    await assert.rejects(afterNoAnswer({ error: fail(code, "x"), tool: "work.chat.get", input: {}, ...w.o }), (/** @type {any} */ e) => e.code === code && e.message === "x");
    assert.deepEqual(w.on, [], "not made again");
    assert.deepEqual(w.dropped, [], "a stream that answered is kept");
  }
});

test("what is safe to repeat: the manifests' reads, and stream.send with its message id; no other write", () => {
  assert.ok(READ_TOOLS.length > 200, "the read tools are generated from the module.json files");
  assert.equal(safeToRepeat("work.chat.get", { chat: "c1" }), true, "a read");
  assert.equal(safeToRepeat("stream.read", { chat: "c1" }), true);
  assert.equal(safeToRepeat("stream.send", { chat: "c1", text: "hi", message: "0b5e7c1a-1111-4222-8333-944445555666" }), true, "the server says one message per id");
  assert.equal(safeToRepeat("stream.send", { chat: "c1", text: "hi" }), false, "with no message id a second send is a second message");
  assert.equal(safeToRepeat("stream.send", { chat: "c1", text: "hi", message: "has spaces" }), false);
  for (const w of ["stream.react", "stream.typing", "stream.open-peer", "records.create", "vault.put", "threads.send"]) assert.equal(safeToRepeat(w, { message: "m-1" }), false, `${w} is a write`);
  assert.equal(safeToRepeat("no.such-tool", {}), false);
});

test("a read that timed out: the stalled stream is dropped, a fresh one opened, and the call made once more; its answer is the answer", async () => {
  const w = world(async () => ({ chat: "c1" }));
  assert.deepEqual(await afterNoAnswer({ error: timeout(), tool: "work.chat.get", input: { chat: "c1" }, ...w.o }), { chat: "c1" });
  assert.deepEqual(w.dropped, ["first"]);
  assert.deepEqual(w.on, ["fresh1"]);
});

test("stream.send that timed out is sent once more with the same message id", async () => {
  /** @type {any[]} */ const inputs = [];
  const input = { chat: "c1", text: "Chase the invoices", message: "m-1" };
  const w = world(async () => { inputs.push(input); return { message: input.message }; });
  assert.deepEqual(await afterNoAnswer({ error: timeout(), tool: "stream.send", input, ...w.o }), { message: "m-1" });
  assert.deepEqual(w.on, ["fresh1"]);
  assert.equal(inputs[0].message, "m-1");
});

test("any other write that timed out is NOT made again: the stalled stream goes, and the person reads that it may have been done", async () => {
  for (const tool of ["stream.react", "records.create", "vault.put"]) {
    const w = world(async () => ({ ok: true }));
    await assert.rejects(afterNoAnswer({ error: timeout(), tool, input: { id: "x" }, ...w.o }), (/** @type {any} */ e) => e.code === "timeout" && e.message === MAYBE_DONE);
    assert.deepEqual(w.on, [], `${tool} was not sent a second time`);
    assert.deepEqual(w.dropped, ["first"], "the stalled stream is still dropped, so the next call opens a fresh one");
    assert.equal(w.opens(), 0);
  }
  const c = world(async () => ({ ok: true }));
  await assert.rejects(afterNoAnswer({ error: fail("unreachable", "the connection closed: ended"), tool: "records.create", input: {}, ...c.o }), (/** @type {any} */ e) => e.code === "unreachable" && e.message === MAYBE_DONE_CLOSED);
  assert.deepEqual(c.on, [], "a write cut off mid-call may have run: not made again");
  assert.match(MAYBE_DONE, /may have done it already/);
  assert.doesNotMatch(MAYBE_DONE + MAYBE_DONE_CLOSED, /—/, "no em dash");
});

test("a write on a stream that was already closed never reached the server, so it is made once more", async () => {
  const w = world(async () => ({ ok: true }));
  assert.deepEqual(await afterNoAnswer({ error: fail("unreachable", "the connection is closed"), tool: "records.create", input: {}, neverSent: true, ...w.o }), { ok: true });
  assert.deepEqual(w.on, ["fresh1"]);
});

test("a second failure of the one retry is refused in plain words, and the fresh stream is dropped too", async () => {
  const w = world(async () => { throw timeout(); });
  await assert.rejects(afterNoAnswer({ error: timeout(), tool: "work.chat.get", input: {}, ...w.o }), (/** @type {any} */ e) => e.code === "timeout" && e.message === NO_ANSWER && !/stream\.send/.test(e.message));
  assert.deepEqual(w.dropped, ["first", "fresh1"]);
  assert.equal(w.opens(), 1, "only once more, never a loop");
  const c = world(async () => { throw fail("unreachable", "the connection closed: ended"); });
  await assert.rejects(callAgainOnce(c.o), (/** @type {any} */ e) => e.code === "unreachable" && e.message === CLOSED);
  const s = world(async () => { throw fail("slow_step", "slow_step: kernel-append: the server took too long, so this message was not saved. Try again."); });
  await assert.rejects(callAgainOnce(s.o), (/** @type {any} */ e) => e.code === "slow_step", "what the server answers on the retry is passed on");
});

test("peer.ts takes the decision from peer-retry.js for a timeout and a closed stream", () => {
  const src = fs.readFileSync(new URL("./peer.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ afterNoAnswer \} from "\.\/peer-retry\.js";/);
  assert.match(src, /const neverSent = p\.closed;/);
  assert.match(src, /return await afterNoAnswer\(\{ error: e, tool, input, neverSent, stuck: p, drop, reopen: \(\) => openPeer\(id\), call: sent \}\);/);
  assert.doesNotMatch(src, /code !== "unreachable"/);
});
