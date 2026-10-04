// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLink, joinTarget } from "./join-link.js";

test("only an https join link of a space is passed on, encoded once or twice", () => {
  const good = "https://harlow.vyre.run/join/7Kq2-M9";
  assert.equal(joinLink(good), good);
  assert.equal(joinLink(encodeURIComponent(good)), good);
  assert.equal(joinTarget(good), `/u/install/join?link=${encodeURIComponent(good)}`);
  for (const bad of ["http://harlow.vyre.run/join/x", "https://harlow.vyre.run/other/x", "javascript:alert(1)", "", undefined, "https://h.vyre.run/join/"]) assert.equal(joinLink(bad), null);
  assert.equal(joinTarget("nope"), "/u/install/join");
});
