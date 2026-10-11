// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedOf, memberLine, refusal, switchLine } from "./computers-model.js";

test("the words for the Space rule, for a member's line, and for a refusal", () => {
  assert.match(switchLine(true, "Northwind's Cloud"), /may run on a member's own computer/);
  assert.match(switchLine(false, "Northwind's Cloud"), /runs on the server/);
  assert.equal(memberLine("Northwind's Cloud", true), "Northwind's Cloud allows sessions on your computer.");
  assert.match(memberLine("Northwind's Cloud", false), /keeps sessions on its server/);
  assert.equal(memberLine("Northwind's Cloud", null), "");
  assert.equal(refusal("forbidden", "x"), "Only an owner or an admin of this Space can change that.");
  assert.equal(refusal("odd", "plain words"), "plain words");
  assert.equal(allowedOf({ space: "s", allowed: false }), false);
  assert.equal(allowedOf({ error: 1 }), null);
});
