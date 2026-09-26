// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { age, mention, complete, bestThread, destinations, describe, ownThings, asksQuestion, rank } from "./route.js";

const NOW = Date.parse("2026-09-24T14:40:00Z");
const DAY = 86_400_000;
/** @type {import("./route.js").Catalog} */
const CAT = {
  agents: [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent", doing: "ads audit" }, { name: "pax", kind: "agent" }],
  projects: [
    { slug: "harlow-legal", name: "Harlow Legal", org: "Rivera Studio", home: "/w/harlow", threads: 4, last: NOW - 2 * 3600_000, people: [{ name: "Dana Reyes" }] },
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

const kinds = d => d.options.map(o => [o.kind, o.agent || o.model]);

test("route: a general question goes to a fast model first, then the assistant, then deeper", () => {
  const d = destinations(null, "What is the capital of Peru?", CAT, { quick: true });
  assert.deepEqual(kinds(d), [["quick", "haiku"], ["assistant", "juno"], ["quick", "sonnet"]]);
  assert.equal(d.options[0].meta, "fast model · haiku");
  assert.deepEqual([d.options[2].deep, d.options[2].meta], [true, "deeper · sonnet"]);
  assert.deepEqual(describe(d.options[0]), { who: "Claude", where: [], meta: "fast model · haiku" });
  assert.deepEqual(describe(d.options[2]), { who: "Claude · deeper", where: [], meta: "deeper · sonnet" });
  assert.equal(d.why, null);
});

test("route: a question about the user's own things goes to the assistant first", () => {
  for (const q of ["what did Dana say about the retainer?", "Where is the Harlow Legal deck?", "what is kit doing?",
    "what's on my calendar tomorrow?", "did I email the Q3 report?", "how many clients do we have?", "what is left this week"]) {
    const d = destinations(null, q, CAT, { quick: true });
    assert.deepEqual(kinds(d), [["assistant", "juno"], ["quick", "haiku"], ["quick", "sonnet"]], q);
    assert.match(String(d.why), /juno answers with your memory/, q);
  }
  assert.equal(ownThings("how do I center a div?", CAT), null, "I without a work noun is a general question");
  assert.equal(ownThings("what is weekly inflation in Peru?", CAT), null, "one word of a thread's name does not name it");
  assert.match(String(ownThings("any news on Weekly planning?", CAT)), /Weekly planning/);
});

test("route: a question with no assistant goes to the model, and with no switchboard to memory", () => {
  const none = { ...CAT, agents: null };
  assert.deepEqual(kinds(destinations(null, "what did Dana say?", none, { quick: true })), [["quick", "haiku"], ["quick", "sonnet"]]);
  assert.deepEqual(kinds(destinations(null, "why is the sky blue?", { ...CAT, agents: [] }, { quick: true })), [["quick", "haiku"], ["quick", "sonnet"]]);
  assert.deepEqual(kinds(destinations(null, "why is the sky blue?", none)), [["recall", undefined]], "no switchboard: memory, as before");
  assert.deepEqual(kinds(destinations(null, "why is the sky blue?", CAT)), [["assistant", "juno"]], "no threads.start: as before");
});

test("route: commands keep the assistant, however they read", () => {
  for (const c of ["send the invoice to the printer", "draft a welcome note for new clients", "harlow"]) {
    assert.deepEqual(kinds(destinations(null, c, CAT, { quick: true })), [["assistant", "juno"]], c);
    assert.equal(asksQuestion(c), false, c);
  }
  assert.equal(asksQuestion("can you send the invoice?"), true);
});

test("rank: files are tasted and capped, more when the box reads as a filename, three from the box", async () => {
  const { homedir } = await import("node:os");
  const home = homedir();
  const f = (label, dir, extra = {}) => ({ kind: "file", id: `file:${dir}/${label}`, label, sub: "", last: 0, target: `${dir}/${label}`, ...extra });
  const files = [
    f("invoice.ts", `${home}/code/app/src`, { repo: true }),
    ...Array.from({ length: 9 }, (_, i) => f(`Invoice ${i}.pdf`, `${home}/Documents`)),
    f("reinvoiced.pdf", `${home}/Documents`),
  ];
  const plain = rank("invoice", { files });
  assert.equal(plain.length, 4, "about four file rows");
  assert.ok(plain.every(r => r.label.startsWith("Invoice ")), "documents before the repo file and the substring");
  assert.equal(rank("invoice pdf", { files }).length, 8, "a filename-looking query shows up to eight");
  const box = Array.from({ length: 5 }, (_, i) => ({ kind: "boxfile", id: `box:/srv/invoice${i}.pdf`, label: `invoice${i}.pdf`, sub: "box · /srv", last: 0, target: `/srv/invoice${i}.pdf`, source: "box" }));
  const mixed = rank("invoice", { files: files.slice(0, 2), box });
  assert.equal(mixed.filter(r => r.kind === "boxfile").length, 3);
  const app = [{ kind: "app", id: "app:/A/Calculator.app", label: "Calculator", sub: "", last: 0, target: "/A/Calculator.app", score: 0.9 }];
  const calc = rank("calcu", { local: app, files: [f("Calculations.xlsx", `${home}/Documents`, { used: Date.now() })] });
  assert.equal(calc[0].label, "Calculator", "an app matched as well beats a file");
});
