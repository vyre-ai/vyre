// @ts-check
// Whose call the connect tools are serving (core/connectors/who.js): a claim the Vault cannot name is refused and never served as the owner's, a call with no claim is the home's own, a member is named by the
// Vault, and an assistant with one person behind it may read that person's view and never write.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWho } from "./who.js";

const OWNER = "per_" + "o".repeat(26), SAM = "per_" + "s".repeat(26), EVE = "per_" + "e".repeat(26);
const person = (/** @type {string} */ id) => ({ actor: { kind: "person", id } });
const agent = { actor: { kind: "agent", id: "assistant" } };

/** A context whose Vault answers like vault.me.who (`vaultWho` gets the meta of the call being served). */
function rig(/** @type {(meta: any) => any} */ vaultWho) {
  /** @type {string[]} */ const asked = [];
  /** @type {any} */ let current = null;
  const ctx = {
    kernel: { owner: OWNER, chain: async (/** @type {any} */ meta) => { if (meta.token === "forged") throw new Error("not a session"); return { hops: meta.hops || [] }; } },
    call: async (/** @type {string} */ tool) => { asked.push(tool); return vaultWho(current); },
  };
  const w = createWho(ctx);
  const run = (/** @type {any} */ fn, /** @type {any} */ meta) => { current = meta; return fn(meta); };
  return { c: { asked }, w, run };
}
const vaultOf = (/** @type {any} */ meta) => {
  if (meta.token === "forged") return { error: { code: "denied", message: "who is asking could not be read" } };
  const hops = meta.hops || [];
  if (hops.some((/** @type {any} */ h) => h.actor.kind !== "person")) return { error: { code: "denied", message: "an assistant is not a person: ask as yourself" } };
  const ids = [...new Set(hops.map((/** @type {any} */ h) => h.actor.id))];
  if (ids.length !== 1) return { error: { code: "denied", message: "one person is asking, or none is" } };
  return { data: ids[0] === OWNER ? { kind: "owner" } : { kind: "member", person: ids[0] } };
};

test("a call with no claim is the home's own work and never asks the Vault; a claim is named by the Vault", async () => {
  const { c, w, run } = rig(vaultOf);
  assert.equal(await run(w.memberOf, { caller: "module:planner" }), "");
  assert.deepEqual(c.asked, []);
  assert.equal(await run(w.memberOf, { token: "t", hops: [person(OWNER)] }), "", "the owner");
  assert.equal(await run(w.memberOf, { token: "t", hops: [person(SAM)] }), SAM, "a member");
  assert.equal(await run(w.memberOf, { kernelFacts: { kind: "device" }, hops: [person(SAM)] }), SAM, "facts are a claim too");
  assert.deepEqual(c.asked, ["vault.me.who", "vault.me.who", "vault.me.who"]);
});

test("a forged or expired token, an assistant, or two people are refused on every connect tool's path, never served as the owner's", async () => {
  const { w, run } = rig(vaultOf);
  for (const [what, meta] of [["a forged token", { token: "forged", hops: [] }], ["an assistant", { token: "t", hops: [person(SAM), agent] }], ["two people", { token: "t", hops: [person(SAM), person(EVE)] }], ["no one", { token: "t", hops: [] }]]) {
    await assert.rejects(run(w.memberOf, meta), e => /** @type {any} */ (e).code === "denied", `${what}: a change is refused`);
  }
  await assert.rejects(run(w.viewerOf, { token: "forged", hops: [] }), e => /** @type {any} */ (e).code === "denied", "a forged token cannot read either");
  await assert.rejects(run(w.viewerOf, { token: "t", hops: [person(SAM), person(EVE)] }), e => /** @type {any} */ (e).code === "denied", "two people cannot read");
  await assert.rejects(run(w.viewerOf, { token: "t", hops: [] }), e => /** @type {any} */ (e).code === "denied", "no person behind the claim cannot read");
});

test("an assistant reads the view of the one person behind it (the owner's, or a member's) and still cannot write", async () => {
  const { w, run } = rig(vaultOf);
  assert.equal(await run(w.viewerOf, { token: "t", hops: [person(OWNER), agent] }), "", "the owner's assistant reads the owner's view");
  assert.equal(await run(w.viewerOf, { token: "t", hops: [person(SAM), agent] }), SAM, "a member's assistant reads hers");
  assert.equal(await run(w.viewerOf, { token: "t", hops: [person(SAM)] }), SAM, "a member herself");
  await assert.rejects(run(w.memberOf, { token: "t", hops: [person(OWNER), agent] }), e => /** @type {any} */ (e).code === "denied", "the owner's assistant does not connect or disconnect");
  await assert.rejects(run(w.memberOf, { token: "t", hops: [person(SAM), agent] }), e => /** @type {any} */ (e).code === "denied");
});

test("an error that is not a refusal is not turned into a view", async () => {
  const { w, run } = rig(() => ({ error: { code: "unavailable", message: "the vault is starting" } }));
  await assert.rejects(run(w.viewerOf, { token: "t", hops: [person(SAM), agent] }), e => /** @type {any} */ (e).code === "unavailable");
});
