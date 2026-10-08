import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64u } from "../../../../kernel/identity/chain.js";
import { macDeviceKey, macEnclavePublic, macEnclaveSign, macKeyAvailable, macSignListChange, shellKeyHeld, MAC_KEPT } from "./mac-key.ts";

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

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** A stand-in for Host/MacEnclave.swift: a P-256 key, raw r||s signatures (as CryptoKit's rawRepresentation gives, any s), and a Touch ID answer. */
function withEnclave(f, { yes = true, hardware = true } = {}) {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pair.publicKey.export({ format: "jwk" }).x, "base64url"), Buffer.from(pair.publicKey.export({ format: "jwk" }).y, "base64url")]);
  const prompts = [];
  if (hardware) {
    f.identity.enclavePublic = async () => b64u(point);
    f.identity.enclaveSign = async (m, prompt) => {
      prompts.push(prompt);
      if (!yes) throw new Error("Not approved. Nothing was changed.");
      // keep whichever s the signer produced, high or low: the page must make it low
      const sig = nodeSign("sha256", Buffer.from(m.replace(/-/g, "+").replace(/_/g, "/"), "base64"), { key: pair.privateKey, dsaEncoding: "ieee-p1363" });
      const r = sig.subarray(0, 32), s = BigInt("0x" + sig.subarray(32).toString("hex"));
      const high = N - s; // force a high s, as half of real signatures are
      return b64u(Buffer.concat([r, Buffer.from(high.toString(16).padStart(64, "0"), "hex")]));
    };
  }
  return { point, prompts, pair };
}

test("the enclave point is the shell's 65-byte uncompressed key, and a Mac with no enclave has none", async (t) => {
  const f = fakeShell(); installShell(f); t.after(removeShell);
  assert.equal(await macEnclavePublic(true), null, "no enclave in the shell: the entry signs alone");
  const e = withEnclave(f);
  const pt = await macEnclavePublic(true);
  assert.equal(Buffer.from(pt.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64").length, 65);
  assert.deepEqual(Buffer.from(pt.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64"), e.point);
});

test("an enclave signature comes back raw 64 bytes with s in the low half, and verifies under the point", async (t) => {
  const f = fakeShell(); installShell(f); t.after(removeShell);
  const e = withEnclave(f);
  const msg = new TextEncoder().encode("add a device to alex.vyre.run");
  const sig = await macEnclaveSign(msg, "Approve this change to your name");
  assert.equal(sig.length, 64);
  assert.ok(BigInt("0x" + Buffer.from(sig.subarray(32)).toString("hex")) <= N / 2n, "low s");
  assert.ok(verify("sha256", msg, { key: e.pair.publicKey, dsaEncoding: "ieee-p1363" }, sig));
  assert.deepEqual(e.prompts, ["Approve this change to your name"]);
});

test("a list change from a Mac with an enclave key carries both signatures; without one it signs alone; a no from Touch ID rejects", async (t) => {
  const f = fakeShell(); installShell(f); t.after(removeShell);
  await macDeviceKey(true);
  const msg = new TextEncoder().encode("a list change");
  assert.deepEqual(Object.keys(await macSignListChange(msg, "Approve")), ["sig"], "no enclave key: the Ed25519 key alone");
  const e = withEnclave(f);
  const both = await macSignListChange(msg, "Approve");
  assert.equal(both.sig.length, 64); assert.equal(both.esig.length, 64);
  assert.ok(verify("sha256", msg, { key: e.pair.publicKey, dsaEncoding: "ieee-p1363" }, both.esig));
  const g = fakeShell(); installShell(g); await macDeviceKey(true); withEnclave(g, { yes: false });
  await assert.rejects(macSignListChange(msg, "Approve"), /Not approved/);
});

test("a key a page's script can reach is held as a web key: no enclave key, or any Windows key until the Hello prompt is shown", async (t) => {
  delete globalThis.window; t.after(() => delete globalThis.window);
  assert.equal(await shellKeyHeld(), false, "no shell: nothing to hold");
  const mac = fakeShell(); installShell(mac);
  assert.equal(await shellKeyHeld(), true, "a Mac with no enclave key");
  withEnclave(mac);
  assert.equal(await shellKeyHeld(), false, "a Mac whose Secure Enclave asks the person for each list change");
  const win = fakeShell(); withEnclave(win);
  globalThis.window = { __vyreShell: { kind: "windows", ...win } };
  assert.equal(await shellKeyHeld(), true, "Windows, even with a TPM key, until a Hello prompt per signature is shown");
});
