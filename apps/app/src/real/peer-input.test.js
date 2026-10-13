// @ts-check
// A direct call carries its presence options (the owner's proof, an approval id) as headers; the peer wire carries them in the call (proof and approval, which the server's door takes out before the tool sees them).
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { peerInput } from "./peer-input.js";

const header = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("peer input: a kernel proof or a yes header becomes the call's proof, an approval id rides beside it, the input is not changed", () => {
  const input = { id: "appr_1", approve: true };
  const proof = { op: "approve", space: "spc_aaaaaaaaaaaa", payload_hash: "h" };
  assert.deepEqual(peerInput(input, { kernelProof: header(proof) }), { id: "appr_1", approve: true, proof });
  assert.deepEqual(peerInput(input, { yes: header(proof) }), { id: "appr_1", approve: true, proof });
  assert.deepEqual(peerInput(input, { approval: "ap_9" }), { id: "appr_1", approve: true, approval: "ap_9" });
  assert.deepEqual(input, { id: "appr_1", approve: true }, "the caller's input is untouched");
});

test("peer input: no options, or a header that is not a proof, adds nothing", () => {
  assert.deepEqual(peerInput({ a: 1 }, undefined), { a: 1 });
  assert.deepEqual(peerInput({ a: 1 }, {}), { a: 1 });
  assert.deepEqual(peerInput({ a: 1 }, { kernelProof: "%%%not-base64-json" }), { a: 1 });
  assert.deepEqual(peerInput({ a: 1 }, { kernelProof: header([1, 2]) }), { a: 1 }, "a proof is an object");
});
