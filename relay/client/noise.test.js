// @ts-check
// The client's Noise against the cacophony vector (the one core/relay/noise.test.js checks), through
// WebCrypto and through the @noble-shaped factory fed by node:crypto, and its rekey against the box's.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { Initiator, CipherState, PROTOCOL, nonceOf } from "./noise.js";
import { webCrypto, createDeviceKey, memoryKeyStore } from "./webcrypto.js";
import { nobleCrypto } from "./noble.js";
import { hex, fromHex, EMPTY } from "./bytes.js";
import { CipherState as BoxCipherState } from "../../core/relay/noise.js";
import { nodeNoble } from "./testing.js";

const V = {
  prologue: "4a6f686e2047616c74",
  init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  handshake_hash: "669c8640d9e42a3cda2f232f78597ceefb01daa6e3df81181ccce6fc6b5026bf",
  messages: [
    ["4c756477696720766f6e204d69736573", "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444e417bc55c7a8166c993356c1be41ef67818a292426f301556c7f26b21d25ddb097153891a9a956cff47b83e63ad8d701c1342c209cff1ca5ecd43402762ac249e3bd3a4c0a145fe07cb5dae28ea13a3"],
    ["4d757272617920526f746862617264", "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843af2ccf9972e22afc67aeafcd25162f7f98c363b7762e3e4cb7d272e39f27a5"],
    ["462e20412e20486179656b", "66acfc92e3197de166809e6d4d5d003dcc819a84bc3522ca53c9d9"],
    ["4361726c204d656e676572", "71f89aa6533a6de70b0826864dd75f60806ee40170c16290189eb3"],
    ["4a65616e2d426170746973746520536179", "4795a3423550c8bf00386bd496a3e2c76c10669d2a75ab8f79b5094c5412a25705"],
    ["457567656e2042f6686d20766f6e2042617765726b", "aa0bb39097555c918e40be82abc2b909eb79d9eb87adb07e268fc37323a6cf904fd01fb391"],
  ],
};


async function vector(c) {
  const s = await c.importKeyPair(fromHex(V.init_static));
  const e = await c.importKeyPair(fromHex(V.init_ephemeral));
  const rs = (await c.importKeyPair(fromHex(V.resp_static))).publicKey;
  const i = new Initiator(c, { s, rs, prologue: fromHex(V.prologue), e });
  const m1 = await i.writeMessage(fromHex(V.messages[0][0]));
  assert.equal(hex(m1), V.messages[0][1], "message 1");
  assert.equal(hex(await i.readMessage(fromHex(V.messages[1][1]))), V.messages[1][0], "message 2 payload");
  assert.equal(hex(/** @type {Uint8Array} */ (i.hash)), V.handshake_hash);
  for (let n = 2; n < V.messages.length; n++) {
    const [payload, ct] = V.messages[n];
    if (n % 2 === 0) assert.equal(hex(await /** @type {any} */ (i.send).encrypt(EMPTY, fromHex(payload))), ct, `transport message ${n}`);
    else assert.equal(hex(await /** @type {any} */ (i.recv).decrypt(EMPTY, fromHex(ct))), payload, `transport message ${n}`);
  }
}

test(`client noise: the cacophony vector for ${PROTOCOL}, byte for byte, through WebCrypto`, () => vector(webCrypto()));

test("client noise: the same vector through the @noble factory", () => vector(nobleCrypto(nodeNoble())));

test("client noise: a device key's private half cannot be read out, and survives the key store", async () => {
  const k = await createDeviceKey();
  assert.equal(k.publicKey.length, 32);
  assert.equal(k.privateKey.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey("pkcs8", k.privateKey));
  const store = memoryKeyStore();
  await store.set(k);
  assert.equal((await store.get())?.privateKey, k.privateKey);
});

test("client noise: a low-order peer key is refused", async () => {
  for (const c of [webCrypto(), nobleCrypto(nodeNoble())]) {
    const i = new Initiator(c, { s: await c.generateKeyPair(), rs: new Uint8Array(32) });
    await assert.rejects(i.writeMessage(), /invalid peer key/);
  }
});

test("client noise: rekey gives the box's next key, and nonces encode as on the box", async () => {
  const raw = nodeCrypto.randomBytes(32);
  const mine = new CipherState(nobleCrypto(nodeNoble()), new Uint8Array(raw));
  const box = new BoxCipherState(Buffer.from(raw));
  for (let r = 0; r < 3; r++) { await mine.rekey(); box.rekey(); }
  assert.equal(hex(mine.k), /** @type {Buffer} */ (box.k).toString("hex"));
  // and through WebCrypto's non-extractable handle, by what it encrypts
  const w = await CipherState.of(webCrypto(), new Uint8Array(raw));
  const b2 = new BoxCipherState(Buffer.from(raw));
  await w.rekey(); b2.rekey();
  w.n = b2.n = 2 ** 32 - 1;
  assert.equal(hex(await w.encrypt(EMPTY, new Uint8Array([1, 2, 3]))), b2.encrypt(Buffer.alloc(0), Buffer.from([1, 2, 3])).toString("hex"));
  assert.equal(hex(nonceOf(2 ** 32 + 5)), "000000000000000100000005");
});
