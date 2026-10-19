// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "./ai-connect.js";
import { DISCONNECT_NOTE, NO_ACCOUNT_SAY, disconnectInput, aiRefusal, codeInput, safeLink, startInput } from "./ai-connect.js";

test("the moves are one onboard.claude input each, trimmed, and there is no Claude-only card state any more", () => {
  assert.deepEqual(startInput(), { mode: "setup-token" });
  assert.deepEqual(codeInput("  abc-123 \n"), { mode: "setup-token", code: "abc-123" });
  for (const gone of ["claudeState", "claudeOf", "keyInput"]) assert.equal(/** @type {any} */ (M)[gone], undefined, `${gone} drew the separate Claude card; AI accounts reads sessions.accounts.list`);
});

test("only an https sign-in link is offered, refusals are plain, and the assistant says where to connect", () => {
  assert.equal(safeLink("https://claude.ai/oauth/authorize?x=1"), "https://claude.ai/oauth/authorize?x=1");
  for (const bad of ["http://x.test", "javascript:alert(1)", "", null, "vyre://x"]) assert.equal(safeLink(bad), null, String(bad));
  assert.match(aiRefusal("not_allowed", ""), /Add your own AI account/, "each person has their own AI accounts; a refusal never sends them to the owner");
  assert.equal(aiRefusal("x", "the box said"), "the box said");
  assert.match(NO_ACCOUNT_SAY, /no AI account yet.*Settings/);
});

test("pair_first says to pair first, and a refusal with no words of its own names no provider", () => {
  assert.match(aiRefusal("pair_first", "x"), /Pair this server/);
  assert.equal(aiRefusal("x", ""), "That did not connect. Nothing was saved. Try again.");
  assert.doesNotMatch(aiRefusal("bad_code", ""), /Claude/);
});

test("disconnect is one onboard.claude input with the consequence line", () => {
  assert.deepEqual(disconnectInput(), { mode: "disconnect" });
  assert.match(DISCONNECT_NOTE, /The account itself is not touched/);
});

test("a computer with no owner says to make the name first", () => {
  assert.match(aiRefusal("not_a_server", "x"), /Make your Vyre name on this computer first/);
  assert.equal(aiRefusal("not_a_server", "x", "browser"), "Choose your Vyre name on your phone first. Then connect an AI account.");
  assert.match(aiRefusal("not_a_server", "x", "mac"), /Make your Vyre name on this computer first/);
});

test("a code from another sign-in is named as that, by the state after the #", async () => {
  const { codeMatchesFlow, WRONG_FLOW } = await import("./ai-connect.js");
  const link = "https://claude.ai/oauth/authorize?client_id=x&state=abc123&code_challenge=y";
  assert.equal(codeMatchesFlow("thecode#abc123", link), true);
  assert.equal(codeMatchesFlow("thecode#zzz999", link), false);
  assert.equal(codeMatchesFlow("thecode", link), true, "a code with no state is not judged");
  assert.equal(codeMatchesFlow("thecode#abc", "https://claude.ai/oauth/authorize?client_id=x"), true, "a link with no state is not judged");
  assert.equal(codeMatchesFlow("thecode#abc", null), true);
  assert.equal(WRONG_FLOW, "That code is from a different sign-in. Open the sign-in again.");
});
