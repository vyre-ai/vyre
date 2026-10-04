import "../scripts/mac-test-guard.mjs";
// @ts-check
// The door gives the tools the presence proof itself, not the `{ presence }` wrapper kernel.proofFrom answers (walker's step 10: tasks.decide answered needs_presence for a correct proof).
import test from "node:test";
import assert from "node:assert/strict";
import { createDoor } from "./gateway-door.js";
import { proofFrom } from "../kernel/remote/proof.js";

const SPACE = "spc_abcdefghijkl";
const chain = { space: SPACE, hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };
const ctx = { kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: {}, surfaces: {} }), chainIn: async () => chain, proofFrom } };

test("door.open answers the proof itself, undefined when none was sent, and undefined for anything that is not a plain object", async () => {
  const door = createDoor(/** @type {any} */ (ctx)), proof = { signer: "software", key_id: "dk_1", payload_hash: "p", decision: "task.decide", chain_hash: "c", issued_at: 1, expires_at: 2, nonce: "n", signature: "s" };
  assert.deepEqual((await door.open({}, { caller: "cli", kernel_proof: proof })).proof, proof);
  assert.equal((await door.open({}, { caller: "cli" })).proof, undefined);
  assert.equal((await door.open({}, { caller: "cli", kernel_proof: "a string" })).proof, undefined);
  assert.equal((await door.open({}, { caller: "cli", kernel_proof: [proof] })).proof, undefined);
});
