// @ts-check
// The Servers screen in words (servers-model.js): one row per server the device is paired to, naming the Space on it with the tag every row of that Space carries, and saying Offline when the server did not answer.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADD, serverRows, serversLine } from "./servers-model.js";

const pairings = [{ box: "boxa", name: "my droplet" }, { box: "boxb", name: "" }];
const spaces = [
  { id: "spc_aaaaaaaaaaaa", label: "personal", tier: "cloud", server: "boxa" },
  { id: "spc_bbbbbbbbbbbb", displayName: "Northwind", tier: "cloud", server: "boxb" },
];

test("servers: each row names its server and the Space on it, with the same tag the Space's rows carry", () => {
  const rows = serverRows({ pairings, spaces, offline: [], active: "boxa" });
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.space, r.offline]), [["boxa", "my droplet", "Personal - Cloud", false], ["boxb", "Server 2", "Northwind", false]]);
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].active, false);
});

test("servers: a server that did not answer says Offline and keeps its Space's name from the last time", () => {
  const rows = serverRows({ pairings, spaces, offline: ["boxb"], active: "boxa" });
  assert.equal(rows[1].offline, true);
  assert.equal(rows[1].space, "Northwind");
  assert.match(rows[1].sub, /Offline/);
});

test("servers: a server with no Space listed yet says so, not a blank", () => {
  const rows = serverRows({ pairings, spaces: [], offline: [], active: "boxa" });
  assert.match(rows[0].sub, /No Space on it yet/);
  assert.equal(rows[0].space, "");
});

test("servers: no pairings is no rows, and the line says how to add one", () => {
  assert.deepEqual(serverRows({ pairings: [], spaces, offline: [], active: null }), []);
  assert.match(serversLine(0), /Add a server/);
  assert.equal(serversLine(1), "1 server");
  assert.equal(serversLine(2), "2 servers");
});

test("servers: the add door is always worded the same, and says one Space per server", () => {
  assert.equal(ADD.action, "Add another server");
  assert.match(ADD.body, /one Space/i);
});
