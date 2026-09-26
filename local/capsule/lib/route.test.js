// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { age, mention, complete, bestThread, destinations, describe } from "./route.js";

const NOW = Date.parse("2026-09-24T14:40:00Z");
const DAY = 86_400_000;
/** @type {import("./route.js").Catalog} */
const CAT = {
  agents: [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent", doing: "ads audit" }, { name: "pax", kind: "agent" }],
  projects: [
    { slug: "harlow-legal", name: "Harlow Legal", org: "Rivera Studio", home: "/w/harlow", threads: 4, last: NOW - 2 * 3600_000 },
    { slug: "northwind-bakery", name: "Northwind Bakery", home: "/w/northwind", threads: 3, last: NOW - DAY },
  ],
  threads: [
    { id: "aaaa1111", label: "Q3 report", project: "harlow-legal", projectName: "Harlow Legal", last: NOW - 4 * DAY, cwd: "/w/harlow/q3" },
    { id: "bbbb2222", label: "Intake form rebuild", project: "harlow-legal", projectName: "Harlow Legal", last: NOW - 2 * 3600_000 },
    { id: "cccc3333", label: "Northwind invoices", project: "northwind-bakery", projectName: "Northwind Bakery", last: NOW - DAY },
    { id: "dddd4444", label: "Weekly planning", project: null, projectName: null, cwd: "/w", last: NOW - 3 * DAY },
  ],
};

test("route: ages read the way the boards write them", () => {
  assert.equal(age(NOW - 30_000, NOW), "now");
  assert.equal(age(NOW - 18 * 60_000, NOW), "18 min");
  assert.equal(age(NOW - 4 * DAY, NOW), "4 days");
  assert.equal(age(NOW - DAY, NOW), "1 day");
  assert.equal(age(0, NOW), "");
});

test("route: an @ is being completed only while the caret is inside it", () => {
  assert.deepEqual(mention("@ha"), { completing: "ha", start: 0, end: 3 });
  assert.equal(mention("ask @").completing, "");
  assert.equal(mention("@kit the deck").completing, null, "a finished word is not being completed");
  assert.equal(mention("mail dana@harlow").completing, null, "an address is not a mention");
  assert.equal(mention("@kit the deck", 3).completing, "ki");
});

test("route: @ completes agents, projects and threads, best match first", () => {
  assert.deepEqual(complete("har", CAT).map(c => c.label), ["Harlow Legal"]);
  assert.deepEqual(complete("k", CAT).map(c => c.label)[0], "kit");
  assert.equal(complete("north", CAT)[0].kind, "project", "a project outranks its thread on the same match");
  assert.deepEqual(complete("rebuild", CAT).map(c => c.id), ["bbbb2222"]);
  const empty = complete("", CAT).map(c => c.kind);
  assert.deepEqual(empty.slice(0, 3), ["agent", "agent", "agent"], "right after @, agents come first");
  assert.equal(complete("", CAT, 50).filter(c => c.kind === "thread")[0].label, "Intake form rebuild", "then the most recent");
  assert.deepEqual(complete("zzz", CAT), []);
});

test("route: a thread is chosen from words, never guessed from none", () => {
  const hit = bestThread("the Q3 report numbers for Dana", CAT.threads);
  assert.equal(hit && hit.thread.id, "aaaa1111");
  assert.deepEqual(hit && hit.matched, ["report"]);
  assert.equal(bestThread("hello there", CAT.threads), null);
  assert.equal(bestThread("rebuilding the intake", CAT.threads)?.thread.id, "bbbb2222", "rebuilding agrees with rebuild");
});

test("route: with no @ it goes to the assistant, or to memory when there is none", () => {
  assert.deepEqual(destinations(null, "what is left", CAT).options.map(d => [d.kind, d.agent]), [["assistant", "juno"]]);
  assert.equal(destinations(null, "x", { ...CAT, agents: null }).options[0].kind, "recall");
});

test("route: @agent goes to the thread its words match, with its current thread as the other choice", () => {
  const kit = complete("kit", CAT)[0];
  const threads = CAT.threads.slice(0, 2).map(t => ({ ...t, agent: "kit" }));
  const d = destinations(kit, "the Harlow deck needs the Q3 report numbers", CAT, { agentThreads: threads, now: NOW });
  assert.equal(d.options[0].kind, "thread");
  assert.equal(d.options[0].thread, "aaaa1111");
  assert.equal(d.options[0].meta, "thread · 4 days");
  assert.equal(d.options[1].kind, "agent", "the other choice is its current thread; agents.ask cannot start a new one");
  assert.deepEqual(describe(d.options[1]), { who: "kit", where: ["current thread"] });
  const onCurrent = { ...CAT, agents: CAT.agents.map(a => (a.name === "kit" ? { ...a, thread: "aaaa1111" } : a)) };
  assert.equal(destinations(kit, "the Q3 report numbers", onCurrent, { agentThreads: threads }).options.length, 1, "the match is its current thread: one choice");
  assert.match(String(d.why), /"report" matched Q3 report/);
  assert.deepEqual(describe(d.options[0]), { who: "kit", where: ["Harlow Legal", "Q3 report"] });
  assert.equal(destinations(kit, "hello", CAT, { agentThreads: threads }).options[0].kind, "agent", "no match: the agent's current thread");
});

test("route: @project starts a new thread there, or joins the thread its words match", () => {
  const harlow = complete("harlow", CAT)[0];
  const fresh = destinations(harlow, "draft a welcome note", CAT, { now: NOW });
  assert.deepEqual(fresh.options.map(d => d.kind), ["new-thread", "thread"]);
  assert.equal(fresh.options[0].cwd, "/w/harlow");
  assert.equal(fresh.options[1].thread, "bbbb2222", "the other choice is its latest thread");
  const joined = destinations(harlow, "fix the intake form", CAT, { now: NOW });
  assert.equal(joined.options[0].thread, "bbbb2222");
});

test("route: @thread types into that thread", () => {
  const t = complete("weekly", CAT)[0];
  const d = destinations(t, "anything", CAT, { now: NOW });
  assert.deepEqual(d.options.map(o => [o.kind, o.thread]), [["thread", "dddd4444"]]);
});
