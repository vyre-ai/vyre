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

test("a space on a paired server: the remote gateway runs with the caller's proof in reach of the remote signer, and with none the signer has nothing to give", async () => {
  const { proofSigner } = await import("./remote-proof.js");
  const gateway = { records: { define: async () => proofSigner() }, definitions: async () => proofSigner() };
  const remote = { ...ctx, kernel: { ...ctx.kernel, chain: async () => chain, for: async () => ({ hosted: false, gateway, surfaces: {} }) } };
  const door = createDoor(/** @type {any} */ (remote));
  const proof = { key: "k1", signature: "s" };
  const withIt = await door.open({ space: SPACE }, { caller: "cli", kernel_proof: proof });
  assert.deepEqual(await withIt.gateway.records.define(chain, {}), { presence: proof }, "the proof the person made for this call reaches the signer");
  assert.deepEqual(await withIt.gateway.definitions(chain), { presence: proof });
  const without = await door.open({ space: SPACE }, { caller: "cli" });
  await assert.rejects(() => without.gateway.records.define(chain, {}), { code: "needs_presence" });
});

test("on a box that holds no identity of its own (spaces.self throws) a hosted space is found from the person's member list: the only one, one named by its name, and two without a name ask which", async () => {
  const A = "spc_aaaaaaaaaaaa", B = "spc_bbbbbbbbbbbb";
  /** @type {{ space: string, name: string }[]} */ let mine = [{ space: A, name: "harlow.vyre.run" }];
  const box = { kernel: { ...ctx.kernel, space: "spc_homehomehome" }, call: async (/** @type {string} */ tool) => { if (tool === "spaces.self") throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" }); if (tool === "spaces.merge-list") return { data: { spaces: mine } }; return { error: { code: "no_such_tool" } }; } };
  const door = createDoor(/** @type {any} */ (box));
  assert.equal(await door.spaceOf({}), A, "the one space the person is in");
  assert.equal(await door.spaceOf({ space: "harlow.vyre.run" }), A, "by its name");
  assert.equal(await door.spaceOf({ space: "harlow" }), A, "by its short name");
  await assert.rejects(() => door.spaceOf({ space: "elsewhere.vyre.run" }), { code: "not_found" });
  mine = [{ space: A, name: "harlow.vyre.run" }, { space: B, name: "northwind.vyre.run" }];
  await assert.rejects(() => door.spaceOf({}), { code: "needs_space" });
  assert.equal(await door.spaceOf({ space: "northwind" }), B);
});
