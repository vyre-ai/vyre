import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { qrMatrix } from "../../../../relay/client/qr.js";

// QrCode.tsx draws what qrMatrix returns; this holds the contract it relies on: a square matrix for a link, and a refusal (which draws nothing) for text it cannot take.
test("an invite link makes a square matrix", () => {
  const m = qrMatrix("https://harlow.vyre.run/join/Zm9vYmFyYmF6cXV4MTIzNDU2");
  assert.ok(m.length >= 21);
  assert.ok(m.every((r) => r.length === m.length));
});

test("text longer than the encoder takes is refused, not cut", () => {
  assert.throws(() => qrMatrix("x".repeat(201)));
  assert.throws(() => qrMatrix("café"));
});
