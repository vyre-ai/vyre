import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemberVaultService } from "./member-service.js";

const SPACE = "spc_aaaaaaaaaaaa", BOB = "per_" + "b".repeat(26);
const chainOf = (/** @type {any} */ o = {}) => ({ space: SPACE, hops: [{ actor: { kind: "person", id: BOB } }], ...o });
function rig(role = "member") {
  /** @type {any[]} */ const calls = [];
  const registry = { call: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => { calls.push({ tool, input, caller, meta }); return input.input.fail ? { error: { code: "denied", message: `refused ${input.input.password}` } } : { data: { ok: true } }; } };
  const kernel = { gateway: { members: { roleOf: () => role } } };
  return { svc: createMemberVaultService({ space: SPACE, kernel, registry }), calls };
}

test("a member's vault calls run the vault's serve tool as the door, for the person the chain names, with the request's own person, space and as dropped", async () => {
  const { svc, calls } = rig();
  await svc.status(chainOf(), { person: "per_" + "z".repeat(26), space: "other", as: "x" });
  await svc.put(chainOf(), { name: "n", kind: "api-key", fields: { value: "v" } });
  assert.deepEqual(calls.map((c) => [c.tool, c.caller, c.input.call, c.input.person, c.input.space]), [["vault.me.serve", "module:vyred", "status", BOB, SPACE], ["vault.me.serve", "module:vyred", "put", BOB, SPACE]]);
  assert.deepEqual(calls[0].input.input, {}, "nothing the request names about who or where goes through");
});

test("a chain that is not one person of this Space, or a person who is not a member, is not found, and nothing runs", async () => {
  for (const chain of [chainOf({ space: "spc_bbbbbbbbbbbb" }), chainOf({ viewer: true }), chainOf({ delegated: true }), chainOf({ hops: [] }), chainOf({ hops: [{ actor: { kind: "agent", id: "kit" } }] }), chainOf({ hops: [{ actor: { kind: "person", id: BOB } }, { actor: { kind: "agent", id: "kit" } }] })]) {
    const { svc, calls } = rig();
    await assert.rejects(() => svc.unlock(chain, { password: "p" }), (e) => /not.found/.test(String(e.code) + e.message));
    assert.deepEqual(calls, []);
  }
  const { svc, calls } = rig("");
  await assert.rejects(() => svc.list(chainOf(), {}), (e) => /not.found/.test(String(e.code) + e.message));
  assert.deepEqual(calls, []);
});

test("an error from the vault comes out as a plain code and its words, which the vault itself keeps free of the password", async () => {
  const { svc } = rig();
  await assert.rejects(() => svc.create(chainOf(), { password: "pw", fail: true }), (e) => /not.allowed|denied/.test(String(e.code)));
});
