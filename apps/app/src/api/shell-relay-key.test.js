import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { SHELL_RELAY_KEY, shellRelayBridge, shellRelayCrypto, shellRelayKeyStore } from "./shell-relay-key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The Mac shell's two calls over a Keychain stand-in (an object that outlives the page, as the Keychain item outlives a restart). */
function macShell(keychain) {
  const pubOf = k => crypto.createPublicKey(k).export({ format: "jwk" }).x;
  return {
    async public(create) {
      if (!keychain.key) { if (!create) throw new Error("There is no relay key on this Mac."); keychain.key = crypto.generateKeyPairSync("x25519").privateKey; }
      return pubOf(keychain.key);
    },
    async dh(peer) {
      const publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peer }, format: "jwk" });
      return crypto.diffieHellman({ privateKey: keychain.key, publicKey }).toString("base64url");
    },
  };
}

test("the shell's relay key calls are used only in a Mac shell that has them", () => {
  const relayKey = { public: async () => "", dh: async () => "" };
  assert.equal(shellRelayBridge({ __vyreShell: { kind: "mac", relayKey } }), relayKey);
  assert.equal(shellRelayBridge({ __vyreShell: { kind: "mac" } }), null, "an older Mac shell: the page keeps the key as a browser does");
  assert.equal(shellRelayBridge({ __vyreShell: { kind: "windows", relayKey } }), null);
  assert.equal(shellRelayBridge({}), null);
  assert.equal(shellRelayBridge(undefined), null);
});

test("the store always answers with the shell's key, the same after a restart, and the page cannot replace it", async () => {
  const keychain = {};
  const a = await shellRelayKeyStore(macShell(keychain)).get();
  assert.equal(a.privateKey, SHELL_RELAY_KEY, "only a stand-in reaches the page");
  assert.equal(a.publicKey.length, 32);
  const relaunched = await shellRelayKeyStore(macShell(keychain)).get();
  assert.deepEqual(relaunched.publicKey, a.publicKey);
  await assert.rejects(() => shellRelayKeyStore(macShell(keychain)).set(a), /keeps its own relay key/);
});

test("a DH with the shell's key goes to the shell and matches the peer's; any other key stays with WebCrypto", async () => {
  const keychain = {};
  const calls = [];
  const bridge = macShell(keychain);
  const base = { dh: async (k, p) => { calls.push(k); return new Uint8Array(32); }, sha256: async () => new Uint8Array(32) };
  const c = shellRelayCrypto({ public: bridge.public, dh: async p => { calls.push("shell"); return bridge.dh(p); } }, base);
  const mine = await shellRelayKeyStore(bridge).get();
  const peer = crypto.generateKeyPairSync("x25519");
  const peerPub = Buffer.from(peer.publicKey.export({ format: "jwk" }).x, "base64url");
  const ours = await c.dh(SHELL_RELAY_KEY, new Uint8Array(peerPub));
  const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(mine.publicKey).toString("base64url") }, format: "jwk" }) });
  assert.deepEqual(Buffer.from(ours), theirs);
  await c.dh("ephemeral", new Uint8Array(32));
  assert.deepEqual(calls, ["shell", "ephemeral"]);
  assert.equal(c.sha256, base.sha256, "everything else is WebCrypto's");
});

test("relay.web.ts takes the shell's key store and crypto when the shell has them, and IndexedDB otherwise", () => {
  const web = fs.readFileSync(path.join(HERE, "relay.web.ts"), "utf8");
  assert.match(web, /shellRelayBridge\(\)/);
  assert.match(web, /bridge \? \(shellRelayKeyStore\(bridge\)[^:]*: indexedDbKeyStore\(\)/);
  assert.match(web, /bridge \? \(shellRelayCrypto\(bridge, webCrypto\(\)\)[^:]*: webCrypto\(\)/);
});
