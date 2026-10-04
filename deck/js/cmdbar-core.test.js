// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, score, choices, actionEntries, GROUP_ORDER } from "./cmdbar-core.js";

const E = [
  ...actionEntries({ assistant: "juno" }),
  { id: "p:harlow", group: "Projects", title: "Harlow Legal", href: "/projects/harlow" },
  { id: "p:site", group: "Projects", title: "Site", href: "/projects/site" },
  { id: "a:kit", group: "People and agents", title: "kit", meta: "Agent", href: "/agents/kit" },
  { id: "a:juno", group: "People and agents", title: "juno", meta: "Assistant", href: "/agents/juno" },
  { id: "t:1", group: "Threads", title: "Fix the footer", meta: "Site", href: "/chat/site/1" },
];

test("prefixes narrow the group; a bare word is everything", () => {
  assert.deepEqual(parseQuery("p har"), { prefix: "Projects", q: "har" });
  assert.deepEqual(parseQuery("t foot"), { prefix: "Threads", q: "foot" });
  assert.deepEqual(parseQuery("u kit"), { prefix: "People and agents", q: "kit" });
  assert.deepEqual(parseQuery("planner"), { prefix: null, q: "planner" });
  assert.deepEqual(parseQuery("pet"), { prefix: null, q: "pet" }, "a word that starts with p is not a prefix");
});

test("matches rank: starts with, then a word starts with, then inside", () => {
  const h = /** @type {any} */ (E.find(e => e.id === "p:harlow"));
  assert.equal(score(h, "har"), 3);
  assert.equal(score(h, "leg"), 2);
  assert.equal(score(h, "arlo"), 1);
  assert.equal(score(h, "zzz"), 0);
});

test("nothing typed: recents first, then a few of each group; typed: groups in order and only matches", () => {
  const empty = choices(E, "", ["a:kit", "p:site", "gone"]);
  assert.deepEqual(empty.slice(0, 2).map(e => [e.group, e.id]), [["Recent", "a:kit"], ["Recent", "p:site"]]);
  assert.ok(empty.some(e => e.group === "Actions") && empty.some(e => e.group === "Threads"));
  assert.equal(new Set(empty.map(e => e.id)).size, empty.length, "an entry appears once");
  const q = choices(E, "sit");
  assert.deepEqual(q.map(e => e.id), ["p:site", "t:1"], "only what matches, in group order: the project Site, then the thread whose meta says Site");
  assert.ok(GROUP_ORDER.indexOf("Actions") < GROUP_ORDER.indexOf("Projects"));
  assert.deepEqual(choices(E, "p ").map(e => e.id), ["p:harlow", "p:site"], "a prefix alone lists that group");
  assert.deepEqual(choices(E, "p s").map(e => e.id), ["p:site"]);
  assert.deepEqual(choices(E, "u j").map(e => e.id), ["a:juno"]);
  assert.deepEqual(choices(E, "t foo").map(e => e.id), ["t:1"]);
});

test("the action entries name the assistant when there is one", () => {
  assert.ok(actionEntries({ assistant: "juno" }).some(e => e.title === "Ask juno"));
  assert.ok(!actionEntries({}).some(e => e.title.startsWith("Ask ")));
});
