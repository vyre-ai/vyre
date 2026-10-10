import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SPACE_TOOLS, withSpace } from "./with-space.js";

const A = "spc_abcdefghijkl", B = "spc_mnopqrstuvwx";

test("a tool that takes a space gets the showing one", () => {
  assert.deepEqual(withSpace("records.list", { type: "contact" }, A), { type: "contact", space: A });
  assert.deepEqual(withSpace("tasks.list", undefined, A), { space: A });
  assert.deepEqual(withSpace("rules.enable", { id: "r1" }, A), { id: "r1", space: A });
});

test("a screen's own space wins, and All spaces or no space adds nothing", () => {
  assert.deepEqual(withSpace("records.list", { space: B }, A), { space: B });
  assert.deepEqual(withSpace("records.list", { type: "x" }, "all"), { type: "x" });
  assert.deepEqual(withSpace("records.list", {}, undefined), {});
});

test("a tool that does not take a space is left alone", () => {
  for (const t of ["records.get", "records.update", "files.drive.list", "spaces.list", "vault.list"]) assert.deepEqual(withSpace(t, { id: "x" }, A), { id: "x" }, t);
  assert.equal(SPACE_TOOLS.size, 36, "the 34 the app named by hand, plus records.holders and files.drive.link.create, which the tool reference says take a space too");
});

test("a member's chat tools go through the team door: only the five, and only for a real Space", async () => {
  const { memberChatWire, chatSpace } = await import("./with-space.js");
  assert.equal(memberChatWire("work.chat.list"), "chat.list");
  assert.equal(memberChatWire("work.chat.create"), "chat.create");
  assert.equal(memberChatWire("work.chat.persistent"), "chat.persistent");
  assert.equal(memberChatWire("work.chat.keys.begin"), null, "a chat key call is not a member's");
  assert.equal(memberChatWire("records.list"), null);
  assert.equal(chatSpace({ space: B }, A), B);
  assert.equal(chatSpace({}, A), A);
  assert.equal(chatSpace({}, "all"), null);
  assert.equal(chatSpace(undefined, undefined), null);
});
