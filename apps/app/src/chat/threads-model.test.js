// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chatKind, panelTabs, threadsTab, tabOf, threadRows, agentHint } from "./threads-model.js";

const agent = { family: "assistant" }, person = { family: "person" };

test("the kind of a chat, from who else is in it", () => {
  assert.equal(chatKind({ others: [agent] }), "agent");
  assert.equal(chatKind({ others: [person] }), "person");
  assert.equal(chatKind({ others: [person, agent] }), "group");
  assert.equal(chatKind({ others: [agent], flow: true }), "flow");
});

test("tabs: an agent has Threads, Computer, Details; a group has Group and one per agent; a Flow Runs and Details; a person Details", () => {
  assert.deepEqual(panelTabs("agent", ["Engineer"]).map((t) => t[1]), ["Threads", "Computer", "Details"]);
  assert.deepEqual(panelTabs("group", ["Assistant", "Scout"]), [["group", "Group"], ["agent:Assistant", "Assistant"], ["agent:Scout", "Scout"]]);
  assert.deepEqual(panelTabs("flow", []).map((t) => t[1]), ["Runs", "Details"]);
  assert.deepEqual(panelTabs("person", []).map((t) => t[1]), ["Details"]);
});

test("/threads opens Threads for an agent, Runs for a Flow, the first agent tab in a group unless an agent tab is open, and nothing for a person", () => {
  assert.equal(threadsTab("agent", ["Engineer"], "details"), "threads");
  assert.equal(threadsTab("flow", [], "details"), "runs");
  assert.equal(threadsTab("group", ["Assistant", "Scout"], "group"), "agent:Assistant");
  assert.equal(threadsTab("group", ["Assistant", "Scout"], "agent:Scout"), "agent:Scout", "an open agent tab stays");
  assert.equal(threadsTab("group", ["Assistant", "Scout"], "agent:Gone"), "agent:Assistant");
  assert.equal(threadsTab("group", [], "group"), null);
  assert.equal(threadsTab("person", [], "details"), null);
});

test("a tab this chat does not have falls back to its first", () => {
  const t = panelTabs("agent", []);
  assert.equal(tabOf(t, "computer"), "computer");
  assert.equal(tabOf(t, "library"), "threads");
});

test("thread rows: live first, then newest; rows without an id are dropped; an untitled one is New thread", () => {
  const rows = threadRows({ threads: [{ id: "a", title: "Old", at: 1 }, { id: "b", title: "Now", at: 5, live: true, needs: true }, { id: "c", at: 9 }, { title: "no id" }, null] });
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.live, r.needs]), [["b", "Now", true, true], ["c", "New thread", false, false], ["a", "Old", false, false]]);
  const real = threadRows({ agent: "kit", count: 3, threads: [{ thread: "c1", title: "Idle one", last_active: 5, state: "idle" }, { thread: "c2", title: "Needs me", last_active: 2, state: "needs_you" }, { thread: "c3", title: "Going", last_active: 1, state: "live" }] });
  assert.deepEqual(real.map((r) => [r.id, r.live, r.needs]), [["c2", true, true], ["c3", true, false], ["c1", false, false]], "acct6's rows: state says live or needs you");
  assert.deepEqual(threadRows(null), []);
  assert.deepEqual(threadRows([{ id: "x", title: "T", at: 2 }]).map((r) => r.id), ["x"]);
});

test("the agent hint names /new and /threads, and says steer or queue while it works", () => {
  assert.equal(agentHint("Engineer", false), "/new starts a new thread. /threads shows every thread with Engineer, ready to continue.");
  assert.match(agentHint("Engineer", true), /steers Engineer now\. Press Tab to queue it for after\./);
});
