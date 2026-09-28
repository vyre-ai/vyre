// @ts-check
// The move engine's three seams (ADR 0042): a fake ctx.call stands in for the relay module, since
// these functions are pure wiring — what they ask relay.devices.node/relay.status and what they
// do with the answer — not the relay module's own logic, already tested in test/relay.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { ownedNode, openPeer, selfIdentity } from "./peers.js";

/** @param {Record<string, (input: any) => any>} handlers */
function fakeCtx(handlers, config = { name: "alex" }) {
  const calls = [];
  return {
    calls,
    config,
    call: async (tool, input, caller) => {
      calls.push({ tool, input, caller });
      const h = handlers[tool];
      if (!h) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      return { data: h(input) };
    },
  };
}

test("peers: ownedNode answers a paired device's Noise identity, and null for anything else", async () => {
  const ctx = fakeCtx({ "relay.devices.node": ({ id }) => id === "abc123" ? { stableId: "abc123", staticKey: "pubkeybase64url", node: null } : { stableId: null, staticKey: null, node: null } });
  assert.deepEqual(await ownedNode(ctx)("abc123"), { stableId: "abc123", staticKey: "pubkeybase64url" });
  assert.equal(await ownedNode(ctx)("someone-elses-node"), null);
  assert.equal(ctx.calls[0].caller, "module:link", "calls relay.devices.node as a module, never a person or device");
});

test("peers: openPeer refuses not_reachable for a device with no reported tailnet node", async () => {
  const ctx = fakeCtx({ "relay.devices.node": () => ({ stableId: "abc123", staticKey: "k", node: null }) });
  await assert.rejects(() => openPeer(ctx)({ stableId: "abc123", staticKey: "k" }), /has not reported a tailnet node/);
  try { await openPeer(ctx)({ stableId: "abc123", staticKey: "k" }); assert.fail("should have thrown"); }
  catch (e) { assert.equal(/** @type {any} */ (e).code, "not_reachable"); }
});

test("peers: openPeer builds a peer with a call() once the device has a tailnet node", async () => {
  const ctx = fakeCtx({ "relay.devices.node": () => ({ stableId: "abc123", staticKey: "k", node: { stableId: "n-1", name: "alex-box.tail0000.ts.net" } }) });
  const peer = await openPeer(ctx)({ stableId: "abc123", staticKey: "k" });
  assert.equal(typeof peer.call, "function");
});

test("peers: selfIdentity names this device, degrading to an empty fingerprint rather than failing", async () => {
  const ctx = fakeCtx({ "relay.status": () => ({ route: "qhoj52gpkpbv7cvaoo2ffra3iq" }) }, { name: "alex" });
  const id = await selfIdentity(ctx)();
  assert.deepEqual(id, { stableId: "qhoj52gpkpbv7cvaoo2ffra3iq", name: "alex", fingerprint: "" });
});

test("peers: selfIdentity falls back to a plain name when relay.status has no data (no relay module)", async () => {
  const ctx = fakeCtx({});
  const id = await selfIdentity(ctx)();
  assert.equal(id.name, "alex");
  assert.equal(id.stableId, "");
});
