// The owner's presence key from a pairing hello: the device's own word on where it keeps its key counts, the relay's "unknown" does not beat it, and a key that says nothing is not enrolled (the pairing then refuses out loud).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { presenceKeyFor } from "./presence-key.js";

const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");

test("the app's own key storage beats the relay's unknown", () => {
  const k = presenceKeyFor("dev_a", { key: key(), alg: -7, storage: "unknown" }, { keyStorage: "software" });
  assert.equal(k && k.signer, "software", "the relay filled in unknown; the app said software");
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7 }, { keyStorage: "software" })?.signer, "software");
});

test("a hardware signer is kept as it is, with its relying party when it is a passkey", () => {
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, storage: "unknown" }, { keySigner: "secure_enclave" })?.signer, "secure_enclave");
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7 }, { keySigner: "webauthn_platform", keyRp: "vyre.run" })?.rp, "vyre.run");
});

test("a key with no stated storage and no hardware signer is not enrolled, and neither is a key of another algorithm or none", () => {
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, storage: "unknown" }, {}), null);
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7 }, { keyStorage: "unknown" }), null);
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -8 }, { keySigner: "tpm" }), null);
  assert.equal(presenceKeyFor("dev_a", null, {}), null);
});

test("the signer class is the device's own word in its own adopt call: what the relay holds of the hello (confirmed.signer, confirmed.rp) adds nothing, so a relay cannot make a key hardware (trust row 56)", () => {
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "secure_enclave", storage: "hardware" }, {}), null, "a relay-added signer with none from the device is no signer");
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "secure_enclave", storage: "hardware" }, { keyStorage: "hardware" }), null);
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "tpm", storage: "hardware" }, { keySigner: "strongbox" })?.signer, "strongbox", "the device's word beats the relay's");
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "webauthn_platform", rp: "evil.example" }, { keySigner: "webauthn_platform", keyRp: "vyre.run" })?.rp, "vyre.run", "the relying party is the device's too");
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "webauthn_platform", rp: "evil.example" }, { keySigner: "webauthn_platform" })?.rp, undefined);
});
