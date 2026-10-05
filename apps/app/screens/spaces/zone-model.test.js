import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { zoneOptions } from "./zone-model.js";

test("the zone choices put the current zone first and hold only zones lib/time knows", () => {
  const o = zoneOptions("Asia/Karachi");
  assert.equal(o[0][0], "Asia/Karachi");
  assert.ok(o.length > 100, "the platform's own list");
  assert.ok(o.every(([z]) => !/^Mars\//.test(z)));
  assert.equal(zoneOptions("Mars/Olympus")[0][0] !== "Mars/Olympus", true, "a made-up current zone is not offered");
  assert.equal(new Set(o.map(([z]) => z)).size, o.length, "each once");
});
