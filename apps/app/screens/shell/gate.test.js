import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { signedOut, whoIsThere } from "./gate.js";

test("a refusal that says no person is signed in gates the shell; any other answer or failure lets it through", async () => {
  const denied = { error: { code: "denied", message: "this call is not from a signed-in person. Sign in with `vyre signin`" } };
  assert.equal(signedOut(denied.error), true);
  assert.equal(signedOut({ code: "denied", message: "an agent is named only as" }), false);
  assert.equal(signedOut({ code: "offline", message: "signed-in person" }), false);
  assert.equal(await whoIsThere(async () => denied), "out");
  assert.equal(await whoIsThere(async () => ({})), "in");
  assert.equal(await whoIsThere(async () => { throw new Error("down"); }), "in");
});
