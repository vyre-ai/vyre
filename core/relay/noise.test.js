// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { Handshake, keyPair, dh, PROTOCOL } from "./noise.js";

// The Noise_IK_25519_AESGCM_SHA256 vector from the cacophony test vectors
// (github.com/haskell-cryptography/cacophony, vectors/cacophony.txt, BSD-3-Clause).
const V = {
  prologue: "4a6f686e2047616c74",
  init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
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
const hex = s => Buffer.from(s, "hex");

test("matches the cacophony vector for " + PROTOCOL, () => {
  const initS = keyPair(hex(V.init_static)), respS = keyPair(hex(V.resp_static));
  const i = new Handshake({ initiator: true, s: initS, rs: respS.pub, prologue: hex(V.prologue), e: keyPair(hex(V.init_ephemeral)) });
  const r = new Handshake({ initiator: false, s: respS, prologue: hex(V.prologue), e: keyPair(hex(V.resp_ephemeral)) });

  const m1 = i.writeMessage(hex(V.messages[0][0]));
  assert.equal(m1.toString("hex"), V.messages[0][1]);
  assert.equal(r.readMessage(m1).toString("hex"), V.messages[0][0]);
  assert.deepEqual(r.rs, initS.pub, "the responder learns the initiator's static key");

  const m2 = r.writeMessage(hex(V.messages[1][0]));
  assert.equal(m2.toString("hex"), V.messages[1][1]);
  assert.equal(i.readMessage(m2).toString("hex"), V.messages[1][0]);
  assert.equal(i.hash?.toString("hex"), V.handshake_hash);
  assert.equal(r.hash?.toString("hex"), V.handshake_hash);

  for (let n = 2; n < V.messages.length; n++) {
    const [payload, ct] = V.messages[n];
    const [from, to] = n % 2 === 0 ? [i, r] : [r, i];
    const c = /** @type {any} */ (from.send).encrypt(Buffer.alloc(0), hex(payload));
    assert.equal(c.toString("hex"), ct, `transport message ${n}`);
    assert.equal(/** @type {any} */ (to.recv).decrypt(Buffer.alloc(0), c).toString("hex"), payload);
  }
});

function pair() {
  const box = keyPair(), dev = keyPair();
  const i = new Handshake({ initiator: true, s: dev, rs: box.pub, prologue: Buffer.from("p") });
  const r = new Handshake({ initiator: false, s: box, prologue: Buffer.from("p") });
  r.readMessage(i.writeMessage(Buffer.from("hi")));
  i.readMessage(r.writeMessage());
  return { i: /** @type {any} */ (i), r: /** @type {any} */ (r) };
}

test("a replayed frame fails and a failed frame does not advance the counter", () => {
  const { i, r } = pair();
  const a = i.send.encrypt(Buffer.alloc(0), Buffer.from("approve item A"));
  assert.equal(r.recv.decrypt(Buffer.alloc(0), a).toString(), "approve item A");
  assert.throws(() => r.recv.decrypt(Buffer.alloc(0), a), /decrypt failed/);
  const b = i.send.encrypt(Buffer.alloc(0), Buffer.from("next"));
  assert.equal(r.recv.decrypt(Buffer.alloc(0), b).toString(), "next");
});

test("a frame reflected back to its sender fails", () => {
  const { i, r } = pair();
  const fromBox = r.send.encrypt(Buffer.alloc(0), Buffer.from("event"));
  assert.throws(() => r.recv.decrypt(Buffer.alloc(0), fromBox), /decrypt failed/);
  assert.equal(i.recv.decrypt(Buffer.alloc(0), fromBox).toString(), "event");
});

test("reordered frames fail", () => {
  const { i, r } = pair();
  i.send.encrypt(Buffer.alloc(0), Buffer.from("one"));
  const two = i.send.encrypt(Buffer.alloc(0), Buffer.from("two"));
  assert.throws(() => r.recv.decrypt(Buffer.alloc(0), two), /decrypt failed/);
});

test("the wrong box key fails the handshake", () => {
  const box = keyPair(), other = keyPair(), dev = keyPair();
  const i = new Handshake({ initiator: true, s: dev, rs: other.pub });
  const r = new Handshake({ initiator: false, s: box });
  assert.throws(() => r.readMessage(i.writeMessage()), /decrypt failed/);
});

test("a different prologue (another route) fails the handshake", () => {
  const box = keyPair(), dev = keyPair();
  const i = new Handshake({ initiator: true, s: dev, rs: box.pub, prologue: Buffer.from("route-a") });
  const r = new Handshake({ initiator: false, s: box, prologue: Buffer.from("route-b") });
  assert.throws(() => r.readMessage(i.writeMessage()), /decrypt failed/);
});

test("a low-order peer key is refused", () => {
  const i = new Handshake({ initiator: true, s: keyPair(), rs: Buffer.alloc(32) });
  assert.throws(() => i.writeMessage(), /invalid peer key|public key/);
});

test("rekey on both sides keeps the channel working", () => {
  const { i, r } = pair();
  i.send.rekey(); r.recv.rekey();
  const c = i.send.encrypt(Buffer.alloc(0), Buffer.from("after rekey"));
  assert.equal(r.recv.decrypt(Buffer.alloc(0), c).toString(), "after rekey");
});

test("a static key held elsewhere: an async dh completes the handshake, and readMessage refuses it", async () => {
  const box = keyPair(), dev = keyPair();
  let asked = 0;
  const held = { pub: box.pub, dh: async remote => { asked++; await new Promise(r => setImmediate(r)); return dh(box.priv, remote); } };
  const i = new Handshake({ initiator: true, s: dev, rs: box.pub, prologue: Buffer.from("p") });
  const r = new Handshake({ initiator: false, s: held, prologue: Buffer.from("p") });
  const m1 = i.writeMessage(Buffer.from("hi"));
  assert.throws(() => new Handshake({ initiator: false, s: held, prologue: Buffer.from("p") }).readMessage(m1), /readMessageAsync/);
  asked = 0;
  assert.equal((await r.readMessageAsync(m1)).toString(), "hi");
  assert.equal(asked, 2, "the responder's two static DHs went to the holder");
  i.readMessage(r.writeMessage());
  const a = /** @type {any} */ (i).send.encrypt(Buffer.alloc(0), Buffer.from("x"));
  assert.equal(/** @type {any} */ (r).recv.decrypt(Buffer.alloc(0), a).toString(), "x");
  // and the same box with its bytes gets the same session keys
  const r2 = new Handshake({ initiator: false, s: box, prologue: Buffer.from("p") });
  const i2 = new Handshake({ initiator: true, s: dev, rs: box.pub, prologue: Buffer.from("p") });
  assert.equal((await r2.readMessageAsync(i2.writeMessage(Buffer.from("hi")))).toString(), "hi");
});
