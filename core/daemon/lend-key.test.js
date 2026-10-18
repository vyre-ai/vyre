// @ts-check
// lendKey in the daemon: a one-turn session of the asker alone, one call, ended in a finally, and the token never leaves the function.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lendKey } from "./lend-key.js";

function rig(/** @type {{ reply?: any, throwOpen?: boolean, throwCall?: boolean }} */ o = {}) {
  /** @type {any[]} */ const opened = [], revoked = [], called = [];
  const kernel = { id: { space: "spc_home" }, surfaces: {
    open: async (/** @type {any} */ chain, /** @type {any} */ opts) => { if (o.throwOpen) throw new Error("kernel down"); opened.push({ chain, opts }); return { token: "TOKEN-SECRET", session: "ses_1", expires: 1 }; },
    revoke: (/** @type {string} */ s) => { revoked.push(s); } } };
  const lend = lendKey({ kernel, personChainFor: async p => ({ person: p }), callLend: async (i, x) => { called.push({ i, x }); if (o.throwCall) throw new Error("boom"); return o.reply || { data: { value: "sk-fixture-0123456789" } }; } });
  return { lend, opened, revoked, called };
}

test("it opens the asker's own short session, makes the one call on it, and ends it", async () => {
  const r = rig();
  assert.deepEqual(await r.lend({ asker: "per_ben", account: "acc1" }), { data: { value: "sk-fixture-0123456789" } });
  assert.deepEqual(r.opened.map(x => [x.chain, x.opts]), [[{ person: "per_ben" }, { ttl_ms: 20_000 }]], "one person, no agent, no chat");
  assert.deepEqual(r.called.map(c => [c.i, Object.keys(c.x)]), [[{ account: "acc1" }, ["token"]]]);
  assert.deepEqual(r.revoked, ["ses_1"]);
});

test("the session ends when the call fails or throws, and the token is in nothing it returns", async () => {
  for (const o of [{ reply: { error: { code: "locked", message: "unlock" } } }, { throwCall: true }]) {
    const r = rig(o);
    const out = await r.lend({ asker: "per_ben", account: "acc1" });
    assert.ok(out.error);
    assert.deepEqual(r.revoked, ["ses_1"]);
    assert.ok(!JSON.stringify(out).includes("TOKEN-SECRET"));
  }
  const dead = rig({ throwOpen: true });
  assert.equal((await dead.lend({ asker: "per_ben", account: "acc1" })).error?.code, "denied");
  assert.deepEqual(dead.revoked, []);
});

test("no asker, no account, or a team Space's turn: nothing is opened", async () => {
  const r = rig();
  for (const q of [{ asker: "", account: "acc1" }, { asker: "per_ben", account: "" }, { asker: "per_ben", account: "acc1", space: "spc_team" }]) assert.equal((await r.lend(q)).error?.code, "denied");
  assert.deepEqual(r.opened, []);
  assert.equal((await r.lend({ asker: "per_ben", account: "acc1", space: "spc_home" })).data?.value, "sk-fixture-0123456789");
});
