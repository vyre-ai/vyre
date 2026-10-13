// @ts-check
// The words under a server in "Which server is this for?" (pick-server.js): what is already on it, so the person does not name a Space on a server that already runs one.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLine } from "./pick-server.js";

test("pick: a server with a Space says what it has, and that a server holds one Space", () => {
  assert.match(pickLine({ key: "a", name: "x", route: null, has: "Personal - Cloud" }), /Has Personal - Cloud/);
  assert.match(pickLine({ key: "a", name: "x", route: null, has: "Personal - Cloud" }), /one Space/);
});

test("pick: a server with nothing on it says so", () => {
  assert.equal(pickLine({ key: "a", name: "x", route: null, has: "" }), "Nothing on it yet.");
});
