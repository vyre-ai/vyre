// @ts-check
// "Take a known secret value out of text" is one function, lib/scrub.js (consolidation inventory item 2, R031-00c). This test fails when a source file outside a short named list writes the
// value-form idiom (base64 / URL-encoded forms) or a `.split(value).join("[marker]")` of its own.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findInSource } from "./source-files.js";

/** Where an own scrub is still allowed, and why. */
const ALLOWED = new Map([
  ["lib/scrub.js", "the one implementation"],
  ["core/computers/image/", "computerd is copied alone into the computers image and cannot import lib/"],
  ["core/vault/cli-io.js", "a streaming scrubber for a child's output across chunk boundaries; it takes its marker from lib/scrub.js"],
  ["apps/app/screens/connections/model.ts", "runs in the phone app, which has no Buffer; one key, exact match"],
]);
const PATTERNS = [
  /%20\/g,\s*["'`]\+["'`]/,
  /\.split\([^)]*\)\.join\(\s*(CONCEALED|["'`]\[[a-z ]+\]["'`]|["'`]<concealed)/,
];

test("no other source file scrubs known values on its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "write scrub(text, values, { marker }) from lib/scrub.js instead");
});
