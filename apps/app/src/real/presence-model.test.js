import test from "node:test";
import assert from "node:assert/strict";
import { b64url, unb64url, wantsPasskey, getOptions, passkeyHeader } from "./presence-model.js";

test("base64url round trips", () => {
  const bytes = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255, 3]);
  assert.deepEqual([...unb64url(b64url(bytes))], [...bytes]);
  assert.equal(b64url(Uint8Array.from([251, 255])), "-_8");
});

test("a refusal wants a passkey only when the box lists it", () => {
  assert.equal(wantsPasskey({ code: "presence_required", methods: ["passkey", "device"] }), true);
  assert.equal(wantsPasskey({ code: "presence_required", methods: ["device"] }), false);
  assert.equal(wantsPasskey({ code: "denied", methods: ["passkey"] }), false);
  assert.equal(wantsPasskey(undefined), false);
});

test("the box's challenge becomes get() options, or null when it offers none", () => {
  const o = getOptions({ data: { challenge: "c1", webauthn: { challenge: b64url(Uint8Array.from([1, 2, 3])), rpId: "localhost", timeout: 60000, allowCredentials: [{ id: b64url(Uint8Array.from([9, 9])) }] } } });
  assert.deepEqual([...o.challenge], [1, 2, 3]);
  assert.equal(o.rpId, "localhost");
  assert.equal(o.userVerification, "required");
  assert.deepEqual([...o.allowCredentials[0].id], [9, 9]);
  assert.equal(getOptions({ data: {} }), null);
  assert.equal(getOptions({ error: { code: "denied" } }), null);
});

test("the proof header carries the challenge id and the assertion, base64url", () => {
  const u = (...a) => Uint8Array.from(a).buffer;
  const h = passkeyHeader("chal", { rawId: u(1, 2), response: { authenticatorData: u(3), clientDataJSON: u(4), signature: u(5) } });
  assert.equal(h, `passkey id=chal cred=${b64url(u(1, 2))} ad=${b64url(u(3))} cd=${b64url(u(4))} sig=${b64url(u(5))}`);
  assert.match(h, /^passkey id=\S+ cred=\S+ ad=\S+ cd=\S+ sig=\S+$/);
});
