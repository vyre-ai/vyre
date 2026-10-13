// @ts-check
// The servers a Create a team space can be made on (server-choices.js): a phone or browser lists its own pairings, the Mac lists what its daemon is paired to. Each choice carries what the call needs: the key the call
// names the server by (a box id on a phone, the daemon's server id on the Mac) and where the server is reached, for the Space's directory record.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { choicesFromDaemon, choicesFromPairings } from "./server-choices.js";

const spaces = [{ id: "spc_aaaaaaaaaaaa", label: "personal", tier: "cloud", server: "boxa" }];

test("choices: a phone's pairings, each with its route, its name and the Space already on it", () => {
  const c = choicesFromPairings([{ relay: "wss://r", route: "rt1", box: "boxa", name: "my droplet" }, { relay: "wss://r", route: "rt2", box: "boxb", name: "" }], spaces);
  assert.deepEqual(c.map((x) => [x.key, x.name, x.has]), [["boxa", "my droplet", "Personal - Cloud"], ["boxb", "Server 2", ""]]);
  assert.deepEqual(c[1].route, { relay: "wss://r", route: "rt2", box: "boxb" });
});

test("choices: the Mac's daemon servers carry their channel as the route; one with no channel has none and is still a choice", () => {
  const c = choicesFromDaemon({ servers: [{ id: "srv_1", name: "first", channel: { relay: "wss://r", route: "rt1", box: "b1" } }, { id: "srv_2", name: "second" }] });
  assert.deepEqual(c.map((x) => [x.key, x.name, x.route?.route ?? null]), [["srv_1", "first", "rt1"], ["srv_2", "second", null]]);
});

test("choices: junk from the daemon is no choices, not a throw", () => {
  for (const bad of [null, undefined, {}, { servers: "x" }, { servers: [null, { name: "no id" }] }]) assert.deepEqual(choicesFromDaemon(/** @type {any} */ (bad)), []);
});
