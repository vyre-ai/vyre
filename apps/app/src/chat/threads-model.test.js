// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chatKind, panelTabs, threadsTab, tabOf, threadRows, agentHint, groupView, addPeopleLine, threadSub, threadTitleOf, titleFrom, untitledTitle } from "./threads-model.js";

const agent = { family: "assistant" }, person = { family: "person" };

test("the kind of a chat, from who else is in it", () => {
  assert.equal(chatKind({ others: [agent] }), "agent");
  assert.equal(chatKind({ others: [person] }), "person");
  assert.equal(chatKind({ others: [person, agent] }), "group");
  assert.equal(chatKind({ others: [agent], flow: true }), "flow");
});

test("tabs: an agent has Threads, Computer, Details; a group one first level; a Flow Runs and Details; a person Details", () => {
  assert.deepEqual(panelTabs("agent", ["Engineer"]).map((t) => t[1]), ["Threads", "Computer", "Details"]);
  assert.deepEqual(panelTabs("group", ["Assistant", "Scout"]), [["group", "Group"]], "a group has no tab row: faces and threads, then drill in");
  assert.deepEqual(panelTabs("flow", []).map((t) => t[1]), ["Runs", "Details"]);
  assert.deepEqual(panelTabs("person", []).map((t) => t[1]), ["Details"]);
});

test("/threads opens Threads for an agent, Runs for a Flow, the group's threads in a group (or the open agent), and nothing for a person", () => {
  assert.equal(threadsTab("agent", ["Engineer"], "details"), "threads");
  assert.equal(threadsTab("flow", [], "details"), "runs");
  assert.equal(threadsTab("group", ["Assistant", "Scout"], "group"), "group", "the group's own threads are on its first level");
  assert.equal(threadsTab("group", ["Assistant", "Scout"], "agent:Scout"), "agent:Scout", "an agent already open stays");
  assert.equal(threadsTab("group", ["Assistant", "Scout"], "agent:Gone"), "group");
  assert.equal(threadsTab("group", [], "person:per_x"), "group");
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

test("a group's panel: first level, or one person or agent drilled into; someone who left falls back to the first level", () => {
  const m = [{ id: "per_sam", name: "Sam", family: "person" }, { id: "agt_kit", name: "kit", family: "assistant" }];
  assert.deepEqual(groupView("group", m), { level: "first" });
  assert.deepEqual(groupView("person:per_sam", m), { level: "person", id: "per_sam" });
  assert.deepEqual(groupView("agent:kit", m), { level: "agent", name: "kit" });
  assert.deepEqual(groupView("person:per_gone", m), { level: "first" });
  assert.deepEqual(groupView("agent:Sam", m), { level: "first" }, "a person is not an agent");
});

test("before people join a thread with an agent, one line says what they and the agent get", () => {
  assert.equal(addPeopleLine(["Dana", "Sam"], "Juno"), "Dana and Sam will see this thread's earlier messages. Juno keeps what it knows from this thread.");
  assert.equal(addPeopleLine(["Dana"], "Juno"), "Dana will see this thread's earlier messages. Juno keeps what it knows from this thread.");
});

test("a thread row says where it was forked from", () => {
  const r = threadRows({ threads: [{ thread: "f1", title: "Plan (fork)", last_active: 3, state: "idle", forked_from: { thread: "o1", message: "m7" } }, { thread: "o1", title: "Plan", last_active: 2 }] });
  assert.deepEqual(r.map((x) => x.forkedFrom), [{ thread: "o1", message: "m7" }, null]);
});

test("the header says the agent, then the thread's own title only when it has one: never \"engineer New chat\"", () => {
  assert.equal(threadSub("New chat", "engineer"), undefined);
  assert.equal(threadSub("Chat", "engineer"), undefined);
  assert.equal(threadSub("engineer", "engineer"), undefined);
  assert.equal(threadSub("", "engineer"), undefined);
  assert.equal(threadSub("Add a signup form", "engineer"), "Add a signup form");
});

test("a thread is titled from its first message, short, as chat apps do; a command or an empty message gives none", () => {
  assert.equal(titleFrom("can you add a signup form to the pricing page and wire it to the CRM please"), "Can you add a signup form");
  assert.equal(titleFrom("@engineer fix the intake date check\nmore detail here"), "Fix the intake date check");
  assert.equal(titleFrom("look at https://example.com/x now"), "Look at now");
  assert.equal(titleFrom("/threads"), "");
  assert.equal(titleFrom("   "), "");
  assert.ok(titleFrom("x".repeat(90)).length <= 48);
  assert.equal(untitledTitle("New chat"), true);
  assert.equal(untitledTitle("Chat"), true);
  assert.equal(untitledTitle("Pricing page"), false);
  assert.equal(untitledTitle("Assistant"), true, "the pinned chat's own title is not a thread title");
  const words = "please draft the spring note for the bakery and keep it under one page of plain words";
  assert.equal(threadTitleOf(`  ${words}  `), words.slice(0, 60).trimEnd());
  assert.equal(threadTitleOf("/threads"), "");
  assert.equal(threadTitleOf(""), "");
});
