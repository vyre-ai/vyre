import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64u } from "../../../../kernel/identity/chain.js";
import { macDeviceKey, macKeyAvailable, MAC_KEPT } from "./mac-key.ts";

/** A stand-in for Host/MacIdentity.swift: the seed lives here, in the shell, and only the public key and signatures cross. */
function fakeShell() {
  const seed = ed25519.utils.randomPrivateKey();
  let made = false;
  const calls = [];
  const identity = {
    public: async (create) => { calls.push(["public", !!create]); if (!made && !create) throw new Error("There is no key on this Mac."); made = true; return b64u(ed25519.getPublicKey(seed)); },
    sign: async (m) => { calls.push(["sign"]); return b64u(ed25519.sign(Buffer.from(m.replace(/-/g, "+").replace(/_/g, "/"), "base64"), seed)); },
    has: async () => made, forget: async () => { made = false; },
  };
  return { identity, calls, seedBytes: seed };
}
const installShell = (shell) => { globalThis.window = { __vyreShell: { kind: "mac", ...shell } }; };
const removeShell = () => { delete globalThis.window; };

test("without the Mac shell there is no Mac key", async () => {
  removeShell();
  assert.equal(macKeyAvailable(), false);
  assert.equal(await macDeviceKey(true), null);
});

test("the Mac key is the shell's: its public key, an eid from it, signatures that verify, and a record that keeps nothing secret", async (t) => {
  const f = fakeShell(); installShell(f); t.after(removeShell);
  assert.equal(macKeyAvailable(), true);
  assert.equal(await macDeviceKey(false), null, "no key until one is made");
  const k = await macDeviceKey(true);
  assert.ok(k && k.software === false && k.publicKey.length === 43);
  const msg = new TextEncoder().encode("a chain operation");
  const sig = await k.sign(msg);
  assert.equal(sig.length, 64);
  assert.ok(ed25519.verify(sig, msg, Buffer.from(k.publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64")));
  assert.deepEqual(k.keep(), MAC_KEPT);
  assert.ok(!JSON.stringify(k.keep()).includes(Buffer.from(f.seedBytes).toString("base64")), "the seed is not in what is kept");
  assert.equal(JSON.stringify([...f.calls]).includes(Buffer.from(f.seedBytes).toString("hex")), false);
});

test("a second call returns the same key, so a restart finds the identity again", async (t) => {
  const f = fakeShell(); installShell(f); t.after(removeShell);
  const a = await macDeviceKey(true), b = await macDeviceKey(false);
  assert.equal(a.eid, b.eid);
  assert.equal(a.publicKey, b.publicKey);
});
