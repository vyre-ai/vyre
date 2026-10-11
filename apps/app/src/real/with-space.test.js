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
  assert.equal(memberChatWire("stream.send"), "chat.send");
  assert.equal(memberChatWire("stream.reply-mode"), "chat.reply-mode");
  assert.equal(memberChatWire("stream.keep"), null, "keeping one answer of a fan-out is not a member call yet");
  assert.equal(memberChatWire("sessions.accounts.signin"), "accounts.signin");
  assert.equal(memberChatWire("sessions.accounts.key"), null, "a key is not a member's call: it needs a Vault of their own");
  assert.equal(memberChatWire("records.list"), null);
  assert.equal(chatSpace({ space: B }, A), B);
  assert.equal(chatSpace({}, A), A);
  assert.equal(chatSpace({}, "all"), null);
  assert.equal(chatSpace(undefined, undefined), null);
});

test("the team's own work never goes to a member's own home: it has a door call or it is refused in words", async () => {
  const { isTeamWork, memberWire, NOT_FOR_MEMBERS_YET } = await import("./with-space.js");
  for (const t of ["work.project.create", "work.project.members", "work.start-project", "work.template.list", "work.template.golive", "flows.pause", "flows.resume", "flows.kit.list", "flows.budget", "team.add"]) {
    assert.ok(isTeamWork(t), `${t} is the team's work`);
    assert.equal(memberWire(t), null, `${t} has no door row yet, so a member is told, not sent home`);
  }
  for (const t of ["work.chat.list", "stream.send", "planner.add", "spaces.list", "sessions.accounts.list", "vault.list", "records.me"]) assert.ok(!isTeamWork(t), `${t} is not refused`);
  assert.match(NOT_FOR_MEMBERS_YET, /Ask the owner/, "it names a next step");
});

test("a member's Flows go through the door under the same name; the ones the door does not carry are refused in words", async () => {
  const { memberWire, isTeamWork } = await import("./with-space.js");
  for (const c of ["list", "get", "card", "approve", "start", "run", "runs", "propose", "compile-text", "from-chat"]) assert.equal(memberWire(`flows.${c}`), `flows.${c}`, c);
  assert.equal(memberWire("flows.test.save"), "flows.test-save");
  assert.equal(memberWire("flows.test.run"), "flows.test-run");
  for (const c of ["pause", "resume", "rollback", "budget", "control", "settle", "advance", "kit.list", "connections"]) { assert.equal(memberWire(`flows.${c}`), null, c); assert.ok(isTeamWork(`flows.${c}`), `${c} is refused in words`); }
});
