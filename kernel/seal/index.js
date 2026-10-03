// kernel/seal/index.js: the SealApi (contracts seal.d.ts): `put`, `use` and `reveal`, in front of the sealing process.
// Every call is authorized and every one writes an event that never carries a value. `reveal` is human-only: the chain
// must be exactly one person and the proof must be a hardware-signer proof over THIS reveal.
import { canonical, sha256 } from "../core/canonical.js";
import { isChain, isExactlyPerson, chainHash, hasKind } from "../core/chain.js";
import { createGate } from "../core/gate.js";
import { KernelError } from "../core/errors.js";
import { spaceOf, segments } from "../core/urn.js";

/** The actions the seal calls register with the authorizer (contract 6.1). `sealed_ok`: model-free by declaration. */
export const SEAL_ACTIONS = Object.freeze([
  { action: "seal.put", resource_type: "record", risk: "write", label: "seal a value", gloss: "Put a value away so no assistant can read it.", sealed_ok: true },
  { action: "seal.use", resource_type: "record", risk: "write", label: "use a sealed value", gloss: "Fill a sealed value into a document or message without showing it.", sealed_ok: true },
  { action: "seal.reveal", resource_type: "record", risk: "admin", label: "reveal a sealed value", gloss: "Show a sealed value to you, on your screen only." },
].map(a => Object.freeze(a)));

/** The hash a checker's approval must have covered for a sealed use: the exact ref, template version, slot and destination. */
export const sealUsePayloadHash = (/** @type {{ ref: string, template: string, template_version: number, slot: string, destination: any }} */ u) =>
  sha256(canonical({ ref: u.ref, template: u.template, version: u.template_version, slot: u.slot, destination: u.destination }));

export const sessionOf = (/** @type {any} */ chain) => { const h = chain.hops.find((/** @type {any} */ x) => x.via && x.via.session); return h ? h.via.session : "none"; };

/**
 * @param {{ space: string, client: any, authorizer: any, log: any, clock?: () => number,
 *   templates?: (urn: string, version: number) => Promise<{ id: string, version: number, body: string, slots: string[], headers?: Record<string, string> } | null>,
 *   approvedTask?: (task: string, payload_hash: string) => boolean | Promise<boolean>,
 *   verifyPresence?: (proof: any, ctx: { chain: any, ref: string, purpose: string }) => boolean }} cfg
 *   templates: how the kernel reads the exact approved template version; approvedTask: K4's check that a checker approved this payload;
 *   verifyPresence: K4's check of the hardware signer's signature (without it a reveal is always refused).
 */
export function createSeal(cfg) {
  const clock = cfg.clock || Date.now;
  const { gate } = createGate({ authorizer: cfg.authorizer, log: cfg.log });
  const proofNonces = new Set();
  const own = (/** @type {string} */ record) => { if (!segments(record) || spaceOf(record) !== cfg.space) throw new KernelError("wrong_space", "record is not in this space"); };
  const meta = async (/** @type {string} */ ref) => { try { return await cfg.client.meta({ ref }); } catch (e) { throw new KernelError("not_found", "no such sealed value", String(/** @type {any} */ (e).code)); } };

  return Object.freeze({
    async put(/** @type {any} */ input) {
      own(input.record);
      const d = await gate(input.chain, "seal.put", input.record);
      let res;
      try { res = await cfg.client.put({ record: input.record, field: input.field, class: input.class, value: input.value, hint_allowed: input.hint_allowed }); }
      catch (e) { throw scrub(e); }
      cfg.log.append(input.chain, { type: "field.sealed", sv: 1, subject: input.record, data: { field: input.field, class: res.ref.sealed, valid_format: res.ref.valid_format, ref: res.ref.ref }, red: "pii" }, { decision: d.decision });
      return { ref: res.ref };
    },

    async use(/** @type {any} */ input) {
      const chain = input.chain;
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      const m = await meta(input.ref);
      const d = await gate(chain, "seal.use", m.record);
      const tpl = cfg.templates ? await cfg.templates(input.template, input.template_version) : null;
      if (!tpl) throw new KernelError("not_found", "no such template version");
      const destination = { ...input.destination };
      // A use reached from a model is always an Ask with fresh presence; a checker's approval of this exact payload satisfies it
      // and is what verifies a contact point for this one use (8.5).
      const payload_hash = sealUsePayloadHash({ ref: input.ref, template: input.template, template_version: input.template_version, slot: input.slot, destination: input.destination });
      const approved = input.task && cfg.approvedTask ? await cfg.approvedTask(input.task, payload_hash) : false;
      if (hasKind(chain, "agent") && !approved) throw Object.assign(new KernelError("needs_approval", "a sealed value used from a plan a model made needs a person's approval", `class ${m.ref.sealed}`), { decision: d.decision, class: m.ref.sealed, recipient: destination });
      if (approved && destination.kind === "contact_point") destination.verified = true;
      let res;
      try { res = await cfg.client.use({ ref: input.ref, template: tpl, slot: input.slot, destination, session: sessionOf(chain) }); }
      catch (e) {
        if (e && /** @type {any} */ (e).code === "destination_not_allowed") throw Object.assign(new KernelError("needs_approval", "that destination needs a person's approval", `class ${m.ref.sealed}`), { decision: d.decision, class: m.ref.sealed, recipient: destination });
        throw scrub(e);
      }
      cfg.log.append(chain, { type: "seal.used", sv: 1, subject: m.record, data: { field: m.field, class: m.ref.sealed, template: input.template, version: input.template_version, slot: input.slot, destination: destination.kind, output_ref: res.output_ref }, red: "pii" }, { decision: d.decision });
      return res;
    },

    async reveal(/** @type {any} */ input) {
      const chain = input.chain;
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      // Human-only (invariant 4): exactly one person, and a signer's proof over this reveal, never reused.
      if (!isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person on their own can reveal a sealed value");
      const p = input.proof;
      const want = sha256(canonical({ op: "reveal", ref: input.ref, purpose: input.purpose }));
      if (!p || p.payload_hash !== want || p.chain_hash !== chainHash(chain) || !(p.expires_at > clock()) || proofNonces.has(p.nonce)) throw new KernelError("needs_presence", "a reveal needs your confirmation on this device");
      if (!cfg.verifyPresence || !cfg.verifyPresence(p, { chain, ref: input.ref, purpose: input.purpose })) throw new KernelError("needs_presence", "a reveal needs your confirmation on this device");
      const m = await meta(input.ref);
      if (typeof input.purpose !== "string" || !input.purpose.trim()) throw new KernelError("bad_input", "a reveal needs a stated purpose");
      const d = await gate(chain, "seal.reveal", m.record, { presence: p });
      proofNonces.add(p.nonce);
      let res;
      try { res = await cfg.client.reveal({ ref: input.ref, purpose: input.purpose, session: sessionOf(chain) }); }
      catch (e) { throw scrub(e); }
      cfg.log.append(chain, { type: "field.revealed", sv: 1, subject: m.record, data: { field: m.field, class: m.ref.sealed, purpose: input.purpose, expires_in_ms: res.expires_in_ms }, red: "privileged" }, { decision: d.decision });
      return { value: res.value, expires_in_ms: res.expires_in_ms };
    },
  });

  function scrub(/** @type {any} */ e) {
    if (e instanceof KernelError) return e;
    return new KernelError("unavailable", "the sealing process could not do that", String(e && e.code));
  }
}
