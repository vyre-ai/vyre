import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { withNames, chatsFrom, noSuchTool, UNSUPPORTED, chatState, chatSub, chatsOrdered, chatIdOf, chatsView, sampleChats } from "./chats-model.js";

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

test("unread is a count on the row when the box sends one, and nothing when it does not", () => {
  const rows = chatsFrom({ chats: [{ chat: "c1", title: "a", unread: 3, open: true }, { chat: "c2", title: "b", open: true }, { chat: "c3", title: "c", unread: "x", open: true }, { chat: "c4", title: "d", unread: 0, open: true }] });
  assert.deepEqual(rows.map((r) => r.unread), [3, 0, 0, 0]);
});

test("your assistant's pinned chat is always first and the Engineer's chat is not in the list (R031-94)", async () => {
  const { chatsFrom, chatsOrdered, chatsShown } = await import("./chats-model.js");
  const rows = chatsFrom({ chats: [
    { chat: "c1", title: "Needs you", asks: 2, last_active: "3", open: true },
    { chat: "c2", title: "Assistant", pinned: "assistant", last_active: "1", open: true },
    { chat: "c3", title: "@Engineer", pinned: "engineer", last_active: "9", open: true },
    { chat: "c4", title: "Newest", last_active: "8", open: true },
  ] });
  assert.deepEqual(chatsOrdered(chatsShown(rows)).map((r) => r.id), ["c2", "c1", "c4"]);
  assert.equal(rows.find((r) => r.id === "c3")?.pinned, "engineer");
});

test("a person who has chats sees them with the gap above; the gap fills the page only when there is nothing else", () => {
  const gap = { title: "Nothing can approve yet" };
  const row = { id: "c1" };
  assert.deepEqual(chatsView({ from: "live", gap, rows: [row], live: true }), { body: "list", banner: true });
  assert.deepEqual(chatsView({ from: "live", gap: null, rows: [row], live: true }), { body: "list", banner: false });
  assert.deepEqual(chatsView({ from: "live", gap, rows: [], live: true }), { body: "gap", banner: false });
  assert.deepEqual(chatsView({ from: "none", gap: null, rows: [], live: true }), { body: "loading", banner: false });
  assert.deepEqual(chatsView({ from: "none", gap: null, rows: [], live: false }), { body: "offline", banner: false });
  assert.deepEqual(chatsView({ from: "live", gap: null, rows: [], live: true }), { body: "empty", banner: false });
  assert.deepEqual(chatsView({ from: "unsupported", gap, rows: [row], live: true }), { body: "unsupported", banner: false });
});

test("chats list: a chat that runs on a lent computer says so first in its line; a chat on the server says nothing", async () => {
  const { computerOf, chatSub } = await import("./chats-model.js");
  const places = { places: [{ chat: "c1", session: "s1", computer: "Dana's MacBook", device: "d1", online: true }, { chat: "c2", session: "s2", computer: "Studio Mac", device: "d2", online: false }, { chat: "c3", session: "s3", computer: "", device: "d3", online: true }] };
  assert.equal(computerOf(places, "c1"), "On Dana's MacBook");
  assert.equal(computerOf(places, "c2"), "Studio Mac is offline");
  assert.equal(computerOf(places, "c3"), "", "a row with no name is the server's line, never an id");
  assert.equal(computerOf(places, "c9"), "");
  assert.equal(computerOf(null, "c1"), "", "a box without runner.places says nothing");
  assert.equal(computerOf([{ chat: "c1", computer: "Dana's MacBook" }], "c1"), "On Dana's MacBook", "the answer may be a bare array");
  const row = { id: "c1", title: "t", project: "Northwind", people: ["alex"], agents: ["kit"], models: [], providers: [], status: "idle", last: 0, line: "", asks: 0, unread: 0, open: true };
  assert.equal(chatSub(row, "On Dana's MacBook"), "On Dana's MacBook · alex, kit · Northwind");
  assert.equal(chatSub(row), "alex, kit · Northwind");
});

test("chats list: each chat is one list-block row with faces, provider marks, its state, its age, and dim when it is not yours", async () => {
  const { chatRowsOf } = await import("./chats-model.js");
  const { validateScreen } = await import("../../../../lib/views/blocks.js");
  const now = 1_700_000_000_000;
  const base = { project: "Northwind", people: ["alex"], agents: ["kit"], models: [], providers: ["claude", "codex"], status: "idle", last: now - 6 * 60_000, line: "", asks: 0, unread: 0, open: true };
  const rows = chatRowsOf([
    { ...base, id: "a", title: "Assistant", pinned: "assistant" },
    { ...base, id: "b", title: "Lease reply", asks: 1, unread: 120 },
    { ...base, id: "c", title: "Failed one", status: "failed", last: 0 },
    { ...base, id: "d", title: "Not yours", open: false },
  ], now, { places: [{ chat: "b", computer: "Dana's MacBook", online: true }] });
  assert.equal(rows[0].title, "Your assistant");
  assert.equal(rows[0].subtitle, "Always here. Lumen talks to this chat too.");
  assert.deepEqual(rows[1].faces, [{ kind: "person", name: "alex" }, { kind: "assistant", name: "kit" }]);
  assert.deepEqual(rows[1].providers, ["claude", "codex"]);
  assert.deepEqual(rows[1].accessories.map((a) => [a.label, a.tone, a.as]), [["Needs you", "accent", undefined], ["99+", "accent", undefined], ["6m", undefined, "text"]]);
  assert.match(rows[1].subtitle, /^1 waiting on you · On Dana's MacBook · alex, kit · Northwind/);
  assert.deepEqual(rows[2].accessories.map((a) => a.label), ["Failed"], "no age when it never moved");
  assert.equal(rows[3].dim, true);
  assert.equal(rows[0].dim, undefined);
  assert.deepEqual(validateScreen({ v: 2, title: "Chats", layout: { block: "l" }, blocks: { l: { type: "list", content: { rows } } } }), [], "the language accepts them");
});
