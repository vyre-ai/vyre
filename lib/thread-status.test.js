// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { THREAD_STATUSES, threadStatus } from "./thread-status.js";

test("thread-status: starting and working pass through unchanged", () => {
  assert.equal(threadStatus("starting"), "starting");
  assert.equal(threadStatus("working"), "working");
});

test("thread-status: internal waiting (an ask is open) is asking to a person", () => {
  assert.equal(threadStatus("waiting"), "asking");
});

test("thread-status: internal idle (ready, nothing open) is waiting to a person", () => {
  assert.equal(threadStatus("idle"), "waiting");
});

test("thread-status: an idle timeout, a box restart or a rewind are paused - nothing wrong happened", () => {
  assert.equal(threadStatus("stopped", "idle"), "paused");
  assert.equal(threadStatus("stopped", "restart"), "paused");
  assert.equal(threadStatus("stopped", "rewind"), "paused");
});

test("thread-status: a one-shot's done, or a bare clean exit, is finished", () => {
  assert.equal(threadStatus("stopped", "done"), "finished");
  assert.equal(threadStatus("stopped", "exited"), "finished");
});

test("thread-status: a nonzero exit code or a signal is a real crash - failed, never read back as paused", () => {
  assert.equal(threadStatus("stopped", "exited 1: boom"), "failed");
  assert.equal(threadStatus("stopped", "exited SIGKILL"), "failed");
});

test("thread-status: the person pressing Stop, or a system halt with its own text, is plain stopped - they asked for it", () => {
  assert.equal(threadStatus("stopped", "stopped"), "stopped");
  assert.equal(threadStatus("stopped", "the subscription's budget ran out"), "stopped");
  assert.equal(threadStatus("stopped", null), "stopped");
});

test("thread-status: a raw status this mapping does not know fails safe to stopped, never passed through raw", () => {
  assert.equal(threadStatus("bogus"), "stopped");
  assert.equal(threadStatus(""), "stopped");
  assert.equal(threadStatus(undefined), "stopped");
});

test("thread-status: THREAD_STATUSES lists every value threadStatus can return", () => {
  for (const raw of ["starting", "working", "waiting", "idle"]) assert.ok(THREAD_STATUSES.includes(threadStatus(raw)));
  for (const reason of ["done", "exited", "restart", "idle", "rewind", "exited 1: boom", "stopped", null])
    assert.ok(THREAD_STATUSES.includes(threadStatus("stopped", reason)));
});
