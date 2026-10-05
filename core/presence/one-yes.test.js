// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isYou, yes, configureYes, YES_REASONS, MOMENTS } from "./index.js";
import { isExactlyPerson } from "../../kernel/core/chain.js";

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
  // YY-3: a call that carries an agent or a thread is a model's, whatever its label says
  assert.equal(isYou({ caller: "cli", agent: "kit" }), false);
  assert.equal(isYou({ caller: "cli", thread: "thr_1" }), false);
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
  // YY-1: only null means the proof stands
  for (const bad of [undefined, true, "ok", { ok: "yes" }, 0]) assert.equal((await yes("pair", req, proof, { verify: async () => bad })).ok, false, String(JSON.stringify(bad)));
  assert.deepEqual(await yes("pair", req, proof, verdict(undefined)), { ok: false, reason: "no_proof" });
  // YY-2: a result that does not say how strong the key was counts as software
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true }), softwareOk: () => false }), { ok: false, reason: "software_key" });
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true }), softwareOk: () => true }), { ok: true, strength: "software" });
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true, strength: "software" }), softwareOk: () => true }), { ok: true, strength: "software" }, "a development build takes it");
  assert.deepEqual(await yes("pair", req, proof, verdict({ ok: true, strength: "real" })), { ok: true, strength: "real" });
  // the sealer says `unattested` for a sideloaded iPhone or an Android phone key: real, never software, on a release build too
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true, method: "unattested", strength: "unattested" }), softwareOk: () => false }), { ok: true, strength: "real" });
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => ({ ok: true, method: "software", strength: "software" }), softwareOk: () => false }), { ok: false, reason: "software_key" });
  assert.deepEqual(await yes("pair", req, proof, { verify: async () => { throw new Error("down"); } }), { ok: false, reason: "no_proof" }, "a verifier that throws is a refusal");
  // dry: the verifier is told to check without spending
  let seen = null;
  await yes("vault", req, proof, { verify: async i => { seen = i; return null; }, dry: true });
  assert.equal(seen && seen.dry, true);
  await yes("vault", req, proof, { verify: async i => { seen = i; return null; } });
  assert.equal(seen && seen.dry, undefined);
  configureYes({ verify: async () => null, softwareOk: () => false });
  assert.deepEqual(await yes("vault", req, proof), { ok: true }, "the daemon's configuration is the default");
  configureYes({ verify: null });
  assert.deepEqual(await yes("vault", req, proof), { ok: false, reason: "no_proof" });
});

test("isYou on a kernel chain is the kernel's own isExactlyPerson (the gate uses the kernel's, this is the one public name for it)", async () => {
  const { createChainBuilder } = await import("../../kernel/core/chain.js");
  const { createKernelSeal } = await import("../../kernel/core/seal.js");
  const b = createChainBuilder({ space: "spc_aaaaaaaaaaaa", owner: "per_owner", owner_uid: 501, seal: createKernelSeal({ key: Buffer.alloc(32, 3) }), clock: Date.now });
  const chains = [b.fromFacts({ kind: "socket", surface: "deck", uid: 501 }), b.fromFacts({ kind: "device", device_key_id: "d1", person: "per_owner", path: "direct" }), b.fromFacts({ kind: "socket", surface: "mcp", inside_model_process: true })];
  for (const c of chains) assert.equal(isYou(c), isExactlyPerson(c));
  assert.equal(isYou(chains[0]), true);
  assert.equal(isYou(chains[2]), false);
});

test("the moments: wink.code.open is a pair moment (a browser or server typed pairing starts there), and filling or revealing a sealed field (records.seal-put, records.reveal) is the vault moment", async () => {
  const { momentOf, opFitsMoment, lineOfOp } = await import("../../lib/one-yes.js");
  assert.equal(momentOf("wink.code.open"), "pair");
  assert.equal(opFitsMoment("pair", "wink.code.open"), true);
  for (const op of ["records.seal-put", "records.reveal"]) {
    assert.equal(momentOf(op), "vault", op);
    assert.equal(opFitsMoment("vault", op), true);
    assert.equal(opFitsMoment("pair", op), false);
    assert.match(lineOfOp(op, {}, "A device"), /sealed/);
  }
  // not widened: a prefix never counts
  assert.equal(momentOf("records.update"), null);
  assert.equal(momentOf("wink.code.status"), null);
});
