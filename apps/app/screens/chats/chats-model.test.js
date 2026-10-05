import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chatsFrom, noSuchTool, UNSUPPORTED, chatState, chatSub, chatsOrdered, chatIdOf, sampleChats } from "./chats-model.js";

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
