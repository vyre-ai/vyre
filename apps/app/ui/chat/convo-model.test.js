import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { convosFrom, convoChips, convosShown, convoKindWord, convoSections, agentLine, CONVO_TYPES } from "./convo-model.js";

const chat = (o) => ({ id: "c", title: "T", project: "", people: [], agents: [], models: [], providers: [], status: "idle", last: 0, line: "", asks: 0, unread: 0, open: true, pinned: "", ...o });
const agent = (o) => ({ name: "kit", role: "Drafts replies", projects: [], status: "Idle", ...o });
const person = (o) => ({ id: "per_sam", name: "Sam", role: "Paralegal", ...o });

test("one list: chats, group chats, agents and people; a chat with two or more others is a group", () => {
  const items = convosFrom({
    chats: [chat({ id: "a", title: "Lease", agents: ["kit"], people: ["Sam"], last: 5 }), chat({ id: "b", title: "Solo", agents: ["kit"], last: 9 })],
    agents: [agent({ name: "ads" })], people: [person({ id: "per_dee", name: "Dee" })],
  });
  const kinds = Object.fromEntries(items.map((i) => [i.title, i.kind]));
  assert.equal(kinds.Lease, "group");
  assert.equal(kinds.Solo, "chat");
  assert.equal(kinds.ads, "agent");
  assert.equal(kinds.Dee, "person");
});

test("newest first; your assistant's pinned chat is first; agents and people with no chat come after chats", () => {
  const items = convosFrom({
    chats: [chat({ id: "old", title: "Old", last: 1 }), chat({ id: "new", title: "New", last: 9 }), chat({ id: "asst", title: "Assistant", pinned: "assistant", last: 0 })],
    agents: [agent({ name: "ads" })], people: [],
  });
  assert.deepEqual(items.map((i) => i.title), ["Assistant", "New", "Old", "ads"]);
});

test("an agent or person you already talk to alone is not listed twice", () => {
  const items = convosFrom({
    chats: [chat({ id: "k", title: "kit", agents: ["kit"], last: 3 }), chat({ id: "s", title: "Sam", people: ["Sam"], last: 4 })],
    agents: [agent({ name: "kit" }), agent({ name: "ads" })], people: [person()],
  });
  assert.deepEqual(items.map((i) => i.title).sort(), ["Sam", "ads", "kit"]);
  assert.equal(items.find((i) => i.title === "kit").chat, "k");
});

test("a chat you are not in stays greyed and cannot open", () => {
  const [i] = convosFrom({ chats: [chat({ open: false })], agents: [], people: [] });
  assert.equal(i.open, false);
});

test("project chips: All, each project once, No project; search spans title, line, names and project", () => {
  const items = convosFrom({
    chats: [chat({ id: "a", title: "Lease", project: "Northwind", line: "draft ready" }), chat({ id: "b", title: "Intake" }), chat({ id: "c", title: "Other", project: "Northwind" })],
    agents: [agent({ name: "ads", projects: ["Okafor"] })], people: [],
  });
  const chips = convoChips(items);
  assert.deepEqual(chips.map((c) => c.id), ["all", "Northwind", "Okafor", "none"]);
  assert.deepEqual(convosShown(items, { project: "Northwind", query: "" }).map((i) => i.title), ["Lease", "Other"]);
  assert.deepEqual(convosShown(items, { project: "none", query: "" }).map((i) => i.title), ["Intake"]);
  assert.deepEqual(convosShown(items, { project: "all", query: "ready" }).map((i) => i.title), ["Lease"]);
  assert.deepEqual(convosShown(items, { project: "Okafor", query: "" }).map((i) => i.title), ["ads"]);
});

test("a word for each kind, for the row's second line and screen readers", () => {
  assert.equal(convoKindWord("group"), "Group chat");
  assert.equal(convoKindWord("agent"), "Agent");
  assert.equal(convoKindWord("person"), "Teammate");
  assert.equal(convoKindWord("chat"), "Chat");
});

