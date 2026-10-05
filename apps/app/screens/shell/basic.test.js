import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isBasicRow, gatedPath, backupLine, NEEDS_SERVER } from "./basic.js";

test("a space is Basic only when the box says tier basic; cloud and team spaces are not", () => {
  assert.equal(isBasicRow({ tier: "basic" }), true);
  assert.equal(isBasicRow({ tier: "cloud" }), false);
  assert.equal(isBasicRow({ setup: { who: "personal" }, home: { kind: "this-computer" } }), false, "no inference from other fields");
  assert.equal(isBasicRow(null), false);
  assert.equal(NEEDS_SERVER, "This needs a Cloud space");
});

test("records, flows, the planner and the calendar are gated; chats and projects are not", () => {
  for (const p of ["/u/records/contact", "/u/record/abc", "/u/flows", "/u/flows/x", "/u/kits", "/u/planner", "/u/calendar", "/u/task/t1", "/u/settings/customize"]) assert.equal(gatedPath(p), true, p);
  for (const p of ["/u/now", "/u/chats", "/u/chats/c1", "/u/projects", "/u/project/p1", "/u/settings", "/u/memory", "/u/vault", "/u/drive"]) assert.equal(gatedPath(p), false, p);
});

test("the backup line: not backed up with no team, the destination when the box says, nothing when it is unknown", () => {
  const NB = "Not backed up: join a team or set up My Cloud";
  assert.equal(backupLine({ basic: true, teams: [] }), NB);
  assert.equal(backupLine({ basic: true, teams: [{ name: "Harlow" }], status: { to: "Harlow", state: "ok" } }), "Backed up, encrypted, to Harlow");
  assert.equal(backupLine({ basic: true, teams: [{ name: "Harlow" }], status: { to: null } }), NB);
  assert.equal(backupLine({ basic: true, teams: [{ name: "Harlow" }] }), null, "a team exists but the box has not said: no claim");
  assert.equal(backupLine({ basic: false, teams: [] }), null);
});
