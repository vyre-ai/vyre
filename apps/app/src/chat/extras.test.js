import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { queueFrom, isSpendCapFor, spendCardData, watcherNames, showsWatcherCard } from "./extras.js";

// The shapes below are the ones the box's own code returns and emits (core/switchboard threads.queue, core/spend spend.capped, core/watchers watchers.shown).
test("threads.queue rows become the sheet's queued words, keeping the row id", () => {
  const answer = { queued: [{ queued: 12, uuid: "u-9", text: "also fix the footer", surface: "deck", at: 5, request: null }, { queued: 13, uuid: null, text: "and the header", surface: "deck", at: 6, request: null }] };
  assert.deepEqual(queueFrom(answer), [{ queued: 12, text: "also fix the footer" }, { queued: 13, text: "and the header" }]);
  assert.deepEqual(queueFrom({ queued: [] }), []);
  assert.deepEqual(queueFrom(null), []);
  assert.deepEqual(queueFrom({ queued: [{ text: "no id" }] }), []);
});

test("a spend.capped event is this chat's only when it names the chat's thread", () => {
  const e = { type: "spend.capped", payload: { provider: "claude", day: "2026-10-05", spent: 5.01, cap: 5, line: "Claude is paused at $5 for today.", thread: "th_1", action: { label: "Raise it", tool: "spend.raise", input: { provider: "claude", to: 10 } } } };
  assert.equal(isSpendCapFor(e, "th_1"), true);
  assert.equal(isSpendCapFor(e, "th_2"), false);
  assert.equal(isSpendCapFor({ type: "thread.text", payload: { thread: "th_1" } }, "th_1"), false);
  assert.deepEqual(spendCardData(e.payload), { provider: "claude", cap: 5, line: "Claude is paused at $5 for today.", action: e.payload.action });
});

test("watchers.shown names each card once, and the watcher tools are recognised by name", () => {
  const shown = { project: "p", kinds: ["mail"], watchers: [{ name: "new-lead", hash: "h1", title: "t", state: "off", project: "p", at: 1 }, { name: "new-lead", hash: "h2", title: "t", state: "off", project: "p", at: 2 }, { name: "inbox", hash: "h3", title: "t", state: "off", project: "p", at: 3 }] };
  assert.deepEqual(watcherNames(shown), ["new-lead", "inbox"]);
  assert.deepEqual(watcherNames(null), []);
  for (const t of ["watchers.card", "watchers.preset", "mcp__vyre__watchers_card"]) assert.equal(showsWatcherCard(t), true, t);
  assert.equal(showsWatcherCard("watchers.list"), false);
});

import { artifactOf, artifactHref } from "./extras.js";
test("an artifact made in a chat is read from its row key and links to its page at the version made", () => {
  // core/stream/adapter.js thread.artifact: tool_id art:<id>:<version>, words "Artifact <title>"; the folder keys the row "t:" + tool_id.
  const a = artifactOf("t:art:ar_123:2", "Artifact Lease summary");
  assert.deepEqual(a, { id: "ar_123", version: 2, title: "Lease summary" });
  assert.equal(artifactHref(a), "/a/ar_123?v=2");
  assert.equal(artifactHref({ id: "ar_1", version: 0 }), "/a/ar_1");
  assert.equal(artifactOf("t:Bash1", "x"), null);
});
