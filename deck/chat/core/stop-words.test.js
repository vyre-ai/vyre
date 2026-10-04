// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stopWords } from "./stop-words.js";

test("a stop that is not a failure says nothing", () => {
  for (const r of [null, "", "idle", "restart", "rewind", "done", "exited", "stop"]) assert.equal(stopWords(r), null, String(r));
});
test("a failure says what happened and what to do, with your server's own words kept", () => {
  const a = stopWords("exited 1: Claude Code process exited with code 1");
  assert.equal(a?.action, "retry");
  assert.match(String(a?.line), /process stopped before it answered/);
  assert.match(String(a?.detail), /exited with code 1/);
  assert.equal(stopWords("Not signed in: run /login")?.action, "sign-in");
  assert.match(String(stopWords("429 rate limit reached")?.line), /usage limit/);
  assert.equal(stopWords("something odd")?.action, "retry");
});
