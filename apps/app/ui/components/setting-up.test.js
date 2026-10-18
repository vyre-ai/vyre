// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSettingUp, SETTING_UP_WORDS, SETTING_UP_RETRY_MS } from "./setting-up.js";

test("a load that failed because Records is still being set up is told apart from a real failure", () => {
  assert.equal(isSettingUp("Records is setting up, this takes a few minutes: getting ready (1 second so far)"), true);
  assert.equal(isSettingUp("the record store is still starting: getting ready (2 minutes so far)"), true);
  assert.equal(isSettingUp("the record store for this space is not available yet"), true);
  assert.equal(isSettingUp("the store could not list its types"), true, "the store is attached but still making its types: the gateway's plain sentence is the same wait");
  assert.equal(isSettingUp("no such type agent"), false);
  assert.equal(isSettingUp(undefined), false);
  assert.equal(isSettingUp(""), false);
  assert.match(SETTING_UP_WORDS.title, /setting up/);
  assert.ok(SETTING_UP_RETRY_MS >= 1000, "a quiet retry, not a flood");
});
