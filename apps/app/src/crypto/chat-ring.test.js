import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { jwkOfAgree, holdersFor, newChatRing, lendChatKey } from "./chat-ring.js";
import { b64, fingerprint, pointOf } from "../../../../lib/keywrap.js";
import { openBundle, openRing } from "../../../../lib/chat-keys.js";

const subtle = globalThis.crypto.subtle;
async function device() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", pair.publicKey);
  const pub = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  return { pub, point: b64(pointOf(pub)), holder: await fingerprint(pub), ecdh: async (epk) => new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", epk, { name: "ECDH", namedCurve: "P-256" }, false, []) }, pair.privateKey, 256)), priv: pair.privateKey };
}

test("an identity entry's agree point reads back as the device's public JWK; anything else is refused", async () => {
  const d = await device();
  assert.deepEqual(jwkOfAgree(d.point), d.pub);
  assert.equal(jwkOfAgree("AAAA"), null);
  assert.equal(jwkOfAgree("not base64 !!"), null);
});

test("the holders of a new chat are this device and every participant device with an agree point; a participant with none is named; this device must be published", async () => {
  const me = await device(), bob1 = await device(), bob2 = await device();
  const call = async (tool, input) => {
    assert.equal(tool, "spaces.identity.devices");
    if (input.person === "per_me") return { devices: [{ eid: "e0", agree: me.point }] };
    if (input.person === "per_bob") return { devices: [{ eid: "e1", agree: bob1.point }, { eid: "e2", agree: bob2.point }, { eid: "e3" }] };
    return { devices: [{ eid: "e9" }] };
  };
  const r = await holdersFor(call, ["per_me", "per_bob", "per_old"], { holder: me.holder, jwk: me.pub });
  assert.deepEqual(Object.keys(r.holders).sort(), [me.holder, bob1.holder, bob2.holder].sort());
  assert.deepEqual(r.without, ["per_old"]);
  assert.equal(r.listed, true);
  const unpublished = await holdersFor(async () => ({ devices: [{ eid: "e0" }] }), ["per_me"], { holder: me.holder, jwk: me.pub });
  assert.deepEqual([unpublished.listed, unpublished.without], [false, ["per_me"]], "this device's agree point is not on its list yet");
  const refused = await holdersFor(async () => { throw new Error("no such tool"); }, ["per_x"], { holder: me.holder, jwk: me.pub });
  assert.deepEqual([refused.without, refused.listed], [["per_x"], false], "a list that cannot be read is named, never skipped");
});

test("a ring made for a new chat opens on each holder's device and nowhere else", async () => {
  const me = await device(), bob = await device(), eve = await device();
  const { id, ring } = await newChatRing("chat_x1", { [me.holder]: me.pub, [bob.holder]: bob.pub });
  assert.equal(id, "chat_x1");
  assert.equal((await openRing(ring, bob.holder, bob.ecdh)).epoch, 1);
  await assert.rejects(() => openRing(ring, eve.holder, eve.ecdh), (e) => e.code === "denied");
  assert.ok(!JSON.stringify(ring).includes(Buffer.from("secret").toString("base64")), "the ring holds only wraps and a sealed name key");
});

test("lending: begin, open the ring with this device's key, answer with a bundle only the session key opens", async () => {
  const me = await device();
  const { ring } = await newChatRing("chat_x2", { [me.holder]: me.pub });
  const sess = await device();
  const calls = [];
  let bundle = null;
  const call = async (tool, input) => {
    calls.push(tool);
    if (tool === "work.chat.keys.begin") return { request: "req_1", session_pub: sess.pub, epoch: 1 };
    if (tool === "work.chat.get") return { ring };
    if (tool === "work.chat.keys.finish") { bundle = input.bundle; assert.equal(input.request, "req_1"); return { ok: true }; }
    throw new Error(`unexpected ${tool}`);
  };
  assert.deepEqual(await lendChatKey(call, "chat_x2", { holder: me.holder, ecdh: me.ecdh }), { epoch: 1 });
  assert.deepEqual(calls, ["work.chat.keys.begin", "work.chat.get", "work.chat.keys.finish"]);
  const server = await openBundle(bundle, "chat_x2", sess.ecdh);
  assert.equal(server.id, "chat_x2");
  assert.equal(server.keys.size, 1);
  await assert.rejects(() => openBundle(bundle, "chat_x2", me.ecdh), (e) => e.code === "cannot_open", "only the session key opens it");
  await assert.rejects(() => lendChatKey(async (t) => (t === "work.chat.get" ? {} : { request: "r", session_pub: sess.pub }), "chat_x3", { holder: me.holder, ecdh: me.ecdh }), (e) => e.code === "no_ring");
});
