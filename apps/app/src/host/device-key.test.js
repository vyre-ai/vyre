import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { makeDeviceKey, openDeviceKey } from "./device-key.js";

const idSeed = () => new Uint8Array(crypto.randomBytes(32));

test("a device key is kept only wrapped, opens with the identity seed it was made under, and signs", () => {
  const id = idSeed();
  const kept = makeDeviceKey(id);
  assert.deepEqual(Object.keys(kept.wrapped).sort(), ["ct", "iv"]);
  const open = openDeviceKey(kept, id);
  const msg = new TextEncoder().encode("a challenge");
  const sig = open.sign(msg);
  assert.equal(ed25519.verify(sig, msg, Buffer.from(kept.pub, "base64url")), true);
  open.close();
});

test("another identity seed, a changed record, or a swapped public half does not open it", () => {
  const id = idSeed();
  const kept = makeDeviceKey(id);
  assert.throws(() => openDeviceKey(kept, idSeed()), (e) => e.code === "bad_device_key");
  assert.throws(() => openDeviceKey({ ...kept, wrapped: { ...kept.wrapped, ct: Buffer.alloc(48).toString("base64url") } }, id), (e) => e.code === "bad_device_key");
  const other = makeDeviceKey(id);
  assert.throws(() => openDeviceKey({ ...kept, pub: other.pub }, id), (e) => e.code === "bad_device_key");
});

test("two device keys under one identity differ, and the stored bytes hold no seed", () => {
  const id = idSeed();
  const a = makeDeviceKey(id), b = makeDeviceKey(id);
  assert.notEqual(a.pub, b.pub);
  assert.ok(!JSON.stringify(a).includes(Buffer.from(id).toString("base64url")));
});
