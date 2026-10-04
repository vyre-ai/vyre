// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { watchersIntents } from "./watchers.js";

const W = {
  project: "harlow-legal",
  kinds: ["mail", "calendar", "repo", "slack", "feed"],
  watchers: [{ name: "mail-harlow-legal", hash: "0123456789abcdef0123456789abcdef", title: "important mail", state: "draft", shownTurnsAgo: 0 }],
};
const keys = (t, w = W) => watchersIntents(t, w).intents.map(i => i.to[0]);

test("a request to watch something records the preset for that one kind", () => {
  assert.deepEqual(keys("Watch my inbox for important mail."), ["watchers.preset:harlow-legal/mail"]);
  assert.deepEqual(keys("Please watch my calendar."), ["watchers.preset:harlow-legal/calendar"]);
  assert.deepEqual(keys("Monitor the Slack channel for court news."), ["watchers.preset:harlow-legal/slack"]);
  assert.deepEqual(keys("Watch this RSS feed."), ["watchers.preset:harlow-legal/feed"]);
});

test("turning it on records the one watcher waiting, pinned to the hash the card showed", () => {
  const key = "watchers.create:harlow-legal/mail-harlow-legal@0123456789abcdef0123456789abcdef";
  for (const t of ["Yes, turn it on.", "Go ahead and turn it on", "Turn that on.", "Enable it."]) assert.deepEqual(keys(t), [key], t);
  assert.deepEqual(keys("Turn on the mail watcher."), [key]);
  assert.deepEqual(keys("Switch the important mail watcher on."), [key]);
});

test("nothing is recorded when it is not a plain ask, or not exactly one thing", () => {
  assert.deepEqual(keys("Should I turn it on?"), []);
  assert.deepEqual(keys("Turn it on if the card looks right."), [], "a condition");
  assert.deepEqual(keys("Turn it off."), []);
  assert.deepEqual(keys("Don't turn it on yet."), []);
  assert.deepEqual(keys("Watch my inbox every morning."), [], "standing wording is a proposal, not an ask");
  assert.deepEqual(keys("Watch my inbox and my calendar."), [], "two kinds in one clause");
  assert.deepEqual(keys("Watch the weather."), [], "no kind");
  assert.deepEqual(keys("I said: > Watch my inbox\nthanks"), [], "a quote is not the person's words");
  assert.deepEqual(keys("Turn it on.", { ...W, watchers: [] }), [], "nothing is waiting");
  const two = { ...W, watchers: [...W.watchers, { name: "feed-news", hash: "ffffffffffffffffffffffffffffffff", title: "news", state: "draft", shownTurnsAgo: 1 }] };
  assert.deepEqual(keys("Turn it on.", two), [], "two are waiting, so it is ambiguous");
  assert.deepEqual(keys("Turn on the news watcher.", two), ["watchers.create:harlow-legal/feed-news@ffffffffffffffffffffffffffffffff"]);
  assert.deepEqual(keys("Turn on the mail watcher.", { ...W, watchers: [{ ...W.watchers[0], state: "on" }] }), [], "one already on");
  assert.deepEqual(keys("Watch my inbox.", { ...W, kinds: ["feed"] }), [], "a kind this install does not offer");
});

test("\"turn it on\" binds only to a card shown in the last two assistant turns", () => {
  const key = "watchers.create:harlow-legal/mail-harlow-legal@0123456789abcdef0123456789abcdef";
  const at = n => ({ ...W, watchers: [{ ...W.watchers[0], shownTurnsAgo: n }] });
  assert.deepEqual(keys("Turn it on.", at(0)), [key]);
  assert.deepEqual(keys("Turn it on.", at(1)), [key]);
  assert.deepEqual(keys("Turn it on.", at(2)), [], "an unrelated yes several turns after the card");
  assert.deepEqual(keys("Yes, enable it.", at(5)), []);
  assert.deepEqual(keys("Turn it on.", { ...W, watchers: [{ ...W.watchers[0], shownTurnsAgo: undefined }] }), [], "no age, no pronoun");
  assert.deepEqual(keys("Turn on the mail watcher.", at(5)), [key], "naming it works however long ago");
  const two = { ...W, watchers: [{ ...W.watchers[0], shownTurnsAgo: 0 }, { name: "old", hash: "11", state: "draft", shownTurnsAgo: 7 }] };
  assert.deepEqual(keys("Turn it on.", two), [key], "an old card does not make it ambiguous");
});
