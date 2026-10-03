// kernel/seal/testing.js: helpers for the sealing and door tests: fake chains (the brand is a type only), a device signer, a seeded random.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { chainCtx, payloadHash, proofBytes, canonical, sha256b64 } from "./wire.js";

export const SPACE = "spc_testspace0001";
export const actor = (kind, id, space = SPACE) => ({ kind, id, space });
/** A chain as the kernel would build it. @param {Array<[string,string]>} hops [kind, id] pairs @param {string} [surface] */
export const chain = (hops, surface = "deck", space = SPACE) => ({ space, hops: hops.map(([k, i], n) => ({ actor: actor(k, i, space), via: n === 0 ? { surface } : undefined, entered_by: "surface" })), labels: { trust: "member", red: "internal", source_spaces: [space] }, built_at: Date.now() });
export const person = (id = "per_alex", surface = "deck") => chain([["person", id]], surface);
export const withAgent = (id = "per_alex") => chain([["person", id], ["agent", "intake"]]);
export const tmp = name => fs.mkdtempSync(path.join(SCRATCH, `vyre-${name}-`));

/** A device key that signs presence proofs the way the person's hardware signer does. */
export function signer(person_id = "per_alex", key_id = "dk_" + crypto.randomBytes(4).toString("hex"), signerKind = "secure_enclave") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key_id, enrolment: { person: person_id, key_id, signer: signerKind, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    /** @param {any} ch @param {string} op @param {object} fields what the person is shown */
    proof(ch, op, fields, { life = 60_000, issued = Date.now(), nonce = crypto.randomBytes(8).toString("base64url"), tamper = false } = {}) {
      const p = { signer: signerKind, key_id, payload_hash: payloadHash(op, ch.space, fields), decision: op, chain_hash: chainCtx(ch).chain_hash, issued_at: issued, expires_at: issued + life, nonce };
      const sig = crypto.sign("sha256", proofBytes(p), { key: privateKey, dsaEncoding: "ieee-p1363" });
      if (tamper) sig[0] ^= 1;
      return { ...p, signature: sig.toString("base64url") };
    },
  };
}
/** Small seeded generator (mulberry32), so a failing property run prints the seed that reproduces it. */
export function rng(seed) { let a = seed >>> 0; const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; return { next, int: n => Math.floor(next() * n), pick: l => l[Math.floor(next() * l.length)] }; }
export function property(name, runs, fn, seed = Number(process.env.SEED) || Date.now() % 1e9) {
  for (let i = 0; i < runs; i++) { const r = rng(seed + i); try { fn(r, i); } catch (e) { e.message = `${name}: seed ${seed + i}: ${e.message}`; throw e; } }
}
/** A valid US SSN, random. */
export function randomSsn(r) { for (;;) { const a = 1 + r.int(898), g = 1 + r.int(99), s = 1 + r.int(9999); if (a !== 666) return `${String(a).padStart(3, "0")}${String(g).padStart(2, "0")}${String(s).padStart(4, "0")}`; } }
export function luhnCard(r) { const d = [4, ...Array.from({ length: 14 }, () => r.int(10))]; let s = 0; d.slice().reverse().forEach((n, i) => { n = i % 2 === 0 ? (n * 2 > 9 ? n * 2 - 9 : n * 2) : n; s += n; }); return d.join("") + String((10 - (s % 10)) % 10); }
export { canonical };

/** Enrol a signer's key through the ceremony: a one-time token, the person's own chain, and for a further device a proof from a key already enrolled. */
export async function enrolDevice(sealer, sg, { person: who = sg.enrolment.person, existing = null, attestation } = {}) {
  const ch = person(who), e = sg.enrolment;
  const { token } = await sealer.begin({ chain: ch, person: who, key_id: e.key_id, spki: e.spki });
  const fields = { key_id: e.key_id, spki: sha256b64(e.spki), signer: e.signer };
  return sealer.enrol({ chain: ch, person: who, key_id: e.key_id, spki: e.spki, signer: e.signer, token, attestation, proof: existing ? existing.proof(ch, "presence.enrol", fields) : undefined });
}
