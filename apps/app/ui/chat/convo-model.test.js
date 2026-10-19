import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { convosFrom, convoChips, convosShown, convoKindWord, convoSections, agentLine, summaryLine, CONVO_TYPES, placeOf } from "./convo-model.js";

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
  assert.equal(kinds.Ads, "agent");
  assert.equal(kinds.Dee, "person");
});

test("newest first; your assistant's pinned chat is first; agents and people with no chat come after chats", () => {
  const items = convosFrom({
    chats: [chat({ id: "old", title: "Old", last: 1 }), chat({ id: "new", title: "New", last: 9 }), chat({ id: "asst", title: "Assistant", pinned: "assistant", last: 0 })],
    agents: [agent({ name: "ads" })], people: [],
  });
  assert.deepEqual(items.map((i) => i.title), ["Assistant", "New", "Old", "Ads"]);
});

test("an agent or person you already talk to alone is not listed twice", () => {
  const items = convosFrom({
    chats: [chat({ id: "k", title: "kit", agents: ["kit"], last: 3 }), chat({ id: "s", title: "Sam", people: ["Sam"], last: 4 })],
    agents: [agent({ name: "kit" }), agent({ name: "ads" })], people: [person()],
  });
  assert.deepEqual(items.map((i) => i.title).sort(), ["Ads", "Kit", "Sam"]);
  assert.equal(items.find((i) => i.title === "Kit").chat, "k");
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
  assert.deepEqual(convosShown(items, { project: "Okafor", query: "" }).map((i) => i.title), ["Ads"]);
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
  assert.equal(items.find((i) => i.title === "Rex").look, "s3~c5");
  assert.equal(items.find((i) => i.title === "Kit").look, "");
});

test("sections follow where a chat lives: Pinned, Personal, Space chats, Projects, Flows; an empty one is left out; the filter row lists the five", () => {
  const items = convosFrom({
    chats: [chat({ id: "p", title: "Assistant", agents: ["Assistant"], pinned: "assistant" }), chat({ id: "d", title: "Dana", people: ["Dana"], last: 3 }), chat({ id: "g", title: "Spring", people: ["Sam", "Dana"], agents: ["Assistant"], last: 9 }),
      chat({ id: "e", title: "Engineer", agents: ["Engineer"], last: 5 }), chat({ id: "pr", title: "Northwind", project: "Northwind", people: ["Sam"], last: 1 })],
    agents: [agent({ name: "Assistant" }), agent({ name: "Engineer", threads: [{ title: "Pricing page", live: true }, { title: "Signup form" }, { title: "Old" }] }), agent({ name: "Scout", threads: [{ title: "Lead", at: 7 }] })], people: [],
    flows: [{ id: "f1", title: "New lead follow-up", line: "2 runs", runs: 2, needs: 1 }],
  });
  assert.deepEqual(convoSections(items).map((s) => [s.id, s.rows.map((r) => r.title)]), [["pinned", ["Assistant"]], ["personal", ["Scout", "Engineer"]], ["space", ["Spring", "Dana"]], ["projects", ["Northwind"]], ["flows", ["New lead follow-up"]]]);
  assert.deepEqual(CONVO_TYPES.map((t) => t.id), ["all", "personal", "space", "projects", "flows"]);
  assert.deepEqual(convosShown(items, { project: "all", query: "", type: "personal" }).map((c) => c.title).sort(), ["Assistant", "Engineer", "Scout"], "the pinned Assistant is Personal");
  assert.deepEqual(convosShown(items, { project: "all", query: "", type: "flows" }).map((c) => c.kind), ["flow"]);
  assert.deepEqual(convosShown(items, { project: "all", query: "", type: "space" }).map((c) => c.title).sort(), ["Dana", "Spring"]);
});

