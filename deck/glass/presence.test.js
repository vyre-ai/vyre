// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { _test, canProve, proveAndCall } from "./presence.js";

test("presence: base64url round-trips bytes the way WebAuthn and vyred expect", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 62, 63]);
  const s = _test.b64url(bytes);
  assert.doesNotMatch(s, /[+/=]/);
  assert.equal(s, Buffer.from(bytes).toString("base64url"));
  assert.deepEqual([..._test.unb64url(s)], [...bytes]);
});

test("presence: without WebAuthn it says so instead of calling the box", async () => {
  assert.equal(canProve(), false);
  const r = await proveAndCall("glass.take", { target: "computer:kit", surface: "deck:a" });
  assert.equal(r.error.code, "no_passkey");
});
