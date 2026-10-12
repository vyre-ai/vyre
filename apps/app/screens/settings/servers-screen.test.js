// @ts-check
// The Servers screen on a boxless window (a Mac that runs on a server, nothing paired yet): the add door and the typed-code pairing are there with no rows, and nothing waits on a box that does not exist.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./ServersScreen.tsx", import.meta.url), "utf8");

test("servers screen: the add door does not depend on there being a server or a Personal space", () => {
  const beforeAdd = src.slice(0, src.indexOf("<AddServerCard"));
  assert.match(src, /ADD\.action/, "the door is worded");
  assert.doesNotMatch(src.slice(src.indexOf("return (")), /rows\s*&&\s*rows\.length[^?]*\?[^:]*<AddServerCard/, "the add card is not inside the rows condition");
  assert.ok(src.includes("adding ? ("), "the door is shown whenever the person is not already adding");
  void beforeAdd;
});

test("servers screen: a device with no box answers 'no servers' instead of waiting, and the typed code is offered beside the door", () => {
  assert.match(src, /tool<[^>]*>\("spaces\.servers"\)\.catch\(\(\) => null\)/, "a failed spaces.servers is an empty list");
  assert.match(src, /<TypeCode redeem=\{redeemPairing\}/, "a code from another device pairs a server here too");
});

test("settings lists Servers whether or not anything is paired", async () => {
  const { settingsGroups } = await import("./logic.js");
  const rows = settingsGroups("Juniper Studio").flatMap((g) => g.rows);
  assert.ok(rows.some((r) => r[2] === "/u/settings/servers"));
});
