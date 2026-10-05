import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isBasicRow, gatedPath, backupLine, NEEDS_SERVER } from "./basic.js";

test("a personal space with no server is Basic; a server or a team space is not", () => {
  assert.equal(isBasicRow({ setup: { who: "personal" }, home: { kind: "this-computer" } }), true);
  assert.equal(isBasicRow({ setup: { who: "personal" }, home: null }), true);
  assert.equal(isBasicRow({ setup: { who: "personal" }, home: { kind: "server" } }), false);
  assert.equal(isBasicRow({ setup: { who: "team" }, home: { kind: "server" } }), false);
  assert.equal(isBasicRow(null), false);
  assert.equal(NEEDS_SERVER, "This needs a space on a server");
});

test("records, flows, the planner and the calendar are gated; chats and projects are not", () => {
  for (const p of ["/u/records/contact", "/u/record/abc", "/u/flows", "/u/flows/x", "/u/kits", "/u/planner", "/u/calendar", "/u/task/t1", "/u/settings/customize"]) assert.equal(gatedPath(p), true, p);
  for (const p of ["/u/now", "/u/chats", "/u/chats/c1", "/u/projects", "/u/project/p1", "/u/settings", "/u/memory", "/u/vault", "/u/drive"]) assert.equal(gatedPath(p), false, p);
});

test("the backup line: not backed up with no team, the destination when the box says, nothing when it is unknown", () => {
  assert.equal(backupLine({ basic: true, teams: [] }), "Not backed up: join a team or add a server");
  assert.equal(backupLine({ basic: true, teams: [{ name: "Harlow" }], status: { to: "Harlow" } }), "Backed up, encrypted, to Harlow");
  assert.equal(backupLine({ basic: true, teams: [{ name: "Harlow" }] }), null, "a team exists but the box has not said: no claim");
  assert.equal(backupLine({ basic: false, teams: [] }), null);
});
