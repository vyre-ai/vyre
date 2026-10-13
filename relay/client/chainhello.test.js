// @ts-check
// The chain hello a device sends in its first hello (relay/client/chainhello.js): signed by the device's chain key over the same bytes the server checks (core/relay/chain-admit.js chainHelloMessage).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chainHello } from "./chainhello.js";
import { chainHelloMessage, createChainAdmit } from "../../core/relay/chain-admit.js";
import { deviceId } from "../../core/relay/index.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const chainPub = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
const IDENT = "per_" + "a".repeat(26), EID = "d".repeat(26), BOX = "B".repeat(43);
const sha256 = async (/** @type {Uint8Array} */ b) => new Uint8Array(crypto.createHash("sha256").update(b).digest());

test("the channel id is the server's device id of the key, and the hello verifies at the server", async () => {
  const devicePub = crypto.randomBytes(32);
  const h = await chainHello({ sha256, devicePub, box: BOX, identity: IDENT, entry: EID, now: 1_700_000_000_000, sign: async (m) => crypto.sign(null, m, privateKey), name: "alexs-laptop" });
  assert.equal(h.channel, deviceId(devicePub), "the same id the relay derives from the handshake key");
  assert.equal(h.name, "alexs-laptop");
  const admit = createChainAdmit({
    boxId: async () => BOX, now: () => 1_700_000_000_000, roleOf: async () => "owner",
    fetchState: async () => ({ id: IDENT, seq: 1, head: "h", entries: [{ eid: EID, kind: "device", pub: chainPub, since: 0, founder: true }] }),
  });
  const r = await admit.check(h, h.channel);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("a hello for another server's box does not verify here", async () => {
  const devicePub = crypto.randomBytes(32);
  const h = await chainHello({ sha256, devicePub, box: "OTHER".repeat(9), identity: IDENT, entry: EID, now: 1_700_000_000_000, sign: async (m) => crypto.sign(null, m, privateKey) });
  const admit = createChainAdmit({ boxId: async () => BOX, now: () => 1_700_000_000_000, roleOf: async () => "owner", fetchState: async () => ({ id: IDENT, seq: 1, head: "h", entries: [{ eid: EID, kind: "device", pub: chainPub, since: 0, founder: true }] }) });
  assert.equal((await admit.check(h, h.channel)).why, "bad_proof");
});

test("two hellos never share a nonce", async () => {
  const a = await chainHello({ sha256, devicePub: crypto.randomBytes(32), box: BOX, identity: IDENT, entry: EID, now: 1, sign: async (m) => crypto.sign(null, m, privateKey) });
  const b = await chainHello({ sha256, devicePub: crypto.randomBytes(32), box: BOX, identity: IDENT, entry: EID, now: 1, sign: async (m) => crypto.sign(null, m, privateKey) });
  assert.notEqual(a.nonce, b.nonce);
});

test("the presence key offered in the hello is bound by its hash, and the server's check agrees", async () => {
  const devicePub = crypto.randomBytes(32);
  const presencePublicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-example-key";
  const h = await chainHello({ sha256, devicePub, box: BOX, identity: IDENT, entry: EID, now: 1_700_000_000_000, sign: async (m) => crypto.sign(null, m, privateKey), presencePublicKey });
  assert.equal(h.pk, crypto.createHash("sha256").update(presencePublicKey).digest("hex"));
  const admit = createChainAdmit({ boxId: async () => BOX, now: () => 1_700_000_000_000, roleOf: async () => "owner", fetchState: async () => ({ id: IDENT, seq: 1, head: "h", entries: [{ eid: EID, kind: "device", pub: chainPub, since: 0, founder: true }] }) });
  const r = await admit.check(h, h.channel);
  assert.deepEqual([r.ok, r.pk], [true, h.pk]);
});
