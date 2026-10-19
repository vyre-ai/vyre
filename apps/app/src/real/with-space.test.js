import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SPACE_TOOLS, withSpace } from "./with-space.js";
import { TOOLS_WITH_SPACE } from "./space-tools.generated.js";

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
  // Derived, not counted: the generated reference (scripts/gen-surface-lists.mjs) says which tools take { space }; the app names the showing space in exactly the families it names it in. A signed branch that adds
  // a row to the reference changes both sides and needs no edit here; a tool that takes a space and is left out, or one named here that does not take one (the server would refuse the extra key), fails by name.
  const FAMILIES = ["files.drive.", "records.", "rules.", "tasks.", "runner.places"];
  const inFamily = (/** @type {string} */ t) => FAMILIES.some((f) => t.startsWith(f));
  const missing = TOOLS_WITH_SPACE.filter((t) => inFamily(t) && !SPACE_TOOLS.has(t));
  const extra = [...SPACE_TOOLS].filter((t) => !TOOLS_WITH_SPACE.includes(t));
  assert.deepEqual(missing, [], "tools of the app's families that take a space but are not named with it");
  assert.deepEqual(extra, [], "tools named with a space that the reference says do not take one");
  assert.ok(SPACE_TOOLS.size >= 42, "a tripwire: the list never shrinks below the 42 of v0.6.1");
  for (const t of ["records.holders", "files.drive.link.create", "records.audit", "files.drive.space.delete", "tasks.update", "tasks.review"]) assert.ok(SPACE_TOOLS.has(t), t);
  assert.ok(SPACE_TOOLS.has("records.audit"), "records.audit names the showing space");
  assert.deepEqual(withSpace("records.audit", { type: "x" }, A), { type: "x", space: A });
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
  assert.equal(memberChatWire("sessions.accounts.key"), "accounts.check", "a member's key is only ever CHECKED at the team's door (it keeps nothing); it is put in their own Vault by the one act below");
  assert.equal(memberChatWire("vault.me.add-key"), "myvault.addkey");
  assert.equal(memberChatWire("vault.me.account.status"), "myvault.status");
  assert.equal(memberChatWire("vault.me.put"), null, "no separate put, create, unlock or list on the wire");
  assert.equal(memberChatWire("vault.me.account.unlock"), null);
  assert.equal(memberChatWire("sessions.accounts.add"), "accounts.add");
  assert.equal(memberChatWire("records.define"), null, "a call that needs her presence or an admin is not a member call");
  assert.equal(chatSpace({ space: B }, A), B);
  assert.equal(chatSpace({}, A), A);
  assert.equal(chatSpace({}, "all"), null);
  assert.equal(chatSpace(undefined, undefined), null);
});

test("the team's own work never goes to a member's own home: it has a door call or it is refused in words", async () => {
  const { isTeamWork, memberWire, NOT_FOR_MEMBERS_YET } = await import("./with-space.js");
  for (const t of ["work.project.members", "work.template.golive", "work.template.install", "work.template.define", "flows.pause", "flows.resume", "flows.kit.list", "flows.budget", "team.add"]) {
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
  for (const t of ["records.define", "records.sees-as", "records.seal-put", "records.reveal", "tasks.decide", "planner.delete", "planner.done", "planner.snooze", "planner.agenda"]) { assert.equal(memberWire(t), null, t); assert.ok(!isTeamWork(t), `${t} is not refused: it stays on her own home`); }
  // a joined member's Records reads and her call or meeting log go through the door too (history, totals, Busy blocks, roles, log)
  for (const t of ["records.history", "records.stats", "records.busy", "records.roles.summary", "records.log", "records.move", "records.layout.get", "records.layout.set", "records.relationship.list"]) assert.equal(memberWire(t), t, t);
  // the four planner NOTE calls have door rows (core/work/member-tools.js): reads go to planner.serve, writes to planner.serve-write
  const { MEMBER_TOOLS } = await import("../../../../core/work/member-tools.js");
  assert.equal(memberWire("planner.add"), "planner.add");
  assert.deepEqual([["planner.list", "planner.serve"], ["planner.get", "planner.serve"], ["planner.add", "planner.serve-write"], ["planner.update", "planner.serve-write"]].map(([k]) => /** @type {any} */ (MEMBER_TOOLS)[k].tool), ["planner.serve", "planner.serve", "planner.serve-write", "planner.serve-write"]);
  // ...but at the box layer a planner call goes to the team's door only when the Notes tab marks it { notes: true }; the marker is always taken off
  const { planWire } = await import("./with-space.js");
  assert.deepEqual(planWire("planner.add", { title: "a note" }), { wire: null, given: { title: "a note" } }, "an unmarked add stays on her own home");
  assert.deepEqual(planWire("planner.add", { title: "a note", notes: true }), { wire: "planner.add", given: { title: "a note" } }, "a marked add goes to the team's door, marker off");
  assert.equal(planWire("planner.list", { notes: true }).wire, "planner.list");
  assert.equal(planWire("planner.list", {}).wire, null);
  assert.equal(planWire("planner.update", { item: "i", notes: false }).wire, null, "only true marks it");
  // the rest of the planner has no row, marked or not, and other tools are untouched by the marker rule
  for (const t of ["planner.delete", "planner.done", "planner.snooze"]) { assert.equal(planWire(t, { notes: true }).wire, null, `${t} stays home even marked`); assert.equal(planWire(t, {}).wire, null, t); }
  assert.deepEqual(planWire("records.list", { notes: true }), { wire: "records.list", given: { notes: true } });
});

test("a member's project files go through the door: list, read and upload, and nothing else of Drive", async () => {
  const { memberWire } = await import("./with-space.js");
  for (const t of ["files.list", "files.read", "files.upload"]) assert.equal(memberWire(t), t, t);
  for (const t of ["files.drive.list", "files.drive.read", "files.drive.upload", "files.drive.restore", "files.drive.link.create"]) assert.equal(memberWire(t), null, `${t} stays on her own home`);
});
