// @ts-check
// Her signed yes at a tag (core/vault/mention-yes.js), on a REAL vyred with the REAL verifier wired (the sealing process, not a stub), CI only. Written without a run: it is seen to run on CI first.
//   1. Through the actual registry, a lend (vault.me.mention.lend, called as the Switchboard) for a member is refused with presence_required when there is no yes, junk, or a yes that is not that member's key.
//   2. The verifier the registry hands the Vault (registry.deps.verifyYes): a yes for another item, agent or thread is refused; a replay is refused; an EXPIRED yes is refused; one valid device-signed yes stands.
// A member's own device key cannot be enrolled by the dev scripts (they enrol the owner's), so the valid case is checked at the seam with the owner's key, and the member's lend is refused with the owner's key.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "./index.js";
import { homeIdentity } from "../../kernel/home.js";
import { chainCtx, payloadHash, proofBytes } from "../../kernel/seal/wire.js";
import { signOf } from "../../lib/one-yes.js";
import { yesFields, OP } from "../vault/mention-yes.js";
import { tempHome } from "../../test/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (/** @type {string} */ script, /** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8" });
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";

/** @param {any} t @param {Record<string, string | undefined>} env */
function withEnv(t, env) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

async function world(/** @type {any} */ t) {
  withEnv(t, { VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_KERNEL: "1" });
  const root = tempHome(t);
  homeIdentity(root);
  assert.equal(run("dev-enrol-software-key.mjs", ["--home", root]).status, 0);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 100));   // the sealing process takes no proof made before it started
  const K = d.kernel, OWNER = K.id.owner;
  await K.gateway.grants.setRole(K.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: OWNER, path: "direct" }), { person: BEN, role: "member" });
  /** The yes the way her app would send it for these fields: signed by the owner's enrolled key (the only one a dev home has). */
  const sign = (/** @type {any} */ fields) => { const r = run("dev-sign-proof.mjs", ["--home", root, "--yes", "vault", "--tool", OP, "--input", JSON.stringify(fields), "--header"]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim().replace(/^yes proof=/, ""); };
  /** The same proof but already over: issued and expired in the past, signed with the same key. */
  const expired = (/** @type {any} */ fields) => {
    const k = JSON.parse(fs.readFileSync(path.join(root, "dev-owner-key.json"), "utf8"));
    const sg = signOf("vault", { op: OP, fields });
    const now = Date.now() - 120_000;
    const p = { signer: "software", key_id: k.key_id, payload_hash: payloadHash(sg.op, k.space, sg.fields), decision: sg.op, chain_hash: chainCtx({ space: k.space, hops: [{ actor: { kind: "person", id: k.person, space: k.space } }] }).chain_hash, issued_at: now, expires_at: now + 50_000, nonce: crypto.randomBytes(8).toString("base64url") };
    const key = crypto.createPrivateKey({ key: Buffer.from(k.private_pkcs8, "base64"), format: "der", type: "pkcs8" });
    return Buffer.from(JSON.stringify({ ...p, signature: crypto.sign("sha256", proofBytes(p), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") })).toString("base64url");
  };
  const verify = (/** @type {string} */ person, /** @type {any} */ fields, /** @type {string} */ yes) => /** @type {any} */ (d.registry.deps).verifyYes(person, OP, fields, JSON.parse(Buffer.from(yes, "base64url").toString("utf8")));
  const lend = (/** @type {any} */ input) => d.registry.call(OP, input, "module:threads");
  return { d, OWNER, sign, expired, verify, lend };
}

test("through the real registry, a member's lend without her own yes is refused: none, junk, and a yes signed by another person's key", { timeout: 120_000 }, async t => {
  const { lend, sign } = await world(t);
  const L = { asker: BEN, id: "passport", thread: "thread_1", agent: "kit" };
  assert.equal((await lend(L)).error?.code, "presence_required", "no yes");
  assert.equal((await lend({ ...L, yes: "not a proof" })).error?.code, "presence_required", "junk");
  assert.equal((await lend({ ...L, yes: Buffer.from(JSON.stringify({ forged: true })).toString("base64url") })).error?.code, "presence_required", "a forged proof");
  assert.equal((await lend({ ...L, yes: sign(yesFields(BEN, L)) })).error?.code, "presence_required", "right fields, but signed by the owner's key, not Ben's");
});

test("the verifier the Vault is handed: wrong item, agent or thread, a replay and an expired yes are refused; one valid yes stands", { timeout: 120_000 }, async t => {
  const { OWNER, sign, expired, verify } = await world(t);
  const L = { asker: OWNER, id: "passport", thread: "thread_1", agent: "kit" };
  const f = yesFields(OWNER, L);
  for (const other of [{ id: "other" }, { agent: "juno" }, { thread: "thread_2" }, { origin: "https://evil.example.test" }]) {
    assert.equal((await verify(OWNER, f, sign(yesFields(OWNER, { ...L, ...other })))).ok, false, `a yes for another ${Object.keys(other)[0]}`);
  }
  assert.equal((await verify(OWNER, f, expired(f))).ok, false, "an expired yes");
  const good = sign(f);
  assert.equal((await verify(OWNER, f, good)).ok, true, "one valid device-signed yes");
  assert.equal((await verify(OWNER, f, good)).ok, false, "the same yes again");
});
