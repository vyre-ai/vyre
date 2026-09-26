// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSessions, groupSessions, title } from "./sessions.js";

const catalog = [
  { id: "s-site", label: "Harlow site rebuild", cwd: "/w/harlow-site", last: 300, turns: 4, human: true, projects: ["harlow-legal"] },
  { id: "s-plan", name: "Weekly planning", title: "What is left this week?", cwd: "/w", last: 500, turns: 2, human: true, projects: ["harlow-legal", "northwind-bakery"] },
  { id: "s-loose", title: "Try the new CLI", cwd: "/w/scratch", last: 100, turns: 1, human: true, projects: [] },
  { id: "s-bot", title: "Summarise invoices", cwd: "/w/tmp", last: 50, turns: 2, human: false, projects: [] },
];
const threads = [
  { id: "s-site", name: "Harlow site rebuild", project: "harlow-legal", agent: null, status: "running", last: 900, turns: 5, asks: 1, holder: "deck" },
  { id: "t-kit", name: "Hero copy", project: null, agent: "kit", status: "waiting", last: 700, turns: 1, asks: 0, holder: null },
];

test("sessions: one row per session, the Switchboard's live fields win, newest first", () => {
  const rows = mergeSessions(catalog, threads);
  assert.deepEqual(rows.map(r => r.id), ["s-site", "t-kit", "s-plan", "s-loose", "s-bot"]);
  const site = rows[0];
  assert.equal(site.status, "running");
  assert.equal(site.asks, 1);
  assert.equal(site.turns, 5);
  assert.equal(site.live, true);
  assert.deepEqual(site.projects, ["harlow-legal"]);
  assert.equal(rows.find(r => r.id === "s-plan")?.live, false);
  assert.equal(title(rows.find(r => r.id === "s-plan")), "Weekly planning");
  assert.equal(title({ ...rows[0], name: "" }), "s-site");
});

test("sessions: a session in two projects is under both; no-project keeps people's sessions only", () => {
  const rows = mergeSessions(catalog, threads);
  const g = groupSessions(rows, [{ slug: "harlow-legal" }, { slug: "northwind-bakery" }]);
  assert.deepEqual(g.byProject.get("harlow-legal")?.map(r => r.id), ["s-site", "s-plan"]);
  assert.deepEqual(g.byProject.get("northwind-bakery")?.map(r => r.id), ["s-plan"]);
  assert.deepEqual(g.noProject.map(r => r.id), ["t-kit", "s-loose"], "a headless run nobody started stays out");
  assert.deepEqual([...g.byAgent.keys()], ["kit"]);
  assert.equal(groupSessions(rows, [], 1).noProject.length, 1, "the no-project list is capped");
});

test("sessions: either source alone still lists", () => {
  assert.equal(mergeSessions([], threads).length, 2);
  assert.equal(mergeSessions(catalog, []).length, 4);
  assert.deepEqual(mergeSessions(null, undefined), []);
});
