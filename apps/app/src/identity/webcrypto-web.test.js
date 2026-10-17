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
    const make = () => C.makeGenesis({ kind: "person", entry: { eid: key.eid, kind: "device", pub: key.publicKey }, code: { eid: key.eid, kind: "code", pub: key.publicKey }, nonce: "nnnnnnnnnnnn", ts: Date.now(), sign: (m) => key.sign(m) });
    await assert.rejects(() => make().then((g) => C.verifyChain([g], { now: Date.now() + 1 })), /first device signs its own genesis/, "before the fallback: the old, unhelpful failure");
    installEd25519Fallback(globalThis);
    const state = await C.verifyChain([await make()], { now: Date.now() + 1 });
    assert.match(state.id, /^per_/);
  } finally { if (globalSubtle) Object.defineProperty(globalThis, "crypto", globalSubtle); }
});

test("a browser that has Ed25519 and throws an unrelated SyntaxError is not answered by the fallback", async () => {
  const real = crypto.webcrypto.subtle;
  const g = { crypto: { subtle: { importKey: async () => { throw Object.assign(new Error("Invalid key data"), { name: "SyntaxError" }); }, verify: (...a) => real.verify(...a), digest: (...a) => real.digest(...a) } } };
  installEd25519Fallback(g);
  await assert.rejects(() => g.crypto.subtle.importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, ["verify"]), (e) => e.name === "SyntaxError" && e.message === "Invalid key data");
  // and the words older browsers use for "no such algorithm" are still the fallback's
  const old = { crypto: { subtle: { importKey: async () => { throw Object.assign(new Error("Unrecognized name."), { name: "SyntaxError" }); }, verify: async () => { throw new Error("no"); }, digest: (...a) => real.digest(...a) } } };
  installEd25519Fallback(old);
  assert.equal(await ed25519Works(old), true);
});

test("a fallback key used with another algorithm is refused, not verified by noble", async () => {
  const g = oldBrowser();
  installEd25519Fallback(g);
  const { pub, sig } = sign(Buffer.from("m"));
  const key = await g.crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  await assert.rejects(() => g.crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, Buffer.from("m")), (e) => e.name === "InvalidAccessError");
});

test("the words for a browser that cannot be helped", () => {
  assert.equal(BROWSER_TOO_OLD, "This browser is too old for Vyre. Update it, or use the Vyre app.");
});

test("a browser that imports an Ed25519 key but refuses to verify with it is answered by the fallback, and says nothing wrong about a tampered one", async () => {
  const real = crypto.webcrypto.subtle;
  const refuse = () => Object.assign(new Error("Algorithm: Unrecognized name"), { name: "NotSupportedError" });
  const g = { crypto: { subtle: {
    importKey: async (f, data, algo, ...r) => (String(algo.name || algo).toUpperCase() === "ED25519" ? { opaque: true } : real.importKey(f, data, algo, ...r)),
    verify: async (algo, ...r) => { if (String(algo.name || algo).toUpperCase() === "ED25519") throw refuse(); return real.verify(algo, ...r); },
    digest: (...a) => real.digest(...a),
  } } };
  assert.equal(await ed25519Works(g), false, "before the fallback");
  installEd25519Fallback(g);
  assert.equal(await ed25519Works(g), true, "the fallback answers the refused verify");
  const { pub, sig } = sign(Buffer.from("hello"));
  const key = await g.crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("hello")), true);
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("hellO")), false);
});

test("the key bytes kept for a refused verify are a copy: the caller overwriting its buffer, as an ArrayBuffer or a typed array, changes nothing", async () => {
  const real = crypto.webcrypto.subtle;
  const refuse = () => Object.assign(new Error("Algorithm: Unrecognized name"), { name: "NotSupportedError" });
  const g = { crypto: { subtle: {
    importKey: async (f, data, algo, ...r) => (String(algo.name || algo).toUpperCase() === "ED25519" ? { opaque: true } : real.importKey(f, data, algo, ...r)),
    verify: async (algo, ...r) => { if (String(algo.name || algo).toUpperCase() === "ED25519") throw refuse(); return real.verify(algo, ...r); },
    digest: (...a) => real.digest(...a),
  } } };
  installEd25519Fallback(g);
  const { pub, sig } = sign(Buffer.from("copy me"));
  for (const make of [() => { const ab = new ArrayBuffer(32); new Uint8Array(ab).set(pub); return { ab, bytes: ab, wipe: () => new Uint8Array(ab).fill(0) }; }, () => { const u = new Uint8Array(40); u.set(pub, 4); const view = u.subarray(4, 36); return { ab: view, bytes: view, wipe: () => u.fill(0) }; }]) {
    const m = make();
    const key = await g.crypto.subtle.importKey("raw", m.bytes, { name: "Ed25519" }, false, ["verify"]);
    m.wipe();
    assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("copy me")), true, "the good signature still verifies after the caller's buffer was overwritten");
    assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("copy mE")), false, "a tampered message still does not");
  }
});

test("a browser whose own Ed25519 answers false for a good signature is sent to the fallback, which answers right both ways", async () => {
  const real = crypto.webcrypto.subtle;
  const g = { crypto: { subtle: {
    importKey: async (f, data, algo, ...r) => (String(algo.name || algo).toUpperCase() === "ED25519" ? { opaque: true } : real.importKey(f, data, algo, ...r)),
    verify: async (algo, ...r) => (String(algo.name || algo).toUpperCase() === "ED25519" ? false : real.verify(algo, ...r)),
    digest: (...a) => real.digest(...a),
  } } };
  assert.equal(await ed25519Works(g), false, "before the fallback: the browser's own answers false for the known good signature");
  installEd25519Fallback(g);
  assert.equal(await ed25519Works(g), true, "after: the self-test finds the browser's answers wrong and the fallback answers");
  const { pub, sig } = sign(Buffer.from("trust the vector"));
  const key = await g.crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("trust the vector")), true);
  assert.equal(await g.crypto.subtle.verify({ name: "Ed25519" }, key, sig, Buffer.from("trust the vectoR")), false);
});
