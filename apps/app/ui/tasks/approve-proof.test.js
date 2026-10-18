// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadHash } from "../../src/real/payload-hash.js";
import { signTaskApproval } from "./approve-proof.js";

const SPACE = "spc_aaaaaaaaaaaa";
const request = (fields) => ({ op: "task.decide", space: SPACE, fields, payload_hash: payloadHash("task.decide", SPACE, fields) });
const signerOf = (calls) => ({ signPresence: async (req) => { calls.push(req); return { payload_hash: req.payload_hash, signature: "sig" }; } });

test("the approval is signed over exactly the fields the kernel gave", async () => {
  const fields = { task: "t1", payload_hash: "ph", decision: "approve" };
  const calls = [];
  const proof = await signTaskApproval({ task: { id: "t1", title: "Send the letter" }, readTask: async () => ({ state: "needs_check", sign: request(fields) }), signer: signerOf(calls), person: "per_a" });
  assert.equal(proof.signature, "sig");
  assert.deepEqual(calls[0].fields, fields, "what is signed is what the kernel gave");
  assert.equal(calls[0].op, "task.decide");
  assert.equal(calls[0].person, "per_a");
});

test("a request whose hash does not match its fields, a task no longer waiting, no signer and a proof for another request are all refused", async () => {
  const good = request({ task: "t1", payload_hash: "ph", decision: "approve" });
  const read = (t) => async () => t;
  const base = { task: { id: "t1" }, signer: signerOf([]), person: "per_a" };
  await assert.rejects(signTaskApproval({ ...base, readTask: read({ state: "needs_check", sign: { ...good, fields: { ...good.fields, decision: "reject" } } }) }), { code: "needs_presence" });
  await assert.rejects(signTaskApproval({ ...base, readTask: read({ state: "done" }) }), { code: "bad_state" });
  await assert.rejects(signTaskApproval({ ...base, readTask: read({ state: "needs_check", sign: good }), signer: null }), { code: "no_signer" });
  await assert.rejects(signTaskApproval({ ...base, readTask: read({ state: "needs_check", sign: good }), signer: { signPresence: async () => ({ payload_hash: "other" }) } }), { code: "needs_presence" });
});
