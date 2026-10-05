// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("RC1 (screens/shell/rc.ts, the one switch file): the browser claim is on, sites are off", () => {
  const rc = read("../../screens/shell/rc.ts");
  assert.match(rc, /sites: false/);
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

test("the name step on a blocked browser offers only scan, and Sites is hidden from nav and routes", () => {
  const screen = read("../../screens/install/InstallScreen.tsx");
  // A browser holds no key: its first screen is "Open Vyre on your phone" (scan or paste), never the claim.
  const blocked = screen.slice(screen.indexOf('step === "browser" ||'), screen.indexOf('} else if (step === "nosetup")'));
  assert.ok(blocked.includes("BROWSER.title") && blocked.includes("PairEntry") && !/createIdentity/.test(blocked));
  assert.match(read("../../screens/shell/nav.ts"), /RC\.sites \? \[/);
  assert.match(read("../../app/u/sites.tsx"), /RC\.sites \? SitesScreen : HiddenSites/);
});
