// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { homePath } from "./home.js";

const T = "0f3c9a1e-5b7d-4c2a-9e10-aa11bb22cc33";
const fake = answers => async name => (name in answers ? (answers[name] instanceof Error ? { error: answers[name] } : { data: answers[name] }) : { error: new Error("no such tool") });

test("/ goes to the assistant's daily thread", async () => {
  assert.equal(await homePath(fake({ "assistant.daily": { rolled: false, thread: T } })), `/chat/thread/${T}`);
});
test("a deferred day falls back to the assistant's own thread in agents.list", async () => {
  assert.equal(await homePath(fake({ "assistant.daily": { deferred: true }, "agents.list": [{ kind: "agent", thread: "x" }, { kind: "assistant", thread: T }] })), `/chat/thread/${T}`);
});
test("no assistant module and no assistant agent: Now, as before; a thread that is not an id is never used", async () => {
  assert.equal(await homePath(fake({})), "/now");
  assert.equal(await homePath(fake({ "assistant.daily": { thread: "../../etc" } })), "/now");
});
