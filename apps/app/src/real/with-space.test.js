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
  assert.equal(memberChatWire("records.define"), null, "a call that needs her presence or an admin is not a member call");
  assert.equal(chatSpace({ space: B }, A), B);
  assert.equal(chatSpace({}, A), A);
  assert.equal(chatSpace({}, "all"), null);
  assert.equal(chatSpace(undefined, undefined), null);
});

test("the team's own work never goes to a member's own home: it has a door call or it is refused in words", async () => {
  const { isTeamWork, memberWire, NOT_FOR_MEMBERS_YET } = await import("./with-space.js");
  for (const t of ["work.project.members", "work.template.golive", "work.template.install", "work.template.define", "flows.pause", "flows.resume", "flows.kit.list", "flows.budget", "team.add", "previews.log", "previews.stop"]) {
    assert.ok(isTeamWork(t), `${t} is the team's work`);
    assert.equal(memberWire(t), null, `${t} has no door row yet, so a member is told, not sent home`);
  }
  assert.equal(memberWire("work.timeline"), "work.timeline", "the timeline has a door row now (seat-filtered by the tool)");
  assert.equal(memberWire("team.list"), "team.list", "the teammates of her projects have a door row; the rest of team.* is still refused");
  assert.ok(!isTeamWork("work.timeline"));
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

test("a member starts her own projects through the door: a blank project, one from an installed template, and the live templates she can pick", async () => {
  const { memberWire, isTeamWork } = await import("./with-space.js");
  assert.equal(memberWire("work.project.create"), "work.project-create");
  assert.equal(memberWire("work.start-project"), "work.start-project");
  assert.equal(memberWire("work.template.list"), "work.templates");
  for (const t of ["work.template.install", "work.template.define", "work.template.golive", "work.template.library"]) { assert.equal(memberWire(t), null, t); assert.ok(isTeamWork(t), `${t} is the owner's, refused in words`); }
});

test("a member's daily Records and tasks go through the door under the same name; presence and admin calls stay on her own home", async () => {
  const { memberWire, isTeamWork } = await import("./with-space.js");
  for (const t of ["records.me", "records.actors", "records.types", "records.list", "records.get", "records.events", "records.create", "records.update", "tasks.list", "tasks.get", "tasks.request", "tasks.move", "tasks.submit"]) assert.equal(memberWire(t), t, t);
  for (const t of ["records.define", "records.sees-as", "records.seal-put", "records.reveal", "tasks.decide", "planner.add"]) { assert.equal(memberWire(t), null, t); assert.ok(!isTeamWork(t), `${t} is not refused: it stays on her own home`); }
});

test("a member's project files go through the door: list, read and upload, and nothing else of Drive", async () => {
  const { memberWire } = await import("./with-space.js");
  for (const t of ["files.list", "files.read", "files.upload"]) assert.equal(memberWire(t), t, t);
  for (const t of ["files.drive.list", "files.drive.read", "files.drive.upload", "files.drive.restore", "files.drive.link.create"]) assert.equal(memberWire(t), null, `${t} stays on her own home`);
});

test("the screens that need the team's timeline say so for a member: a tag and one plain sentence, from the refusal's own mark", async () => {
  const fs = await import("node:fs");
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const { NOT_FOR_MEMBERS_YET } = await import("./with-space.js");
  assert.match(NOT_FOR_MEMBERS_YET, /owner's for now/, "isNotHere keys on these words");
  assert.match(read("./NotHereYet.tsx"), /<PlaceTag \/>.*is not in your app yet\. The owner sees it\./s);
  assert.match(read("../../screens/projects/ProjectPanes.tsx"), /if \(notHere\) return <NotHereYet what="The team's timeline" \/>;/);
  assert.match(read("../../screens/records/RecordTimeline.tsx"), /<NotHereYet what="The team's timeline" \/>/);
});

test("a member's Approve and Stop in a team chat go to the team's door (chat.answer, chat.stop), with the chat named and nothing else of the home's input", async () => {
  const fs = await import("node:fs");
  const { memberWire } = await import("./with-space.js");
  assert.equal(memberWire("threads.answer"), "chat.answer");
  assert.equal(memberWire("threads.chat-stop"), "chat.stop");
  const src = fs.readFileSync(new URL("../chat/box-stream.ts", import.meta.url), "utf8");
  assert.match(src, /name === "threads\.answer" \? \{ chat: session, ask: input\.ask, decision: input\.decision \}/);
  assert.match(src, /name === "threads\.chat-stop" \? \{ chat: session \}/);
  assert.match(src, /answerAsk: \(ask, decision\) => note\("threads\.answer"/, "the screen still names the home's tool; the route decides");
});
