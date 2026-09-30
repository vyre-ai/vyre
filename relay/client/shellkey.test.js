// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { shellDeviceKey } from "./shellkey.js";
import { nodeCrypto } from "./nodecrypto.js";
import { base64url, fromBase64url } from "./bytes.js";
import { pair } from "./client.js";

/** A shell's native side, in process: the private key lives only in this closure. */
function fakeShell() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === "device_key_pub") return base64url(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    if (cmd === "device_key_dh") {
      const remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(fromBase64url(args.remote))]), format: "der", type: "spki" });
      return base64url(crypto.diffieHellman({ privateKey, publicKey: remote }));
    }
    throw new Error("no such command");
  };
  return { invoke, calls, publicKey };
}

test("shell device key: the page gets a public key and a marker, never bytes, and dh goes to the shell", async () => {
  const shell = fakeShell();
  const { crypto: c, keyStore } = shellDeviceKey(shell.invoke, { crypto: nodeCrypto() });
  const kp = await keyStore.get();
  assert.equal(kp.publicKey.length, 32);
  assert.ok(!(kp.privateKey instanceof Uint8Array) && !Buffer.isBuffer(kp.privateKey), "the private key is a marker");
  assert.equal(JSON.stringify(kp.privateKey).includes("PRIVATE"), false);
  const peer = crypto.generateKeyPairSync("x25519");
  const remote = new Uint8Array(peer.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const mine = await c.dh(kp.privateKey, remote);
  const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(kp.publicKey)]), format: "der", type: "spki" }) });
  assert.deepEqual(Buffer.from(mine), theirs, "the shell's DH is the X25519 the peer computes");
  assert.deepEqual(shell.calls, ["device_key_pub", "device_key_dh"]);
  await keyStore.set(kp);   // a no-op: nothing to keep here
  const fresh = await c.generateKeyPair();
  assert.equal((await c.dh(fresh.privateKey, remote)).length, 32, "a raw key still goes to the ordinary provider");
});

test("shell device key: a shell that answers nonsense is refused", async () => {
  const bad = shellDeviceKey(async () => "AAAA", { crypto: nodeCrypto() });
  await assert.rejects(bad.keyStore.get(), /no device key/);
  const kp = await shellDeviceKey(async cmd => (cmd === "device_key_pub" ? base64url(new Uint8Array(32).fill(7)) : "AAAA"), { crypto: nodeCrypto() });
  const k = await kp.keyStore.get();
  await assert.rejects(kp.crypto.dh(k.privateKey, new Uint8Array(32).fill(9)), /no shared secret/);
  void pair;
});
