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

test("servers screen: a device with no box answers 'no servers' instead of waiting, and no typed code is offered beside the door", () => {
  assert.match(src, /tool<[^>]*>\("spaces\.servers"\)\.catch\(\(\) => null\)/, "a failed spaces.servers is an empty list");
  assert.doesNotMatch(src, /TypeCode|redeemPairing/, "a typed code from another device is not how a server is added: the door is the install line and its pair code");
});

test("Servers is folded into Devices and computers: off the Settings list and off Labs, and Look and name still adds a server", async () => {
  const { settingsGroups } = await import("./logic.js");
  assert.ok(!settingsGroups("Juniper Studio").flatMap((g) => g.rows).some((r) => r[2] === "/u/settings/servers"));
  assert.ok(!((settingsGroups("Juniper Studio", undefined, { labs: true }).find((g) => g.title === "Labs")?.rows ?? []).some((r) => r[2] === "/u/settings/servers")));
  const devices = settingsGroups("Juniper Studio").flatMap((g) => g.rows).find((r) => r[2] === "/u/settings/devices");
  assert.match(devices[1], /servers/);
  const spaces = fs.readFileSync(new URL("../spaces/SpacesScreen.tsx", import.meta.url), "utf8");
  assert.match(spaces, /<MyCloudCard/, "the add-a-server door stays reachable from Look and name");
});

test("servers screen: a server connected from the list says so and has a Remove, and a server that is not answering has the same Remove", () => {
  assert.match(src, /Connected to \$\{r\.name\} from your list/);
  assert.match(src, /label="Remove"/);
  assert.match(src, /removeFromComputer/);
  assert.match(src, /r\.offline \|\| fromList\.includes\(r\.key\)/);
});

test("the chain pairing is off by default: a listed server answers server_not_ready until the server side is signed", () => {
  const app = fs.readFileSync(new URL("../../src/real/space-list-app.ts", import.meta.url), "utf8");
  assert.match(app, /let chainPairer: ChainPairer = async \(\) => \{ throw[^}]*server_not_ready/);
});
