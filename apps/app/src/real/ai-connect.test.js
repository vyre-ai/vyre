// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_ACCOUNT_SAY, aiRefusal, claudeState, codeInput, keyInput, safeLink, startInput } from "./ai-connect.js";

test("each honest state: not connected, blocked with the reason, waiting, connected, failed with the reason", () => {
  assert.deepEqual(claudeState({ state: "todo", signedIn: false }), { state: "not_connected", line: "Not connected. Your assistant has no AI account yet." });
  assert.deepEqual(claudeState({ state: "blocked", why: "Claude Code is not installed on this machine" }), { state: "blocked", line: "Claude Code is not installed on this machine" });
  assert.equal(claudeState({ state: "todo" }, { waiting: true }).state, "waiting");
  assert.deepEqual(claudeState({ state: "done", signedIn: true, via: "setup-token" }), { state: "connected", line: "Connected with your Claude subscription" });
  assert.equal(claudeState({ state: "done", signedIn: true, via: "api-key" }).line, "Connected with an API key");
  assert.deepEqual(claudeState({ state: "done", signedIn: true }, { failed: "that does not look like a token" }), { state: "failed", line: "that does not look like a token" });
  assert.equal(claudeState(null).state, "not_connected");
});

test("the three moves are one onboard.claude input each, trimmed", () => {
  assert.deepEqual(startInput(), { mode: "setup-token" });
  assert.deepEqual(codeInput("  abc-123 \n"), { mode: "setup-token", code: "abc-123" });
  assert.deepEqual(keyInput(" sk-ant-x "), { mode: "api-key", key: "sk-ant-x" });
});

test("only an https sign-in link is offered, refusals are plain, and the assistant says where to connect", () => {
  assert.equal(safeLink("https://claude.ai/oauth/authorize?x=1"), "https://claude.ai/oauth/authorize?x=1");
  for (const bad of ["http://x.test", "javascript:alert(1)", "", null, "vyre://x"]) assert.equal(safeLink(bad), null, String(bad));
  assert.match(aiRefusal("not_allowed", ""), /Only the owner/);
  assert.equal(aiRefusal("x", "the box said"), "the box said");
  assert.match(NO_ACCOUNT_SAY, /no AI account yet.*Settings/);
});
