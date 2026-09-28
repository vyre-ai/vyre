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

test("thread-status: stopped is finished on a clean exit or a one-shot's done, else stopped", () => {
  assert.equal(threadStatus("stopped", "done"), "finished");
  assert.equal(threadStatus("stopped", "exited"), "finished");
  assert.equal(threadStatus("stopped", "restart"), "stopped");
  assert.equal(threadStatus("stopped", "exited 1: boom"), "stopped");
  assert.equal(threadStatus("stopped", null), "stopped");
});

test("thread-status: THREAD_STATUSES lists every value threadStatus can return", () => {
  for (const raw of ["starting", "working", "waiting", "idle"]) assert.ok(THREAD_STATUSES.includes(threadStatus(raw)));
  for (const reason of ["done", "exited", "restart", null]) assert.ok(THREAD_STATUSES.includes(threadStatus("stopped", reason)));
});
