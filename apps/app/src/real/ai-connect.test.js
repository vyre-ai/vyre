// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCONNECT_NOTE, NO_ACCOUNT_SAY, disconnectInput, aiRefusal, claudeOf, claudeState, codeInput, keyInput, safeLink, startInput } from "./ai-connect.js";

test("each honest state: not connected, blocked with the reason, waiting, connected, failed with the reason", () => {
  assert.deepEqual(claudeState({ state: "todo", signedIn: false }), { state: "not_connected", line: "Your assistant has no AI account yet. Sign in to Claude to give it one." });
  assert.deepEqual(claudeState({ state: "blocked", why: "Claude Code is not installed on this machine" }), { state: "blocked", line: "Claude Code is not installed on this machine" });
  assert.equal(claudeState({ state: "todo" }, { waiting: true }).state, "waiting");
  assert.deepEqual(claudeState({ state: "done", signedIn: true, via: "setup-token" }), { state: "connected", line: "Connected with your Claude subscription. Your assistants use it, up to the budget you set." });
  assert.equal(claudeState({ state: "done", signedIn: true, via: "api-key" }).line, "Connected with your API key. Your assistants use it, up to the budget you set.");
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

test("Claude's state is read from data.detail.claude, with the earlier shape as a fallback, and pair_first says to pair first", () => {
  const detail = { state: "done", signedIn: true, via: "api-key" };
  assert.deepEqual(claudeOf({ steps: { claude: "done" }, detail: { claude: detail }, accountName: "x" }), detail);
  assert.deepEqual(claudeOf({ claude: detail }), detail);
  assert.equal(claudeOf(null), null);
  assert.match(aiRefusal("pair_first", "x"), /Pair this server/);
});

test("UX-86 and UX-88: a browser says to connect on the phone and a server with no owner says pair first, neither with a sign-in; a connected card stays connected", () => {
  assert.deepEqual(claudeState({ state: "todo" }, { onPhone: true }), { state: "on_phone", line: "Connect it in Vyre on your phone." });
  assert.equal(claudeState({ state: "todo" }, { pairFirst: true }).state, "pair_first");
  assert.match(claudeState({ state: "todo" }, { pairFirst: true, onPhone: true }).line, /Pair this server/);
  assert.equal(claudeState({ state: "done", signedIn: true }, { onPhone: true, pairFirst: true }).state, "connected");
  assert.equal(claudeState({ state: "todo" }, { onPhone: true, failed: "x" }).state, "on_phone", "no failure sentence after a tap that was never offered");
});

test("disconnect is one onboard.claude input with the consequence line", () => {
  assert.deepEqual(disconnectInput(), { mode: "disconnect" });
  assert.match(DISCONNECT_NOTE, /Your Claude account itself is not touched/);
});

test("the first step on an unowned home depends on what it is: pair a server, or make the name on a computer", () => {
  assert.match(claudeState({ state: "todo" }, { pairFirst: true, ownerFirst: "pair" }).line, /Pair this server to your Vyre app first/);
  assert.match(claudeState({ state: "todo" }, { pairFirst: true, ownerFirst: "name" }).line, /Make your Vyre name on this computer first/);
  assert.match(claudeState({ state: "todo" }, { pairFirst: true }).line, /Pair this server/);
});

test("a computer with no owner says to make the name first", () => {
  assert.match(aiRefusal("not_a_server", "x"), /Make your Vyre name on this computer first/);
});
