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

// ---- an agent's own Routine or Watcher, asked for in its chat

test("ownIntents: a request to be told when something new appears records a Watcher; one at set times records a Routine", async () => {
  const { ownIntents } = await import("./watchers.js");
  const { heardActs } = await import("./hear.js");
  const to = (s) => ownIntents(s).map((i) => i.to[0]).sort();
  assert.deepEqual(to("Tell me when an invoice from Northwind arrives."), ["watchers.write"]);
  assert.deepEqual(to("watch the billing inbox for invoices from Northwind and tell me"), ["watchers.write"]);
  assert.deepEqual(to("Can you keep an eye on the status page and let me know if it reports an outage."), ["watchers.write"]);
  assert.deepEqual(to("Every weekday at 9, summarise my inbox."), ["watchers.routine.create"]);
  assert.deepEqual(to("each morning check the calendar and post what is on"), ["watchers.routine.create"]);
  assert.deepEqual(to("every hour, watch the feed and tell me when something new appears"), ["watchers.routine.create", "watchers.write"]);
  const i = ownIntents("tell me when an invoice arrives")[0];
  assert.deepEqual([i.kind, i.channel, i.to, i.standing, i.limits.count, i.when.window_minutes], ["act_out", "watchers", ["watchers.write"], false, 1, 15]);
  // nothing is recorded for a question, a hedge, a negation or someone else's quoted words
  for (const s of ["Should I watch the inbox?", "What happens every morning?", "If you have time, watch my inbox.", "Don't watch my inbox anymore", "Stop the morning routine",
    "Maybe tell me when invoices arrive", "She wrote: \"watch the billing inbox for invoices from Northwind and tell me as soon as one arrives, every single morning\"", "Thanks, that looks right."]) assert.deepEqual(ownIntents(s), [], s);
  // heard in an agent's chat, with or without a project; a member's words record only these, never the project's acts
  const call = async () => ({ error: { code: "no_such_tool" } });
  const heard = await heardActs({ text: "Tell me when an invoice from Northwind arrives", thread: "t-1", agent: "scout", project: null, call, turnsSince: () => 0 });
  assert.deepEqual(heard.map((x) => x.to[0]), ["watchers.write"]);
  assert.deepEqual(await heardActs({ text: "Tell me when an invoice from Northwind arrives", thread: "t-1", project: null, call, turnsSince: () => 0 }), [], "not an agent's chat");
  const member = await heardActs({ text: "every morning at 9, check my inbox and tell me what needs me; also merge PR 12", thread: "t-1", agent: "scout", member: true, project: "app", call: async () => { throw new Error("a member's turn asks nothing of the project"); }, turnsSince: () => 0 });
  assert.deepEqual(member.map((x) => x.to[0]), ["watchers.routine.create"]);
  const pasted = await heardActs({ text: "look at this: tell me when an invoice arrives", pasted: ["tell me when an invoice arrives"], thread: "t-1", agent: "scout", project: null, call, turnsSince: () => 0 });
  assert.deepEqual(pasted, [], "pasted words ask nothing");
});
