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
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "secure_enclave", storage: "unknown" }, {})?.signer, "secure_enclave");
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, signer: "webauthn_platform", rp: "vyre.run" }, {})?.rp, "vyre.run");
});

test("a key with no stated storage and no hardware signer is not enrolled, and neither is a key of another algorithm or none", () => {
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7, storage: "unknown" }, {}), null);
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -7 }, { keyStorage: "unknown" }), null);
  assert.equal(presenceKeyFor("dev_a", { key: key(), alg: -8, signer: "tpm" }, {}), null);
  assert.equal(presenceKeyFor("dev_a", null, {}), null);
});
