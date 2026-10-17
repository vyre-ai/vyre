import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BROWSER_TOO_OLD, ed25519Works, installEd25519Fallback } from "./webcrypto-web.js";
import * as C from "../../../../kernel/identity/chain.js";

/** A browser's WebCrypto with no Ed25519: importKey and verify refuse it the way Chrome 130 does, everything else works. */
function oldBrowser() {
  const real = crypto.webcrypto.subtle;
  const refuse = () => Object.assign(new Error("Algorithm: Unrecognized name"), { name: "NotSupportedError" });
  const subtle = {
    calls: /** @type {string[]} */ ([]),
    digest: (...a) => real.digest(...a),
    importKey: async (format, data, algo, ...rest) => { subtle.calls.push(`import ${algo.name || algo}`); if (String(algo.name || algo).toUpperCase() === "ED25519") throw refuse(); return real.importKey(format, data, algo, ...rest); },
    verify: async (algo, key, sig, msg) => { subtle.calls.push(`verify ${algo.name || algo}`); if (String(algo.name || algo).toUpperCase() === "ED25519") throw refuse(); return real.verify(algo, key, sig, msg); },
  };
  return { crypto: { subtle } };
}
const sign = (/** @type {Buffer} */ msg) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32), sig: crypto.sign(null, msg, privateKey) };
};

test("a browser with no Ed25519 cannot verify, and says so before the fallback", async () => {
  assert.equal(await ed25519Works(oldBrowser()), false);
});

test("with the fallback a good signature verifies, a tampered one does not, and the self-check passes", async () => {
  const g = oldBrowser();
  assert.equal(installEd25519Fallback(g), true);
  assert.equal(installEd25519Fallback(g), true, "twice changes nothing");
  assert.equal(await ed25519Works(g), true);
  const msg = Buffer.from("the first device signs its own genesis");
  const { pub, sig } = sign(msg);
  const key = await g.crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg), true);
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("another message")), false);
  const flipped = Buffer.from(sig); flipped[0] ^= 1;
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, flipped, msg), false);
});

test("a browser that has Ed25519 keeps using its own, and other algorithms are never touched", async () => {
  const real = crypto.webcrypto.subtle;
  const used = /** @type {string[]} */ ([]);
  // a delegating copy, so the real Node subtle is never changed by this test
  const g = { crypto: { subtle: { digest: (...a) => real.digest(...a), importKey: (...a) => { used.push("import"); return real.importKey(...a); }, verify: (...a) => { used.push("verify"); return real.verify(...a); } } } };
  installEd25519Fallback(g);
  assert.equal(await ed25519Works(g), true);
  assert.deepEqual([...new Set(used)].sort(), ["import", "verify"], "the browser's own importKey and verify answered");
  assert.equal((await g.crypto.subtle.digest("SHA-256", new Uint8Array([1]))).byteLength, 32);
});

test("the identity chain verifies a real genesis on a browser with no Ed25519 once the fallback is in", async () => {
  const globalSubtle = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const old = oldBrowser();
  Object.defineProperty(globalThis, "crypto", { value: { ...crypto.webcrypto, subtle: old.crypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) }, configurable: true });
  try {
    const { generateDeviceKey } = await import("./keys.js");
    const key = await generateDeviceKey({ forceSoftware: true });
    const make = () => C.makeGenesis({ kind: "person", entry: { eid: key.eid, kind: "device", pub: key.publicKey }, code: { eid: key.eid, kind: "code", pub: key.publicKey }, nonce: "n", ts: Date.now(), sign: (m) => key.sign(m) });
    await assert.rejects(() => make().then((g) => C.verifyChain([g], { now: Date.now() + 1 })), /first device signs its own genesis/, "before the fallback: the old, unhelpful failure");
    installEd25519Fallback(globalThis);
    const state = await C.verifyChain([await make()], { now: Date.now() + 1 });
    assert.match(state.id, /^per_/);
  } finally { if (globalSubtle) Object.defineProperty(globalThis, "crypto", globalSubtle); }
});

test("the words for a browser that cannot be helped", () => {
  assert.equal(BROWSER_TOO_OLD, "This browser is too old for Vyre. Update it, or use the Vyre app.");
});
