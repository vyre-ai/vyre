import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { shapeSpaces, shapeMembers, roleNames, personName, daysLeft, setRoleInput, extendedTo, shapeProjects, warningLines, homeWords } from "./real.js";

// Shapes captured from a kernel-on vyred (spaces.list, spaces.members.list, spaces.roles.names).
const LIST = [{ id: "spc_a58c2e0dbfb34fc2", name: "harlowdev.vyre.run", label: "harlowdev", displayName: "Harlow Legal", status: "done", home: { kind: "this-computer", device: { id: "u7", name: "this computer", alwaysOn: false } }, role: "owner", aliases: [], workspaceId: null, warnings: [], createdAt: 1, setup: null }];
const MEMBERS = { space: "spc_a58c2e0dbfb34fc2", members: [
  { space: "s", person: "per_pbiglgp6ji6jzrnbskpuzw77np", role: "owner", added_by: "per_pbiglgp6ji6jzrnbskpuzw77np", added_at: 1, role_label: "Owner" },
  { space: "s", person: "per_dana000000", role: "temp", scope: ["prj_1"], expires: Date.UTC(2026, 9, 14), role_label: "Temp" },
], warnings: [{ code: "single_owner", message: "This space has one owner." }] };

test("a space card reads the display name, address, role and home", () => {
  assert.deepEqual(shapeSpaces(LIST), [{ id: "spc_a58c2e0dbfb34fc2", name: "Harlow Legal", address: "harlowdev.vyre.run", role: "owner", home: "this computer", setup: null }]);
  assert.deepEqual(shapeSpaces(null), []);
  assert.equal(homeWords({ kind: "server" }), "your server");
});

test("members: you, a short id for others, a temp carries scope, end and days left", () => {
  const now = Date.UTC(2026, 9, 3);
  const m = shapeMembers(MEMBERS, "per_pbiglgp6ji6jzrnbskpuzw77np", now, { prj_1: "Doe estate plan" });
  assert.equal(m[0].name, "You");
  assert.equal(m[0].scope, undefined);
  assert.deepEqual([m[1].role, m[1].scope, m[1].left], ["temp", "Doe estate plan", 11]);
  assert.match(m[1].end, /^\d+ Oct$/);
  assert.equal(personName("per_abcdefghij", null), "Member abcdef");
  assert.deepEqual(warningLines(MEMBERS), ["This space has one owner."]);
});

test("role names come from the kernel's answer", () => {
  assert.deepEqual(roleNames({ names: [{ id: "owner", name: "Owner" }, { id: "temp", name: "Guest" }] }), { owner: "Owner", temp: "Guest" });
});

test("writes carry what the box takes: a temp has scope and an end in ms, others neither", () => {
  const now = 1_000_000;
  assert.deepEqual(setRoleInput("s", "p", "member", {}, now), { space: "s", person: "p", role: "member" });
  assert.deepEqual(setRoleInput("s", "p", "temp", { scope: ["a"], days: 7 }, now), { space: "s", person: "p", role: "temp", scope: ["a"], expires: now + 7 * 86_400_000 });
  assert.equal(extendedTo(now + 86_400_000, 7, now), now + 8 * 86_400_000);
  assert.equal(extendedTo(null, 7, now), now + 7 * 86_400_000);
  assert.equal(daysLeft(now - 5, now), 0);
  assert.equal(daysLeft(null, now), undefined);
});

test("projects: id and name, nothing else", () => {
  assert.deepEqual(shapeProjects({ projects: [{ id: "p1", name: "Doe estate plan", x: 1 }, {}] }), [{ id: "p1", name: "Doe estate plan" }]);
  assert.deepEqual(shapeProjects({ projects: [], problems: [] }), []);
});
