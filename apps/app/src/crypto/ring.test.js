import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as W from "./ring.js";
import * as N from "../../../../lib/keywrap.js";
import * as NK from "../../../../lib/chat-keys.js";

const hex = (b) => Buffer.from(b).toString("hex");
const device = () => { const k = N.newDeviceKey(); return { pub: k.publicJwk, priv: k.privateJwk, ecdh: W.ecdhFrom(k.privateJwk) }; };

test("a box sealed here opens in the node reference and the other way round, bound to its aad", async () => {
  const key = W.newKey();
  const box = await W.seal("hello", key, "aad-1");
  assert.equal(N.open(box, Buffer.from(key), "aad-1").toString(), "hello");
  assert.equal((await W.open(N.seal("from node", Buffer.from(key), "aad-2"), key, "aad-2")).length, 9);
  await assert.rejects(() => W.open(box, key, "aad-other"), (e) => e.code === "cannot_open");
});

test("a key wrapped to a device here unwraps in the node reference, and one wrapped there unwraps here", async () => {
  const d = device(), key = W.newKey();
  const w = await W.wrapForDevice(key, d.pub, "ring:c1:1");
  assert.equal(hex(N.unwrapWithDevice(w, d.priv, "ring:c1:1")), hex(key));
  const w2 = N.wrapForDevice(Buffer.from(key), d.pub, "ring:c1:1");
  assert.equal(hex(await W.unwrapWithDevice(w2, d.ecdh, "ring:c1:1")), hex(key));
  await assert.rejects(() => W.unwrapWithDevice(w, d.ecdh, "ring:c1:2"), (e) => e.code === "cannot_open");
  const other = device();
  await assert.rejects(() => W.unwrapWithDevice(w, other.ecdh, "ring:c1:1"), (e) => e.code === "cannot_open");
});

test("the fingerprint is the reference's, so a holder is named the same on both sides", async () => {
  const d = device();
  assert.equal(await W.fingerprint(d.pub), N.fingerprint(d.pub));
});

test("a ring made here opens in the node reference by each holder, and a node ring opens here", async () => {
  const a = device(), b = device();
  const holders = { [await W.fingerprint(a.pub)]: a.pub, [await W.fingerprint(b.pub)]: b.pub };
  const { doc, keys } = await W.createRing("chat_1", holders);
  const viaNode = N.openRing(doc, await W.fingerprint(b.pub), b.priv);
  assert.equal(hex(viaNode.at(1)), hex(keys.at(1)));
  assert.equal(hex(viaNode.nameKey), hex(keys.nameKey));
  const ref = N.createRing("chat_2", { [N.fingerprint(a.pub)]: a.pub });
  const mine = await W.openRing(ref.doc, N.fingerprint(a.pub), a.ecdh);
  assert.equal(hex(mine.at(1)), hex(ref.keys.at(1)));
  await assert.rejects(() => W.openRing(doc, "unknown-holder", a.ecdh), (e) => e.code === "denied");
});

test("adding a person with history reads every epoch; adding without history, and removing, rotate so the new or removed holder reads only what it should", async () => {
  const a = device(), b = device(), c = device();
  const fa = await W.fingerprint(a.pub), fb = await W.fingerprint(b.pub), fc = await W.fingerprint(c.pub);
  let { doc, keys } = await W.createRing("chat_3", { [fa]: a.pub });
  doc = await W.addHolders(doc, keys, { add: { [fb]: b.pub } });
  const kb = await W.openRing(doc, fb, b.ecdh);
  assert.equal(hex(kb.at(1)), hex(keys.at(1)), "history on: the new holder reads epoch 1");
  // remove b: a new epoch, b keeps nothing new
  doc = await W.removeHolders(doc, keys, { keep: { [fa]: a.pub }, drop: [fb] });
  assert.equal(doc.epoch, 2);
  await assert.rejects(() => W.openRing(doc, fb, b.ecdh), (e) => e.code === "denied", "the removed holder holds no wrap at all");
  const ka = await W.openRing(doc, fa, a.ecdh);
  assert.equal(ka.keys.size, 2);
  // add c without history: rotates; c reads the new epoch only
  doc = await W.addHolders(doc, keys, { add: { [fc]: c.pub }, all: { [fa]: a.pub }, history: false });
  assert.equal(doc.epoch, 3);
  const kc = await W.openRing(doc, fc, c.ecdh);
  assert.deepEqual([...kc.keys.keys()], [3]);
  // the node reference agrees on the same document
  assert.equal(hex(N.openRing(doc, fc, c.priv).at(3)), hex(kc.at(3)));
});

test("lending the key: a bundle wrapped to the server's session key opens in the node reference with every epoch and the name key", async () => {
  const a = device();
  const { keys } = await W.createRing("chat_4", { [await W.fingerprint(a.pub)]: a.pub });
  const session = N.newDeviceKey();
  const bundle = await W.bundleFor(keys, session.publicJwk);
  const opened = NK.openBundle(bundle, "chat_4", session.privateJwk);
  assert.equal(hex(opened.at(1)), hex(keys.at(1)));
  assert.equal(hex(opened.nameKey), hex(keys.nameKey));
  // and the reference's own bundle opens here
  const back = await W.openBundle(NK.bundleFor(opened, session.publicJwk), "chat_4", W.ecdhFrom(session.privateJwk));
  assert.equal(hex(back.at(1)), hex(keys.at(1)));
});

test("a Keys object is never serialised", async () => {
  const a = device();
  const { keys } = await W.createRing("chat_5", { x: a.pub });
  assert.throws(() => JSON.stringify(keys), (e) => e.code === "denied");
  keys.lock();
  assert.equal(keys.keys.size, 0);
});

import fs from "node:fs";
test("memory's fixed vector (lib/vectors/keywrap.json): the shared secret, the unwrapped key and the holder name match byte for byte", async () => {
  const v = JSON.parse(fs.readFileSync(new URL("./keywrap-vector.json", import.meta.url), "utf8"));
  const ecdh = W.ecdhFrom(v.agree_private_jwk);
  assert.equal(W.b64(await ecdh(W.unb64(v.wrap.epk))), v.shared);
  assert.equal(W.b64(await W.unwrapWithDevice(v.wrap, ecdh, v.aad)), v.plaintext_key);
  assert.equal(await W.fingerprint(v.agree_public_jwk), v.holder);
});
