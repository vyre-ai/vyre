// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { presetIntents } from "./watcher-presets.js";

const W = { project: "harlow-legal", kinds: ["mail", "calendar", "repo", "slack", "feed"] };
const keys = (t, w = W) => presetIntents(t, w).intents.map(i => i.to[0]);

test("a request to watch something records the preset for that one kind", () => {
  assert.deepEqual(keys("Watch my inbox for important mail."), ["watchers.preset:harlow-legal/mail"]);
  assert.deepEqual(keys("Please watch my calendar."), ["watchers.preset:harlow-legal/calendar"]);
  assert.deepEqual(keys("Monitor the Slack channel for court news."), ["watchers.preset:harlow-legal/slack"]);
  assert.deepEqual(keys("Watch this RSS feed."), ["watchers.preset:harlow-legal/feed"]);
});

test("nothing is recorded when it is not a plain ask, or not exactly one offered kind", () => {
  assert.deepEqual(keys("Should I watch my inbox?"), []);
  assert.deepEqual(keys("Don't watch my inbox."), []);
  assert.deepEqual(keys("Watch my inbox every morning."), [], "standing wording is a proposal, not an ask");
  assert.deepEqual(keys("Watch my inbox and my calendar."), [], "two kinds in one clause");
  assert.deepEqual(keys("Watch the weather."), [], "no kind");
  assert.deepEqual(keys("I said: > Watch my inbox\nthanks"), [], "a quote is not the person's words");
  assert.deepEqual(keys("Watch my inbox.", { ...W, kinds: ["feed"] }), [], "a kind this install does not offer");
  assert.deepEqual(keys("Watch my inbox.", null), []);
});
