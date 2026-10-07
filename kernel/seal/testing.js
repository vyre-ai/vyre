// kernel/seal/testing.js: helpers for the sealing and door tests: fake chains (the brand is a type only), a device signer, a seeded random.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { chainCtx, payloadHash, proofBytes, canonical, sha256b64 } from "./wire.js";

export const SPACE = "spc_testspace0001";
export const actor = (kind, id, space = SPACE) => ({ kind, id, space });

// Chains are the kernel's own (kernel/core/chain.js, the real builder with a development seal key), not hand-made lookalikes: the sealing process and the door are tested against what the
// kernel really builds, so a change in the kernel's chain shape fails here. The owner is per_alex; anyone else is a member who signed in on a device.
import { createChainBuilder } from "../core/chain.js";
import { createKernelSeal } from "../core/seal.js";
const OWNER = "per_alex", builders = new Map();
const builderFor = space => { if (!builders.has(space)) builders.set(space, createChainBuilder({ space, owner: OWNER, owner_uid: 501, seal: createKernelSeal({ key: Buffer.alloc(32, 3) }), clock: Date.now, is_person: () => true })); return builders.get(space); };
/** A person in a Space: the owner on a surface (deck, capsule, cli ...), or a member on a device. */
export const person = (id = OWNER, surface = "deck", space = SPACE) => id === OWNER
  ? builderFor(space).fromFacts({ kind: "socket", surface, uid: 501, ...(surface === "capsule" ? { capsule_verified: true } : {}) })
  : builderFor(space).fromFacts({ kind: "device", device_key_id: `d_${id}`, person: id, path: "direct" });
/** A person's session with an agent in it. */
export const withAgent = (id = OWNER, agent = "intake", space = SPACE) => builderFor(space).fromFacts({ kind: "agent_session", agent, session: "s1", thread: "t1", vouched: true, person: id });
/**
 * A chain as the kernel builds it, from [kind, id] pairs. Shapes the builder has a door for are built by it: a person, a person with an agent, a person through a module (service), and a model's own call.
 * SHIM(chain-shapes): any other shape (a service first, three hops) is hand-made like the old helper, because no door builds it.
 */
export const chain = (hops, surface = "deck", space = SPACE) => {
  const kinds = hops.map(h => h[0]).join(">");
  if (kinds === "person") return person(hops[0][1], surface, space);
  if (kinds === "person>agent") return withAgent(hops[0][1], hops[1][1], space);
  if (kinds === "person>service") return builderFor(space).fromFacts({ kind: "module", inbound: person(hops[0][1], surface, space), module: hops[1][1], first_party: true });
  if (kinds === "agent") return builderFor(space).fromFacts({ kind: "socket", surface: "mcp", inside_model_process: true });
  return { space, hops: hops.map(([k, i], n) => ({ actor: actor(k, i, space), via: n === 0 ? { surface } : undefined, entered_by: "surface" })), labels: { trust: "member", red: "internal", source_spaces: [space] }, built_at: Date.now() };
};
export const tmp = name => fs.mkdtempSync(path.join(SCRATCH, `vyre-${name}-`));

/** A device key that signs presence proofs the way the person's hardware signer does. */
export function signer(person_id = "per_alex", key_id = "dk_" + crypto.randomBytes(4).toString("hex"), signerKind = "secure_enclave") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key_id, enrolment: { person: person_id, key_id, signer: signerKind, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    /** @param {any} ch @param {string} op @param {object} fields what the person is shown */
    proof(ch, op, fields, { life = 60_000, issued = Date.now(), nonce = crypto.randomBytes(8).toString("base64url"), tamper = false, extra = {} } = {}) {
      const p = { ...extra, signer: signerKind, key_id, payload_hash: payloadHash(op, ch.space, fields), decision: op, chain_hash: chainCtx(ch).chain_hash, issued_at: issued, expires_at: issued + life, nonce };
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
