// @ts-check
// The first-owner passkey at the person's own address (setup claim, tailnet's B4): the grant a claim link earns is sent as
// the presence proof of presence.enroll, in the header the box's "grant" method reads, and nothing else rides along.
import test from "node:test";
import assert from "node:assert/strict";

test("callWithGrant sends the grant as x-vyre-presence 'grant grant=<g>' to presence.enroll and returns the data", async () => {
  const calls = [];
  /** @type {any} */ (globalThis).location = { search: "", hash: "", pathname: "/", hostname: "harlow.vyre.run", origin: "https://harlow.vyre.run" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, init) => { calls.push([String(url), init]); return { status: 200, statusText: "OK", json: async () => ({ data: { id: "kh1" } }) }; });
  try {
    const { callWithGrant } = await import("../deck/js/api.js");
    const r = await callWithGrant("presence.enroll", { kind: "passkey", rp_id: "harlow.vyre.run" }, "g-abc_123");
    assert.deepEqual(r, { id: "kh1" });
    assert.equal(calls[0][0], "/v1/tools/presence.enroll");
    assert.equal(calls[0][1].headers["x-vyre-presence"], "grant grant=g-abc_123");
    assert.equal(JSON.parse(calls[0][1].body).rp_id, "harlow.vyre.run");
    // A refusal is an error with the box's own code and words, not a silent success.
    globalThis.fetch = /** @type {any} */ (async () => ({ status: 403, statusText: "Forbidden", json: async () => ({ error: { code: "denied", message: "that grant is used or expired" } }) }));
    await assert.rejects(callWithGrant("presence.enroll", {}, "old"), e => /** @type {any} */ (e).code === "denied" && /used or expired/.test(e.message));
  } finally { globalThis.fetch = realFetch; delete /** @type {any} */ (globalThis).location; }
});
