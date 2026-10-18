import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemberVaultService, ADDKEY_PER_MINUTE } from "./member-service.js";
import { proofRequest } from "../../kernel/remote/proof.js";
import { CALLS } from "../../kernel/remote/wire.js";

const SPACE = "spc_aaaaaaaaaaaa", BOB = "per_" + "b".repeat(26), KEY = "sk-ant-0123456789abcdef", PW = "member pass phrase 77";
const chainOf = (/** @type {any} */ o = {}) => ({ space: SPACE, hops: [{ actor: { kind: "person", id: BOB } }], ...o });
const input = (/** @type {any} */ o = {}) => ({ label: "Work Claude", value: KEY, password: PW, ...o });

/** A door with a stand-in verifier that stands for exactly one proof (made over the right op and fields), once, before it expires. */
function rig({ role = "member", clock = () => 1000 } = {}) {
  /** @type {any[]} */ const calls = [], checks = [];
  const registry = { call: async (/** @type {string} */ tool, /** @type {any} */ i, /** @type {string} */ caller, /** @type {any} */ meta) => { calls.push({ tool, input: i, caller, meta }); return { data: i.call === "status" ? { account: true, unlocked: true } : { item: "Work Claude" } }; } };
  const used = new Set();
  const presence = { check: async (/** @type {any} */ i) => {
    checks.push(i);
    const p = i.proof || {};
    if (p.expires_at <= clock()) return "expired";
    if (used.has(p.nonce)) return "replayed";
    const want = proofRequest(SPACE, "vaultAddKey", { label: "Work Claude", value: KEY });
    if (i.op !== want.op || JSON.stringify(i.fields) !== JSON.stringify(want.fields)) return "wrong_payload";
    used.add(p.nonce); return null;
  } };
  const kernel = { gateway: { members: { roleOf: () => role } }, presence };
  return { svc: createMemberVaultService({ space: SPACE, kernel, registry, clock }), calls, checks };
}
const good = (/** @type {any} */ o = {}) => ({ presence: { nonce: "n1", expires_at: 5000, ...o } });
const code = (/** @type {Promise<any>} */ p) => p.then(() => "ok", (e) => String(e.code));

test("the member door has two calls for a member's own vault: status, and one act that adds a key", () => {
  assert.deepEqual(CALLS.myvault, ["status", "addkey"]);
});

test("a key is covered by one presence proof over the label and the HASH of the value: the request names the hash, never the value or the password", () => {
  const r = proofRequest(SPACE, "vaultAddKey", { label: "Work Claude", value: KEY, password: PW });
  assert.equal(r.op, "grant.add_key");
  assert.ok(!JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes(PW));
  assert.notEqual(r.payload_hash, proofRequest(SPACE, "vaultAddKey", { label: "Work Claude", value: KEY + "x" }).payload_hash, "another key is another proof");
  assert.notEqual(r.payload_hash, proofRequest(SPACE, "vaultAddKey", { label: "Other", value: KEY }).payload_hash, "another label is another proof");
});

test("no proof, a proof for another key, a reused proof and an expired proof each write nothing and ask again", async () => {
  const { svc, calls } = rig();
  assert.equal(await code(svc.addkey(chainOf(), input())), "needs_presence", "no proof");
  assert.equal(await code(svc.addkey(chainOf(), input({ value: KEY + "x" }), good())), "needs_presence", "a proof made for another key");
  assert.equal(await code(svc.addkey(chainOf(), input(), good({ expires_at: 500 }))), "needs_presence", "an expired proof");
  assert.deepEqual(calls, [], "nothing was written or made");
  assert.equal(await svc.addkey(chainOf(), input(), good({ nonce: "once" })).then(() => "ok"), "ok", "a good proof");
  assert.equal(await code(svc.addkey(chainOf(), input(), good({ nonce: "once" }))), "needs_presence", "the same proof again");
  assert.equal(calls.length, 1, "one write for one good proof");
});

test("a good proof runs the vault once as the door for the person the chain names, and nothing the request says about who or where is passed", async () => {
  const { svc, calls } = rig();
  const r = await svc.addkey(chainOf(), { ...input(), person: "per_" + "z".repeat(26), space: "x", as: "y", secret_key: "SK" }, good());
  assert.deepEqual(r, { item: "Work Claude" }, "no value, no password comes back");
  assert.deepEqual([calls[0].tool, calls[0].caller, calls[0].input.call, calls[0].input.person, calls[0].input.space], ["vault.me.serve", "module:vyred", "addkey", BOB, SPACE]);
  assert.deepEqual(Object.keys(calls[0].input.input).sort(), ["label", "password", "secret_key", "value"], "only what the act takes");
  assert.equal((await svc.status(chainOf())).account, true);
});

test("a chain that is not one person of this Space, or a person who is not a member, is not found, and no proof is looked at", async () => {
  for (const chain of [chainOf({ space: "spc_bbbbbbbbbbbb" }), chainOf({ viewer: true }), chainOf({ delegated: true }), chainOf({ hops: [] }), chainOf({ hops: [{ actor: { kind: "agent", id: "kit" } }] }), chainOf({ hops: [{ actor: { kind: "person", id: BOB } }, { actor: { kind: "agent", id: "kit" } }] })]) {
    const { svc, calls, checks } = rig();
    assert.equal(await code(svc.addkey(chain, input(), good())), "not_found");
    assert.deepEqual([calls, checks], [[], []]);
  }
  const { svc, calls, checks } = rig({ role: "" });
  assert.equal(await code(svc.addkey(chainOf(), input(), good())), "not_found");
  assert.deepEqual([calls, checks], [[], []]);
});

test("a member adds at most ten keys a minute, then is told to try again", async () => {
  let t = 1000;
  const { svc } = rig({ clock: () => t });
  for (let i = 0; i < ADDKEY_PER_MINUTE; i++) assert.notEqual(await code(svc.addkey(chainOf(), input(), good({ nonce: `n${i}`, expires_at: 99999 }))), "limit");
  assert.equal(await code(svc.addkey(chainOf(), input(), good({ nonce: "x", expires_at: 99999 }))), "limit");
  t += 61_000;
  assert.notEqual(await code(svc.addkey(chainOf(), input(), good({ nonce: "y", expires_at: 99999 }))), "limit", "a minute later it is open again");
});
