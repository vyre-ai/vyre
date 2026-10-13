import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMine, deviceKeyStore, hasMine, unlockMine } from "./member-key.js";

const kvOf = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); }, m }; };

test("making the vault keeps the Secret Key on the device, and unlock sends it with the password", async () => {
  const kv = kvOf(), store = deviceKeyStore(kv), calls = [];
  const ask = async (tool, input) => { calls.push([tool, input]); if (tool === "vault.me.account.create") return { acct: "A1", secretKey: "V2-KEY" }; if (tool === "vault.me.account.status") return { account: true, acct: "A1" }; return { unlocked: true }; };
  await createMine(ask, store, "pw long enough here");
  assert.equal(kv.m.get("vyre.me.sk.A1"), "V2-KEY");
  await unlockMine(ask, store, "pw long enough here");
  assert.deepEqual(calls.at(-1), ["vault.me.account.unlock", { password: "pw long enough here", secretKey: "V2-KEY" }]);
});

test("a device without the key says so and sends nothing; no account says so", async () => {
  const store = deviceKeyStore(kvOf()), calls = [];
  const ask = async (tool) => { calls.push(tool); return tool === "vault.me.account.status" ? { account: true, acct: "A1" } : {}; };
  await assert.rejects(unlockMine(ask, store, "x"), (e) => e.code === "no_device_key");
  assert.ok(!calls.includes("vault.me.account.unlock"));
  await assert.rejects(unlockMine(async () => ({ account: false }), store, "x"), (e) => e.code === "no_account");
  assert.equal(await hasMine(async () => ({ account: false })), false);
});

test("a vault made without a key coming back is reported, not half-kept", async () => {
  await assert.rejects(createMine(async () => ({ acct: "A1" }), deviceKeyStore(kvOf()), "pw"), /key did not come back/);
});
