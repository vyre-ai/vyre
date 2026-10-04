// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as identity from "./identity.js";

const ID = "0123456789abcdef0123456789abcdef";

test("identity: fingerprint8() is the first 8 bytes of sha256(\"vyre:person:v1:\"+id) by default", () => {
  // Computed independently (node -e with crypto), not by re-running the function under test.
  const bytes = identity.fingerprint8(ID);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, 8);
  assert.equal(bytes.toString("hex"), "5ab34bc68c763d2f");
});

test("identity: fingerprint8() takes a kind, and person vs assistant fingerprint differently for the same id", () => {
  const person = identity.fingerprint8(ID, "person");
  const assistant = identity.fingerprint8(ID, "assistant");
  assert.equal(assistant.toString("hex"), "e0dcdc2af18efbf4");
  assert.notEqual(person.toString("hex"), assistant.toString("hex"));
});

test("identity: fingerprint8() rejects an unknown kind and any id that isn't 32 lowercase hex characters, rather than silently fingerprinting garbage", () => {
  assert.throws(() => identity.fingerprint8(ID, "device"));
  assert.throws(() => identity.fingerprint8(""));
  assert.throws(() => identity.fingerprint8(ID.slice(0, 31)), "too short");
  assert.throws(() => identity.fingerprint8(ID + "0"), "too long");
  assert.throws(() => identity.fingerprint8(ID.toUpperCase()), "case-sensitive: mixed case would hash to a different fingerprint than its lowercase self");
  assert.throws(() => identity.fingerprint8("not-hex-at-all-0123456789abcdef"));
});

test("identity: OWNER_ID_RE is the one shape check -- every caller (core/config, system.info, the relay) gets it by calling fingerprint8() itself", () => {
  assert.match(ID, identity.OWNER_ID_RE);
  assert.doesNotMatch(ID.toUpperCase(), identity.OWNER_ID_RE);
});

test("identity: deterministic, and a different id fingerprints differently", () => {
  assert.deepEqual(identity.fingerprint8(ID), identity.fingerprint8(ID));
  assert.notDeepEqual(identity.fingerprint8(ID), identity.fingerprint8("f".repeat(32)));
});

test("identity: toBase64url()/fromBase64url() round-trip, and match the relay's own encoding of the same 8 bytes", () => {
  const bytes = identity.fingerprint8(ID, "person");
  const b64 = identity.toBase64url(bytes);
  // The relay's ticket vector (team-lead, 28 Sep): identityFingerprint for this id/kind.
  assert.equal(b64, "WrNLxox2PS8");
  assert.deepEqual(identity.fromBase64url(b64), bytes);
});
