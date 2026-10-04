// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isYou, yes, configureYes, YES_REASONS, MOMENTS } from "./index.js";

const person = { hops: [{ actor: { kind: "person", id: "per_a" } }] };

test("isYou: a chain of exactly one person, a person surface and a paired device are you; an agent, a viewer, a model's shell and a module are not", () => {
  assert.equal(isYou(person), true);
  assert.equal(isYou({ hops: [{ actor: { kind: "person", id: "per_a" } }, { actor: { kind: "agent", id: "kit" } }] }), false, "a person with an agent in the chain is the agent");
  assert.equal(isYou({ ...person, viewer: true }), false, "a viewer chain is the kernel's read-only view, not their act");
  assert.equal(isYou({ hops: [] }), false);
  assert.equal(isYou({ caller: "cli" }), true);
  assert.equal(isYou({ caller: "device:abcdefghijklmnop" }), true);
  assert.equal(isYou({ caller: "mcp" }), false);
  assert.equal(isYou({ caller: "module:vault" }), false);
  assert.equal(isYou(null), false);
});

test("yes: the three moments, the six reasons, software only where the build takes it, and nothing configured is refused", async () => {
  assert.deepEqual([...MOMENTS], ["pair", "vault", "outward"]);
  const req = { op: "vault.reveal", fields: { name: "northwind-mail" } };
  const proof = { signer: "secure_enclave", signature: "x" };
  assert.deepEqual(await yes("vault", req, proof, { verify: null }), { ok: false, reason: "no_proof" }, "no verifier: fails closed");
  const verdict = r => ({ verify: async () => r });
  assert.deepEqual(await yes("vault", req, proof, verdict(null)), { ok: true });
  assert.deepEqual(await yes("admin", req, proof, verdict(null)), { ok: false, reason: "wrong_request" }, "only the three moments");
  assert.deepEqual(await yes("vault", { op: "Bad Op", fields: {} }, proof, verdict(null)), { ok: false, reason: "wrong_request" });
  assert.deepEqual(await yes("vault", req, null, verdict(null)), { ok: false, reason: "no_proof" });
  for (const [code, want] of [["expired", "expired"], ["replayed", "replayed"], ["wrong_decision", "wrong_request"], ["wrong_payload", "wrong_request"], ["unknown_key", "unknown_key"], ["software_key", "software_key"], ["no_proof", "no_proof"], ["something_new", "no_proof"]]) {
    const r = await yes("outward", req, proof, verdict(code));
    assert.deepEqual(r, { ok: false, reason: want }, code);
    assert.ok(YES_REASONS.includes(/** @type {any} */ (r).reason));
  }
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true, strength: "software" }), softwareOk: () => false }), { ok: false, reason: "software_key" }, "a software key on a release build");
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true, strength: "software" }), softwareOk: () => true }), { ok: true, strength: "software" }, "a development build takes it");
  assert.deepEqual(await yes("pair", req, proof, verdict({ ok: true, strength: "real" })), { ok: true, strength: "real" });
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => { throw new Error("down"); } }), { ok: false, reason: "no_proof" }, "a verifier that throws is a refusal");
  configureYes({ verify: async () => null, softwareOk: () => false });
  assert.deepEqual(await yes("vault", req, proof), { ok: true }, "the daemon's configuration is the default");
  configureYes({ verify: null });
  assert.deepEqual(await yes("vault", req, proof), { ok: false, reason: "no_proof" });
});
