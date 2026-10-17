// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openProfile, sealProfile } from "./browser-profile.js";

test("browser-profile: seal and open round-trip", () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from("cookies-and-storage");
  const sealed = sealProfile(key, plain);
  assert.notDeepEqual(sealed, plain);
  assert.deepEqual(openProfile(key, sealed), plain);
});
