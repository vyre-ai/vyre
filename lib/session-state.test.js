// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalOf, RAW_STATES, STATES } from "./session-state.js";

test("session-state: an open ask wins over a running status — the person, not the model, is what it's waiting on", () => {
  assert.equal(canonicalOf({ status: "working", hasOpenAsk: true }), "asking");
  assert.equal(canonicalOf({ status: "waiting", hasOpenAsk: true }), "asking");
});

test("session-state: queued words show as queued when there's no open ask", () => {
  assert.equal(canonicalOf({ status: "idle", hasQueued: true }), "queued");
  assert.equal(canonicalOf({ status: "starting", hasQueued: true }), "queued");
});

test("session-state: an ask still wins over queued words on the same thread", () => {
  assert.equal(canonicalOf({ status: "working", hasOpenAsk: true, hasQueued: true }), "asking");
});

test("session-state: stopped is stopped regardless of the other two flags", () => {
  assert.equal(canonicalOf({ status: "stopped", hasOpenAsk: true }), "stopped");
  assert.equal(canonicalOf({ status: "stopped", hasQueued: true }), "stopped");
  assert.equal(canonicalOf({ status: "stopped" }), "stopped");
});

test("session-state: the live raw states with neither flag fall to the one 'waiting' bucket", () => {
  for (const status of RAW_STATES) {
    if (status === "stopped") continue;
    assert.equal(canonicalOf({ status }), "waiting", status);
  }
});

test("session-state: an unknown or missing status fails to stopped, not to a guess", () => {
  assert.equal(canonicalOf({ status: "" }), "stopped");
  assert.equal(canonicalOf({ status: "running" }), "stopped", "the EVENT's relabelled word is not a status this lib reads directly — callers pass threads.get's raw status");
  assert.equal(canonicalOf(/** @type {any} */ ({})), "stopped");
});

test("session-state: STATES lists exactly the four canonical words, in the order surfaces should show them", () => {
  assert.deepEqual(STATES, ["queued", "asking", "waiting", "stopped"]);
});