test("a row carries one dot: needs-you wins over unread; the preview is the last line only; a group lists who is in it", () => {
  const items = convosFrom({
    chats: [chat({ id: "a", title: "A", line: "draft ready", asks: 1, unread: 2, people: ["Sam"], agents: ["kit"] }), chat({ id: "b", title: "B", unread: 2 }), chat({ id: "c", title: "C" })],
    agents: [], people: [],
  });
  const by = Object.fromEntries(items.map((i) => [i.title, i]));
  assert.equal(by.A.dot, "ask");
  assert.equal(by.A.sub, "draft ready");
  assert.deepEqual(by.A.names, ["Sam", "kit"]);
  assert.equal(by.B.dot, "unread");
  assert.equal(by.C.dot, "");
});

test("an agent row carries the look the agent was given, and none when it has none", () => {
  const items = convosFrom({ chats: [], agents: [agent({ name: "rex", look: "s3~c5" }), agent({ name: "kit" })], people: [] });
  assert.equal(items.find((i) => i.title === "rex").look, "s3~c5");
  assert.equal(items.find((i) => i.title === "kit").look, "");
});

test("sections: Pinned, People, Groups, Agents, Flows, an empty one left out; the filter row lists the five types", () => {
  const items = convosFrom({
    chats: [chat({ id: "p", title: "Assistant", agents: ["Assistant"], pinned: "assistant" }), chat({ id: "d", title: "Dana", people: ["Dana"] }), chat({ id: "g", title: "Spring", people: ["Sam", "Dana"], agents: ["Assistant"] }), chat({ id: "e", title: "Engineer", agents: ["Engineer"] })],
    agents: [agent({ name: "Assistant" }), agent({ name: "Engineer", threads: [{ title: "Pricing page", live: true }, { title: "Signup form" }, { title: "Old" }] }), agent({ name: "Scout" })], people: [],
    flows: [{ id: "f1", title: "New lead follow-up", runs: [{ title: "Run: Ava", live: true, needs: true }, { title: "Run: Hana" }] }],
  });
  assert.deepEqual(convoSections(items).map((s) => [s.id, s.rows.map((r) => r.title)]), [["pinned", ["Assistant"]], ["people", ["Dana"]], ["groups", ["Spring"]], ["agents", ["Engineer", "Scout"]], ["flows", ["New lead follow-up"]]]);
  assert.deepEqual(CONVO_TYPES.map((t) => t.id), ["all", "people", "groups", "agents", "flows"]);
  assert.deepEqual(convosShown(items, { project: "all", query: "", type: "agents" }).map((c) => c.title).sort(), ["Assistant", "Engineer", "Scout"], "the pinned Assistant is an agent");
  assert.deepEqual(convosShown(items, { project: "all", query: "", type: "flows" }).map((c) => c.kind), ["flow"]);
  assert.deepEqual(convosShown(items, { project: "all", query: "", type: "people" }).map((c) => c.title), ["Dana"]);
});

test("an agent's row says its live thread (and that it needs you) or its latest, and how many threads it has", () => {
  assert.equal(agentLine([{ title: "Pricing page", live: true }, { title: "Signup form" }, { title: "Old" }], "role"), "Pricing page \u00b7 3 threads");
  assert.equal(agentLine([{ title: "Book the photographer", live: true, needs: true }], "role"), "Book the photographer \u00b7 needs you");
  assert.equal(agentLine([{ title: "Lead: Hana" }, { title: "Older" }], "role"), "Lead: Hana \u00b7 2 threads");
  assert.equal(agentLine([], "Builds and fixes things"), "Builds and fixes things");
  const eng = convosFrom({ chats: [chat({ id: "e", title: "Engineer", agents: ["Engineer"] })], agents: [agent({ name: "Engineer", threads: [{ title: "A", live: true }, { title: "B" }] })], people: [] })[0];
  assert.equal(eng.sub, "A \u00b7 2 threads");
  assert.equal(eng.threads, 2);
});
