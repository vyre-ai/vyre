// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BROWSER_CLAIM_ON, NO_BROWSER_CLAIM, PUBLISH_ON, claimHere } from "./flags.js";

test("RC1: a browser never claims a name unless the build says so; phones and computers do; the switches are off by default", () => {
  assert.equal(BROWSER_CLAIM_ON, false);
  assert.equal(PUBLISH_ON, false);
  assert.equal(claimHere("web"), false);
  assert.equal(claimHere("web", false), false);
  assert.equal(claimHere("web", true), true);
  assert.equal(claimHere("ios"), true);
  assert.equal(claimHere("android"), true);
  assert.match(NO_BROWSER_CLAIM, /phone or computer app/);
});

test("createIdentity refuses on the web before it makes a key, opens storage or asks the directory", () => {
  const src = fs.readFileSync(new URL("./install.ts", import.meta.url), "utf8");
  const guard = src.indexOf("if (!claimHere(Platform.OS)) throw");
  const claim = src.indexOf("await claimIdentity(");
  assert.ok(guard > 0 && claim > guard, "the platform guard comes before claimIdentity");
  const body = src.slice(src.indexOf("export async function createIdentity"), claim);
  assert.ok(!/saveIdentity|indexedDB|fetch\(/.test(body), "nothing is stored or fetched before the guard");
});

test("the Sites entry and its pages are behind the publish switch", () => {
  const nav = fs.readFileSync(new URL("../../screens/shell/nav.ts", import.meta.url), "utf8");
  assert.match(nav, /PUBLISH_ON \? \[\{ id: "sites"/);
  for (const f of ["SitesScreen", "SiteScreen"]) assert.match(fs.readFileSync(new URL(`../../screens/sites/${f}.tsx`, import.meta.url), "utf8"), /!PUBLISH_ON\) return <NotYet \/>/);
});
