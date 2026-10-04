// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("RC1 (screens/shell/rc.ts, the one switch file): both switches are off", () => {
  const rc = read("../../screens/shell/rc.ts");
  assert.match(rc, /sites: false/);
  assert.match(rc, /browserClaim: false/);
  assert.ok(!fs.existsSync(new URL("./flags.js", import.meta.url)), "no second switch file");
});

test("createIdentity refuses on a blocked browser before it makes a key, opens storage or asks the directory", () => {
  const src = read("./install.ts");
  const guard = src.indexOf("if (claimBlocked()) throw");
  const claim = src.indexOf("await claimIdentity(");
  assert.ok(guard > 0 && claim > guard, "the guard comes before claimIdentity");
  const body = src.slice(src.indexOf("export async function createIdentity"), claim);
  assert.ok(!/saveIdentity|indexedDB|fetch\(/.test(body), "nothing is stored or fetched before the guard");
});

test("the name step on a blocked browser offers only scan, and Sites is hidden from nav and routes", () => {
  const screen = read("../../screens/install/InstallScreen.tsx");
  const blocked = screen.slice(screen.indexOf("claimBlocked()) {"), screen.indexOf('} else if (step === "name")'));
  assert.ok(blocked.includes("HIDDEN.claimAction") && !/createIdentity/.test(blocked));
  assert.match(read("../../screens/shell/nav.ts"), /RC\.sites \? \[/);
  assert.match(read("../../app/u/sites.tsx"), /RC\.sites \? SitesScreen : HiddenSites/);
});
