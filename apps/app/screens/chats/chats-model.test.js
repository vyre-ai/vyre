import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { withNames, chatsFrom, noSuchTool, UNSUPPORTED, chatState, chatSub, chatsOrdered, chatIdOf, sampleChats } from "./chats-model.js";

test("work.chat.list rows become one row type; the id comes from the record address; a row with no open flag is not openable", () => {
  const rows = chatsFrom({ rows: [
    { urn: "vyre://home/chat/chat_a1", data: { title: "Lease reply", project_name: "Northwind", people: ["alex"], agents: ["kit"], models: ["kit on Claude", "kit on Codex"], providers: ["claude", "codex", "bogus"], status: "working", last_active: 50, summary: "Draft ready" }, open: true },
    { id: "chat_b2", title: "Payroll", people: ["Dana"], status: "idle", last_active: 10 },
  ] });
  assert.equal(rows[0].id, "chat_a1");
  assert.deepEqual(rows[0].providers, ["claude", "codex"]);
  assert.equal(rows[0].open, true);
  assert.equal(rows[1].open, false, "no open flag: greyed, no open");
  assert.equal(chatIdOf("vyre://home/chat/chat_a1"), "chat_a1");
  assert.deepEqual(chatsFrom(null), []);
});

test("a box without work.chat.list is told to update; there is no older list", () => {
  assert.equal(UNSUPPORTED, "Update your server to use Chats");
  assert.equal(noSuchTool({ code: "unknown_tool" }), true);
  assert.equal(noSuchTool({ code: "offline" }), false);
});

test("chats that need you come first, and no row reads a session, a thread or a room", () => {
  const list = sampleChats(1_000_000_000);
  assert.equal(list.length, 4);
  const people = list.find((c) => c.id === "demo-people");
  const ordered = chatsOrdered([{ ...people, asks: 1 }, ...list.filter((c) => c.id !== "demo-people")]);
  assert.equal(ordered[0].id, "demo-people");
  for (const c of list) assert.doesNotMatch(`${c.title} ${chatSub(c)}`, /\b(session|thread|room|fan-?out)\b/i);
});

test("work.chat.list's real answer: { chats }, flat rows, people and agents as comma-joined strings, chat is the id, open only for chats the caller is in", () => {
  const rows = chatsFrom({ chats: [
    { id: "rec_1", urn: "vyre://home/chat-record/rec_1", title: "Lease reply", project: { urn: "vyre://home/project/general" }, chat: "chat_a1", people: "per_1, per_2", agents: "kit", started: 1, last_active: 9, status: "idle", drive: "", location: "", open: true },
    { id: "rec_2", urn: "vyre://home/chat-record/rec_2", title: "Payroll", project: { urn: "vyre://home/project/hr" }, chat: "chat_b2", people: "per_3", agents: "", last_active: 3, status: "working" },
  ] });
  assert.deepEqual(rows.map((r) => r.id), ["chat_a1", "chat_b2"]);
  assert.deepEqual(rows[0].people, ["per_1", "per_2"]);
  assert.deepEqual(rows[0].agents, ["kit"]);
  assert.deepEqual(rows[1].agents, []);
  assert.deepEqual(rows.map((r) => r.open), [true, false]);
  assert.equal(rows[0].project, "", "an urn is never shown as a project name");
});

test("person ids become names, and an id with no name reads Someone, never the id", () => {
  const rows = chatsFrom({ chats: [{ chat: "c1", title: "t", people: "per_1,per_2", agents: "kit", open: true }] });
  const named = withNames(rows, { actors: [{ id: "per_1", name: "Dana Okafor" }, { id: "per_2", name: "per_2" }] });
  assert.deepEqual(named[0].people, ["Dana Okafor", "Someone"]);
  assert.deepEqual(named[0].agents, ["kit"]);
});

test("a chat you are in carries project_name, providers and last_line from the engine; one you are not in carries none of them", () => {
  const rows = chatsFrom({ chats: [
    { chat: "c1", title: "Lease reply", project_name: "Northwind", project: { urn: "vyre://h/project/p1" }, people: "per_1", agents: "kit", providers: ["claude", "codex"], last_line: "Draft ready", status: "idle", last_active: 5, open: true },
    { chat: "c2", title: "Payroll", project_name: "HR", people: "per_2", status: "idle", last_active: 3 },
  ] });
  assert.deepEqual([rows[0].project, rows[0].providers, rows[0].line], ["Northwind", ["claude", "codex"], "Draft ready"]);
  assert.deepEqual([rows[1].project, rows[1].providers, rows[1].line, rows[1].open], ["HR", [], "", false]);
});

test("the viewer is left out of a chat's people", () => {
  const rows = chatsFrom({ chats: [{ chat: "c1", title: "t", people: "per_me,per_2", agents: "", open: true }] });
  assert.deepEqual(withNames(rows, { actors: [{ id: "per_2", name: "Dana Okafor" }] }, "per_me")[0].people, ["Dana Okafor"]);
});
