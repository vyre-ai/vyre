// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { FIRST_RUN, OLD_ROUTES, oldRouteTarget } from "./old-routes.js";

test("every old first-run address lands on the step it meant, and only those", () => {
  assert.equal(oldRouteTarget("/u/install"), "/onboard");
  assert.equal(oldRouteTarget("/u/install/"), "/onboard");
  assert.equal(oldRouteTarget("/u/install/join?link=x"), "/onboard?path=join");
  assert.equal(oldRouteTarget("/u/install/connect"), "/onboard?path=computer");
  assert.equal(oldRouteTarget("/u/install/create"), "/onboard?path=create");
  assert.equal(oldRouteTarget("/u/install/phone"), "/onboard?path=phone");
  assert.equal(oldRouteTarget("/u/install/setup"), "/onboard");
  assert.equal(oldRouteTarget("/pair"), "/onboard", "the old bearer pairing link");
  for (const other of ["/", "/u/now", "/u/install/unknown", "/onboard", "/u/settings", "/join", ""]) assert.equal(oldRouteTarget(other), null, other);
  for (const to of Object.values(OLD_ROUTES)) assert.ok(Object.values(FIRST_RUN).includes(to), `${to} is a first-run route`);
});
