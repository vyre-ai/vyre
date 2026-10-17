import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { convosFrom, convoChips, convosShown, convoKindWord } from "./convo-model.js";

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
  assert.deepEqual(convosShown(items, { project: "all", query: "draft" }).map((i) => i.title), ["Lease"]);
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
