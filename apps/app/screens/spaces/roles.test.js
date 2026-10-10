import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ROLES, assignable, ownerMoveLine, canManage, endDate, endingSoon, extend, tempLine, withRole } from "./roles.js";

test("there are five fixed roles", () => {
  assert.deepEqual(ROLES.map((r) => r.id), ["owner", "admin", "manager", "member", "temp"]);
});

test("an owner gives any role but Owner, an admin only below admin, others none", () => {
  assert.deepEqual(assignable("owner"), ["admin", "manager", "member", "temp"]);
  assert.deepEqual(assignable("admin"), ["manager", "member", "temp"]);
  assert.deepEqual(assignable("member"), []);
});

test("nobody edits themselves here, and an admin cannot touch an owner or another admin", () => {
  assert.equal(canManage("owner", "admin"), true);
  assert.equal(canManage("owner", "owner", true), false);
  assert.equal(canManage("admin", "manager"), true);
  assert.equal(canManage("admin", "admin"), false);
  assert.equal(canManage("admin", "owner"), false);
  assert.equal(canManage("manager", "member"), false);
});

test("dates count from 3 Oct 2026", () => {
  assert.equal(endDate(11), "14 Oct");
  assert.equal(endDate(3), "6 Oct");
  assert.equal(endDate(30), "2 Nov");
});

test("a temp member's line says the project, the date and the days left", () => {
  assert.equal(tempLine({ scope: "Doe estate plan", end: "14 Oct", left: 11 }), "Only Doe estate plan, ends 14 Oct (11 days)");
  assert.equal(tempLine({ scope: "X", end: "4 Oct", left: 1 }), "Only X, ends 4 Oct (1 day)");
});

test("ending soon means three days or fewer, for temp only", () => {
  assert.equal(endingSoon({ role: "temp", left: 3 }), true);
  assert.equal(endingSoon({ role: "temp", left: 4 }), false);
  assert.equal(endingSoon({ role: "member", left: 1 }), false);
});

test("extending adds days and moves the end date", () => {
  const m = extend({ left: 3 }, 7);
  assert.equal(m.left, 10);
  assert.equal(m.end, "13 Oct");
});

test("a temp role gets a scope and an end; any other role drops them", () => {
  const t = withRole({ id: "ben", role: "member" }, "temp", { scope: "Doe estate plan", days: 7 });
  assert.equal(t.scope, "Doe estate plan");
  assert.equal(t.left, 7);
  const m = withRole(t, "member");
  assert.equal("scope" in m, false);
  assert.equal(m.role, "member");
});

test("changing a server's owner is done on the server, and the line says so", () => {
  assert.ok(!assignable("owner").includes("owner"));
  assert.equal(ownerMoveLine("Chris Park"), "This server already belongs to Chris Park. To move it, do it on this server and approve with your passkey.");
});

test("members list: each person is a list row with the id-seeded face, their role or temp scope and end, and Extend only for a temp member you may manage", async () => {
  const { memberRows } = await import("./roles.js");
  const members = [{ id: "p1", name: "Chris Park", role: "owner" }, { id: "p2", name: "Dana Reyes", role: "temp", scope: "Smith estate", end: "14 Oct" }, { id: "p3", name: "Sam", role: "temp", scope: "X", end: "1 Nov" }];
  const rows = memberRows(members, (m) => m.id !== "p3", [{ id: "juno", name: "juno", sub: "Your assistant" }]);
  assert.deepEqual(rows[0], { id: "p1", title: "Chris Park", subtitle: "Owner", faces: [{ kind: "person", name: "Chris Park", id: "p1" }] });
  assert.deepEqual([rows[1].subtitle, rows[1].accessories, rows[1].actions], ["Temp, ends 14 Oct · Only Smith estate", undefined, [{ id: "extend", title: "Extend" }]]);
  assert.equal(rows[2].actions, undefined, "not yours to manage");
  assert.deepEqual(rows[3], { id: "juno", title: "juno", subtitle: "Your assistant", faces: [{ kind: "assistant", name: "juno", id: "juno" }] });
});
