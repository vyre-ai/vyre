// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordsSetup } from "./records-setup.js";

test("while a space's records start, one calm card says so and how far it is; when they are ready, nothing", () => {
  assert.equal(recordsSetup({ spaces: [{ space: "a", ready: true }] }), null);
  assert.equal(recordsSetup(undefined), null);
  assert.equal(recordsSetup({}), null);
  const c = recordsSetup({ spaces: [{ space: "a", ready: true }, { space: "b", ready: false, words: "the record store is still starting: starting Records (the first start takes a few minutes) (2 minutes so far)" }] });
  assert.equal(c && c.title, "Setting up your records");
  assert.equal(c && c.detail, "Starting Records (the first start takes a few minutes) (2 minutes so far)");
  assert.equal(recordsSetup({ spaces: [{ space: "b", ready: false }] })?.detail, null);
});
