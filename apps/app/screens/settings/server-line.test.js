// @ts-check
// "Which server is this for" on the screens that act on one server (server-line.js): with several servers paired the screen says whose it is; with one it says nothing.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { serverLine } from "./server-line.js";

const pairings = [{ box: "boxa", name: "my droplet" }, { box: "boxb", name: "" }];
const A = "spc_aaaaaaaaaaaa", B = "spc_bbbbbbbbbbbb";
const spaceServers = { [A]: "boxa", [B]: "boxb" };

test("server line: one server paired says nothing", () => {
  assert.equal(serverLine({ pairings: [pairings[0]], spaceServers, showing: A, active: "boxa" }), "");
  assert.equal(serverLine({ pairings: [], spaceServers, showing: A, active: null }), "");
});

test("server line: with several, a Space showing names its server", () => {
  assert.equal(serverLine({ pairings, spaceServers, showing: A, active: "boxa" }), "This is for my droplet.");
  assert.equal(serverLine({ pairings, spaceServers, showing: B, active: "boxa" }), "This is for Server 2.");
});

test("server line: under All spaces it names the main server and says how to pick another", () => {
  assert.equal(serverLine({ pairings, spaceServers, showing: "all", active: "boxa" }), "This is for my droplet, your main server. Pick a Space to act on another server.");
});

