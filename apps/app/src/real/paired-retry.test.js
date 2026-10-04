// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPairedSession, isNoSession } from "./paired-retry.js";

const noSession = () => Object.assign(new Error("server text"), { code: "needs_presence" });

test("no session: the device starts one and makes the call again once", async () => {
  let n = 0, renewed = 0;
  const out = await withPairedSession({ call: async () => { if (++n === 1) throw noSession(); return { ok: true }; }, renew: async () => { renewed++; return true; }, failure: () => null });
  assert.deepEqual(out, { ok: true }); assert.equal(n, 2); assert.equal(renewed, 1);
});

test("a refused start says why in our words and the call is not repeated", async () => {
  let n = 0;
  await assert.rejects(withPairedSession({ call: async () => { n++; throw noSession(); }, renew: async () => false, failure: () => "denied" }), (e) => e.code === "session_refused" && /could not sign in again/.test(e.message) && !/server text/.test(e.message));
  assert.equal(n, 1);
});

test("an unreachable server says it will retry", async () => {
  await assert.rejects(withPairedSession({ call: async () => { throw noSession(); }, renew: async () => false, failure: () => "unreachable" }), /Cannot reach your server/);
});

test("the retry is once: still no session after a good start asks for approval, in our words", async () => {
  let n = 0;
  await assert.rejects(withPairedSession({ call: async () => { n++; throw noSession(); }, renew: async () => true, failure: () => null, how: "phone" }), (e) => e.code === "needs_presence" && e.message === "Approve this in Vyre on your phone.");
  assert.equal(n, 2);
});

test("a refused approval proof (with a reason) and other errors pass straight through", async () => {
  const proof = Object.assign(new Error("x"), { code: "needs_presence", detail: { reason: "expired" } });
  assert.equal(isNoSession(proof), false);
  let renewed = 0;
  await assert.rejects(withPairedSession({ call: async () => { throw proof; }, renew: async () => { renewed++; return true; }, failure: () => null }), (e) => e === proof);
  await assert.rejects(withPairedSession({ call: async () => { throw Object.assign(new Error("n"), { code: "not_found" }); }, renew: async () => true, failure: () => null }), /n/);
  assert.equal(renewed, 0);
});
