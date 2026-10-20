// A Vault field's name is case-insensitive and has one form, UPPER_SNAKE (lib/env-name.js): shown that way, matched that way, delivered that way.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, clashes, fieldIn, isCanonical, sameName } from "./env-name.js";

test("every spelling of a name becomes its one form", () => {
  for (const typed of ["ghl api-key", "Ghl_Api_Key", "GHL_API_KEY", "ghl.api.key", " ghl  api key "]) assert.equal(canonical(typed), "GHL_API_KEY", typed);
  assert.equal(canonical("twilio account sid"), "TWILIO_ACCOUNT_SID");
  assert.equal(canonical("2fa code"), "_2FA_CODE", "a leading digit still makes an environment variable name");
  assert.equal(canonical("---"), "");
  assert.equal(isCanonical("GHL_LOCATION_ID"), true);
  assert.equal(isCanonical("ghl_location_id"), false);
});

test("a wanted name finds the stored field by its one form; an exact name wins; a clash picks nothing", () => {
  assert.equal(fieldIn(["GHL_API_KEY", "GHL_LOCATION_ID"], "ghl_api_key"), "GHL_API_KEY", "a Flow asking for ghl_api_key gets GHL_API_KEY");
  assert.equal(fieldIn(["account", "value"], "ACCOUNT"), "account", "an older lower-case field answers its one form");
  assert.equal(fieldIn(["value"], "value"), "value");
  assert.equal(fieldIn(["API_KEY", "api_key"], "Api-Key"), "Api-Key", "two stored names with one form: none is guessed");
  assert.equal(fieldIn(["API_KEY"], "TOKEN"), "TOKEN", "no match leaves the caller's own words");
  assert.equal(sameName("Api_Key", "API_KEY"), true);
  assert.deepEqual(clashes(["API_KEY", "api_key", "URL"]), [{ name: "API_KEY", stored: ["API_KEY", "api_key"] }]);
});