test("a row's own place wins; without one it is worked out from who is in the chat", () => {
  assert.equal(placeOf({ people: [], agents: ["kit"] }), "personal");
  assert.equal(placeOf({ people: ["Dana"], agents: [] }), "space");
  assert.equal(placeOf({ people: ["Dana"], agents: [], project: "Northwind" }), "projects");
  assert.equal(placeOf({ place: "personal", people: ["Dana"], agents: [] }), "personal");
  assert.equal(placeOf({ place: "project", people: [], agents: [] }), "projects");
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

test("an agent's line from work.chat.summary: its live thread (needs you) or latest, and its thread count", () => {
  assert.equal(summaryLine({ count: 3, latest: "Signup form", live: "Pricing page" }, "role"), "Pricing page \u00b7 3 threads");
  assert.equal(summaryLine({ count: 1, live: "Book the photographer", needs: true }, "role"), "Book the photographer \u00b7 needs you");
  assert.equal(summaryLine({ count: 2, latest: "Lead: Hana" }, "role"), "Lead: Hana \u00b7 2 threads");
  assert.equal(summaryLine({ count: 0 }, "Builds things"), "Builds things");
  assert.equal(summaryLine(undefined, "Builds things"), "Builds things");
  const row = convosFrom({ chats: [], agents: [agent({ name: "Engineer", summary: { count: 4, latest: "A", at: 9 } })], people: [] })[0];
  assert.deepEqual([row.sub, row.threads, row.last], ["A \u00b7 4 threads", 4, 9]);
});

test("the Engineer's Space chat is the first row of Space chats, called Engineer, even when older", () => {
  const items = convosFrom({
    chats: [chat({ id: "a", title: "Hiring", place: "space", people: ["Sam", "Dee"], last: 99 }), chat({ id: "eng", title: "chat", place: "space", engineer: true, agents: ["engineer"], people: ["Sam", "Dee"], last: 1 })],
    agents: [], people: [],
  });
  const space = convoSections(items).find((s) => s.id === "space");
  assert.deepEqual(space?.rows.map((r) => r.title), ["Engineer", "Hiring"]);
  assert.equal(space?.rows[0].pinned, true);
});

test("an agent is listed by its display name, and the second line never repeats the name", async () => {
  const { convosFrom, displayName } = await import("./convo-model.js");
  assert.equal(displayName("engineer"), "Engineer");
  assert.equal(displayName("desk-helper"), "Desk helper");
  const rows = convosFrom({ chats: [], agents: [{ name: "engineer", role: "engineer" }, { name: "scout", role: "Finds leads" }], people: [] });
  const eng = rows.find((r) => r.agent === "engineer");
  assert.equal(eng.title, "Engineer");
  assert.equal(eng.sub, "Agent");
  assert.equal(rows.find((r) => r.agent === "scout").sub, "Finds leads");
});

test("the assistant's pinned chat is listed under the assistant's own name, first", async () => {
  const { convosFrom } = await import("./convo-model.js");
  const chat = (o) => ({ id: "c1", title: "Assistant", project: "", people: [], agents: [], status: "idle", last: 1, line: "", asks: 0, unread: 0, open: true, ...o });
  const rows = convosFrom({ assistantName: "Qi", chats: [chat({ id: "c2", title: "Lease", last: 99 }), chat({ pinned: "assistant" })], agents: [], people: [] });
  assert.equal(rows[0].title, "Qi");
  assert.equal(rows[0].sub, "Your assistant");
  assert.equal(rows[0].pinned, true);
  assert.equal(convosFrom({ assistantName: "juno", chats: [], agents: [], people: [] })[0].title, "Juno", "the assistant is listed by its display name too");
});

test("the assistant is always first: with no chat of its own yet, a row that starts a new thread with it", async () => {
  const { convosFrom } = await import("./convo-model.js");
  const rows = convosFrom({ assistantName: "Qi", chats: [{ id: "c2", title: "Lease", project: "", people: [], agents: [], status: "idle", last: 99, line: "", asks: 0, unread: 0, open: true }], agents: [{ name: "engineer", role: "engineer" }], people: [] });
  assert.equal(rows[0].id, "assistant:new");
  assert.equal(rows[0].title, "Qi");
  assert.equal(rows[0].sub, "Your assistant");
  assert.equal(rows[0].chat, "", "nothing is made until the first message");
  assert.equal(convosFrom({ chats: [], agents: [], people: [] }).some((r) => r.id === "assistant:new"), false, "no assistant known, no row");
});
