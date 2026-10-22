// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { keptTeamServers, readTeamServers } from "./team-server.js";

test("a server named as the team's is remembered, and a repeat is not stored twice", () => {
  assert.deepEqual(keptTeamServers([], "srv_team"), ["srv_team"]);
  assert.deepEqual(keptTeamServers(["srv_team"], "srv_team"), ["srv_team"]);
  assert.deepEqual(keptTeamServers(["srv_team"], "srv_other"), ["srv_team", "srv_other"]);
  assert.deepEqual(keptTeamServers(["srv_team"], ""), ["srv_team"]);
  assert.deepEqual(readTeamServers(JSON.stringify(["srv_team", "", 4])), ["srv_team"]);
  assert.deepEqual(readTeamServers("nope"), []);
  assert.deepEqual(readTeamServers(null), []);
});
