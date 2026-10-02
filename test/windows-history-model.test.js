// The Windows app's import screen words and arithmetic (local/capsule/native-win/app/ui/history-model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { includeOf, choosable, paceText, planLine, canSend, progressText, coreText, KEEPS, plainError, n, size } from "../local/capsule/native-win/app/ui/history-model.js";

const folders = [
  { id: "a", f: { cwd: "C:\\Work\\one", sessions: 3, bytes: 3000 } },
  { id: "b", f: { cwd: "/home/alex/two", sessions: 1, bytes: 10 } },
  { id: "c", f: { cwd: null, sessions: 2, bytes: 20 } },
];

test("history model: only ticked folders that have a known folder go into a plan", () => {
  assert.deepEqual(includeOf(folders, new Set(["a", "b", "c"])), ["C:\\Work\\one", "/home/alex/two"]);
  assert.deepEqual(includeOf(folders, new Set(["b"])), ["/home/alex/two"]);
  assert.equal(choosable(folders[2].f), false);
});

test("history model: Send needs a plan with sessions, a mode and a speed, none preselected", () => {
  const plan = { plan: "p", sessions: 4, bytes: 3010, folders: ["x", "y"], pace: { fast: { hours: 2 }, gentle: { days: 3 } } };
  assert.equal(canSend(plan, null, null), false);
  assert.equal(canSend(plan, "once", null), false);
  assert.equal(canSend(plan, "once", "fast"), true);
  assert.equal(canSend({ ...plan, sessions: 0 }, "once", "fast"), false);
  assert.equal(canSend(null, "sync", "gentle"), false);
  assert.equal(canSend(plan, "later", "fast"), false);
  assert.match(planLine(plan, "once"), /^Send 4 sessions \(3 KB\) from 2 projects to your Vyre server once\.$/);
  assert.match(planLine(plan, "sync"), /keep sending new ones/);
  assert.equal(planLine(null, "once"), "Nothing is chosen yet.");
});

test("history model: the two speeds say what they cost, with the plan's estimate", () => {
  const t = paceText({ fast: { hours: 1 }, gentle: { days: 3 } });
  assert.equal(t.fast, "Fast: understood in about 1 hour. Uses more of your Claude plan today.");
  assert.equal(t.gentle, "Gentle: understood over about 3 days. Barely touches your Claude plan.");
  assert.equal(KEEPS(30), "Claude Code keeps sessions for 30 days. Import now so they stay in Vyre.");
  assert.equal(KEEPS(undefined), "");
});

test("history model: progress reads in plain words for sending, stopped and finished", () => {
  assert.equal(progressText({ state: "sending", done: 5, total: 20, failed: 0, quarantined: 0 }), "Sending: 5 of 20.");
  assert.equal(progressText({ state: "stopped", done: 1, total: 20, failed: 2, quarantined: 0 }), "Stopped. What was already sent (1 session) stays on your server. 2 sessions could not be read.");
  assert.match(progressText({ state: "done", done: 20, total: 20, failed: 0, quarantined: 1 }), /^Sent 20 sessions to your server\. 1 session held back because of a secret in it\.$/);
  assert.equal(progressText(null), "");
});

test("history model: helper states and errors are text, trimmed", () => {
  assert.match(coreText({ state: "installing", message: "Getting Vyre's local helper" }), /one-time download/);
  assert.equal(coreText({ state: "starting" }), "Starting Vyre's local helper…");
  assert.equal(plainError("a\u0000b\n" + "x".repeat(400)).length, 300);
  assert.equal(plainError(""), "That did not finish.");
  assert.match(plainError("the server did not take the consent: this Mac is not paired with a box (vyre link pair <address>)"), /^This PC is not linked to your Vyre server yet/);
  assert.equal(n(1, "a", "b"), "1 a");
  assert.equal(size(2 * 1048576), "2 MB");
});
