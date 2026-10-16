// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("RC1 (screens/shell/rc.ts, the one switch file): the browser claim is on, sites are on (0.5)", () => {
  const rc = read("../../screens/shell/rc.ts");
  assert.match(rc, /sites: true/);
  assert.match(rc, /browserClaim: process\.env\.EXPO_PUBLIC_VYRE_BROWSER_CLAIM !== "0"/, "on unless a build sets the flag to 0, read in the one form Expo inlines");
  assert.ok(!fs.existsSync(new URL("./flags.js", import.meta.url)), "no second switch file");
});

test("createIdentity refuses on a blocked browser before it makes a key, opens storage or asks the directory", () => {
  const src = read("./install.ts");
  const guard = src.indexOf("if (claimBlocked()) throw");
  const claim = src.indexOf("await claim(");
  assert.ok(guard > 0 && claim > guard, "the guard comes before claimIdentity");
  const body = src.slice(src.indexOf("export async function createIdentity"), claim);
  assert.ok(!/saveIdentity|indexedDB|fetch\(/.test(body), "nothing is stored or fetched before the guard");
});

test("Sites is hidden from nav and routes where the build has no Sites", () => {
  // the places are lib/sidebar/model.js (Sites is `optional`), and the app shows it only where the build has it (PLACE_FLAGS in nav.ts)
  assert.match(read("../../../../lib/sidebar/model.js"), /id: "sites"[^}]*optional: "sites"/);
  assert.match(read("../../screens/shell/nav.ts"), /sites: Boolean\(RC\.sites\)/);
  assert.match(read("../../app/u/sites.tsx"), /RC\.sites \? SitesScreen : HiddenSites/);
});

test("a browser on an origin that cannot hold the passkey is blocked from claiming, so it pairs with the typed code", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../screens/shell/rc.ts", import.meta.url), "utf8");
  assert.match(src, /passkeyRp\(typeof location !== "undefined" \? location\.origin : undefined, \{ dev: process\.env\.NODE_ENV !== "production" \}\) === null/);
  assert.match(src, /Platform\.OS === "web" && !macKeyAvailable\(\)/, "the Mac app's window is never blocked");
});

test("Glass (Screen Share) is hidden for 0.2.9: the switch is off", () => {
  const rc = read("../../screens/shell/rc.ts");
  assert.match(rc, /glass: false/);
});
