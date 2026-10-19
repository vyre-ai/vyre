// @ts-check
// Invite someone against the box's shapes: the input, the answer in words, the list rows and the refusals.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInput, inviteRefusal, inviteRow, liveServers, invitable, joinedLine, madeNote } from "./invite.js";

test("an owner invites as admin, member or guest (temp); an admin below admin; anyone else cannot; manager is not offered", () => {
  assert.deepEqual(invitable("owner").map((r) => r.id), ["admin", "member", "temp"]);
  assert.deepEqual(invitable("admin").map((r) => r.id), ["member", "temp"]);
  assert.deepEqual(invitable("member"), []);
});

test("projects go as seats for every role (Contributor unless set), and as scope for a Guest only", () => {
  assert.deepEqual(createInput({ space: "s", role: "temp", anyone: true, projects: ["p1", "p2"], levels: { p2: "viewer", p1: "odd" }, days: 7, now: 0 }), { space: "s", role: "temp", expires: 7 * 86_400_000, scope: ["p1", "p2"], seats: [{ project: "p1", level: "contributor" }, { project: "p2", level: "viewer" }] });
  assert.deepEqual(createInput({ space: "s", role: "member", anyone: true, projects: ["p1"], levels: { p1: "lead" } }), { space: "s", role: "member", seats: [{ project: "p1", level: "lead" }] });
  assert.deepEqual(createInput({ space: "s", role: "member", anyone: true, projects: [] }), { space: "s", role: "member" });
});

test("the create input carries the name only when given, and a temp invite an end date", () => {
  assert.deepEqual(createInput({ space: "spc_1", role: "member", to: " @sam.vyre.run " }), { space: "spc_1", role: "member", to: "sam.vyre.run" });
  assert.deepEqual(createInput({ space: "spc_1", role: "temp", anyone: true, days: 7, now: 1000 }), { space: "spc_1", role: "temp", expires: 1000 + 7 * 86_400_000 });
});

test("a made invite says the link and whether you must confirm words; a row names the role and hides nothing it was not given", () => {
  assert.deepEqual(madeNote({ id: "inv_1", link: "https://h.vyre.run/join/x", needs_confirm: true }), { link: "https://h.vyre.run/join/x", id: "inv_1", needsConfirm: true, line: "The link works once for one person." });
  const r = inviteRow({ id: "inv_2", role: "temp", status: "open", valid_until: 1_790_000_000_000 });
  assert.equal(r.title, "Temp invite"); assert.equal(r.open, true);
  assert.equal(inviteRow({ id: "i3", role: "member", status: "used" }).open, false);
});

test("refusals get plain words", () => {
  assert.match(inviteRefusal("not_allowed", ""), /owner or admin/);
  assert.match(inviteRefusal("presence_required", ""), /Approve on this device/);
  assert.equal(inviteRefusal("x", "the box said"), "the box said");
});

test("JL-2: an invite names the person unless anyone-with-the-link is chosen, and the inviter sees who joined and from which device", () => {
  assert.throws(() => createInput({ space: "s", role: "member" }), /name_required/);
  assert.throws(() => createInput({ space: "s", role: "member", to: "  " }), /name_required/);
  assert.deepEqual(createInput({ space: "s", role: "member", anyone: true }), { space: "s", role: "member" });
  assert.deepEqual(createInput({ space: "s", role: "member", to: "sam.vyre.run" }), { space: "s", role: "member", to: "sam.vyre.run" });
  const r = inviteRow({ id: "i", role: "member", status: "used", joined_by_label: "Sam", joined_device: "iPhone" });
  assert.equal(joinedLine(r), "Joined by Sam from iPhone.");
  assert.equal(joinedLine(inviteRow({ id: "j", role: "member", status: "used" })), "");
});

test("a space on one person's computer says why nobody can join it", async () => {
  const { inviteRefusal } = await import("./invite.js");
  assert.equal(inviteRefusal("this_computer", "x"), "This space lives on this computer, so other people cannot join it. To invite people, make a space on your server.");
  assert.equal(inviteRefusal("unreachable", "x", "Chris"), "This space lives on Chris's computer and cannot be reached from here. Ask them to invite you to a space on their server.");
  assert.equal(inviteRefusal("unreachable", "x"), "This space lives on its owner's computer and cannot be reached from here. Ask them to invite you to a space on their server.");
});

test("a person has a server when wink.access lists a live one", () => {
  assert.deepEqual(liveServers({ devices: [{ id: "d1", kind: "phone" }, { id: "d2", kind: "server", removed: true }] }), []);
  assert.equal(liveServers({ devices: [{ id: "d3", kind: "server", removed: false }] }).length, 1);
  assert.deepEqual(liveServers(null), []);
});

import { emailIt } from "./invite.js";
test("Email it is a mailto for the person's own mail app, with the link and no recipient", () => {
  const e = emailIt("Juniper Studio", "https://juniper.vyre.run/join/abc");
  assert.ok(e.mailto.startsWith("mailto:?subject="));
  assert.ok(decodeURIComponent(e.mailto).includes("https://juniper.vyre.run/join/abc"));
  assert.match(e.subject, /Juniper Studio/);
});

test("a phone is never told about a server", () => {
  assert.doesNotMatch(inviteRefusal("this_computer", "x", "", true), /server/i);
  assert.doesNotMatch(inviteRefusal("unreachable", "x", "Chris", true), /server/i);
});

test("the invite is one call to the box, with nothing asked or refused first: a box that allows it gives a link, a box that refuses gives its own words", async () => {
  const { requestInvite } = await import("./invite.js");
  // a box that allows it
  const seen = [];
  const allow = async (tool, input) => { seen.push([tool, input]); return { link: "https://vyre.run/i/inv_0123456789abcdef0123456789abcdef.abc", id: "inv_1", valid_until: 0 }; };
  const ok = await requestInvite(allow, { space: "spc_aaaaaaaaaaaa", role: "temp", days: 7 }, { phone: false });
  assert.equal(ok.ok, true);
  assert.match(ok.made.link, /^https:\/\/vyre\.run\/i\/inv_/);
  assert.deepEqual(seen, [["onboard.member.link", { space: "spc_aaaaaaaaaaaa", role: "guest", ttlDays: 7 }]], "exactly one call, and a temp role goes as guest");
  // a box that refuses: its own reason text comes back, whatever the code
  const words = "Sign in on this device with your passkey first. This is something only you can do.";
  const refuse = async () => { throw Object.assign(new Error(words), { code: "person_session_required" }); };
  const no = await requestInvite(refuse, { space: "spc_aaaaaaaaaaaa", role: "member", days: 7 });
  assert.deepEqual([no.ok, no.why, no.code], [false, words, "person_session_required"]);
  // the screen's own mapped codes still say their own words
  const denied = async () => { throw Object.assign(new Error("x"), { code: "denied" }); };
  assert.equal((await requestInvite(denied, { space: "s", role: "member", days: 7 })).why, "Only an owner or admin can invite people to this space.");
  // the screen never decides alone: its source has no passkey or session check before the call
  const fs = await import("node:fs");
  const body = fs.readFileSync(new URL("./InviteBody.tsx", import.meta.url), "utf8");
  assert.ok(!/passkey|person_session|loadIdentity|personSession/i.test(body.slice(body.indexOf("const make = "), body.indexOf("const confirm = "))), "make() calls the box without a local check first");
});
