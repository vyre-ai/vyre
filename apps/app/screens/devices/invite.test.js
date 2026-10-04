// @ts-check
// Invite someone against the box's shapes: the input, the answer in words, the list rows and the refusals.
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInput, inviteRefusal, inviteRow, invitable, madeNote } from "./invite.js";

test("an owner invites as admin, manager, member or temp; an admin below admin; anyone else cannot", () => {
  assert.deepEqual(invitable("owner").map((r) => r.id), ["admin", "manager", "member", "temp"]);
  assert.deepEqual(invitable("admin").map((r) => r.id), ["manager", "member", "temp"]);
  assert.deepEqual(invitable("member"), []);
});

test("the create input carries the name only when given, and a temp invite an end date", () => {
  assert.deepEqual(createInput({ space: "spc_1", role: "member", to: " @sam.vyre.run " }), { space: "spc_1", role: "member", to: "sam.vyre.run" });
  assert.deepEqual(createInput({ space: "spc_1", role: "temp", days: 7, now: 1000 }), { space: "spc_1", role: "temp", expires: 1000 + 7 * 86_400_000 });
});

test("a made invite says the link and whether you must confirm words; a row names the role and hides nothing it was not given", () => {
  assert.deepEqual(madeNote({ id: "inv_1", link: "https://h.vyre.run/join/x", needs_confirm: true }), { link: "https://h.vyre.run/join/x", id: "inv_1", needsConfirm: true, line: "The link works once for one person." });
  const r = inviteRow({ id: "inv_2", role: "temp", status: "open", valid_until: 1_790_000_000_000 });
  assert.equal(r.title, "Temp invite"); assert.equal(r.open, true);
  assert.equal(inviteRow({ id: "i3", role: "member", status: "used" }).open, false);
});

test("refusals get plain words", () => {
  assert.match(inviteRefusal("not_allowed", ""), /owner or admin/);
  assert.match(inviteRefusal("presence_required", ""), /Face ID/);
  assert.equal(inviteRefusal("x", "the box said"), "the box said");
});
