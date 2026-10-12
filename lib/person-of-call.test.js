// @ts-check
// personOfCall: the person of a call is the chain's person hop, or a genuine no-person caller by label class, or nobody (never the module's own service chain).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { personOfCall } from "./person-of-call.js";

const BEN = "per_" + "b".repeat(26);
const hop = (/** @type {string} */ kind, /** @type {string} */ id) => ({ actor: { kind, id } });
const ctxWith = (/** @type {any} */ chain) => ({ kernel: { chain: async () => (typeof chain === "function" ? chain() : chain) } });

test("a person hop in the chain is the person of the call, whatever the label says", async () => {
  assert.deepEqual(await personOfCall(ctxWith({ hops: [hop("person", BEN)] }), { caller: "mcp", token: "t" }), { kind: "person", id: BEN });
  assert.deepEqual(await personOfCall(ctxWith({ hops: [hop("person", BEN), hop("agent", "kit")] }), { caller: "device:abcdefghijklmnop", kernelFacts: { kind: "device" } }), { kind: "person", id: BEN });
});

test("the module's own service chain is NOT a person: a member's device, browser, visitor or guest is nobody", async () => {
  const service = ctxWith({ hops: [hop("service", "work")] });
  for (const caller of ["device:abcdefghijklmnop", "web:abcdefghijklmnop", "space:ben@spc_team", "tailnet-guest:ben@example.com", "tailnet:owner@example.com", "setup:abcdefghijklmnop", "invitee:abc", "deck", "mobile", "mcp:thread:t1", "cli:agent:kit"]) {
    assert.equal(await personOfCall(service, { caller }), null, `${caller}: no person hop, nobody`);
  }
});

test("a claim whose chain holds no person hop proved nothing: nobody, even from a label that would otherwise pass", async () => {
  assert.equal(await personOfCall(ctxWith({ hops: [hop("service", "work")] }), { caller: "cli", token: "t" }), null);
  assert.equal(await personOfCall(ctxWith({ hops: [hop("agent", "kit")] }), { caller: "mcp", kernelFacts: { kind: "socket" } }), null);
});

test("an unreadable chain is nobody, not the module's own and not everyone", async () => {
  assert.equal(await personOfCall(ctxWith(() => { throw new Error("no"); }), { caller: "device:abcdefghijklmnop", token: "t" }), null);
  assert.equal(await personOfCall(ctxWith(() => { throw new Error("no"); }), { caller: "device:abcdefghijklmnop" }), null);
});

test("a module's own work and the owner's own socket claim no person but are not strangers", async () => {
  const service = ctxWith({ hops: [hop("service", "work")] });
  assert.deepEqual(await personOfCall(service, { caller: "module:flows" }), { kind: "module" });
  assert.deepEqual(await personOfCall(service, { caller: "ext:pass" }), { kind: "module" });
  for (const caller of ["cli", "local", "capsule", "mcp", "harness"]) assert.deepEqual(await personOfCall(service, { caller }), { kind: "socket" }, caller);
});

test("no kernel handle (a home that runs none) still tells the owner's socket and modules from a remote caller", async () => {
  assert.deepEqual(await personOfCall({}, { caller: "cli" }), { kind: "socket" });
  assert.deepEqual(await personOfCall(undefined, { caller: "module:x" }), { kind: "module" });
  assert.equal(await personOfCall({}, { caller: "device:abcdefghijklmnop" }), null);
  assert.equal(await personOfCall({}, undefined), null);
});
