// kernel/gateway/sealing.js: the gateway's side of sealing (contract 8; K3 gate wiring conditions). The sealing process and the door are
// vault's; this file only decides who may call them and with what. Every call takes a kernel-built chain and asks `authorize` first.
// What the process must not take from a caller is derived here, from the kernel's own records:
//   - the destination (`verified`, `record`, the contact point) comes from `cfg.destinations`, read from the record, never from the call;
//   - the approver chain and the proof come from the recorded approval (`cfg.approvals`, K4's task machinery), never from the call;
//   - the template body and its version come from the Template record version the approval hashed (`cfg.templates`);
//   - the door's ledger key goes into every reveal, and a chain is turned into the process's summary only after `isChain`.
// A provider that is not wired refuses with `unavailable`: sealed merging stays closed until K4 supplies approvals.
import { isChain } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { createGate } from "../core/gate.js";
import { segments } from "../core/urn.js";
import { recipientsOf } from "../seal/process.js";

const APPROVAL_MAX_AGE = 24 * 3600_000;

/**
 * @param {{ space: string, sealer: any, authorizer: any, log: any, door?: any,
 *   clock?: () => number, approval_max_age?: number,
 *   approvals?: { get(id: string): Promise<{ approver_chain: any, proof: any, template: string, template_version: number, record: string, bindings: { slot: string, ref: string }[] } | null> },
 *   templates?: { get(urn: string, version: number): Promise<{ body: string } | null> },
 *   destinations?: { resolve(record: string, destination: any): Promise<{ kind: "contact_point", record: string, contact: string, verified: true } | { kind: "document", record: string, document: string } | null> } }} cfg
 */
export function createSealing(cfg) {
  const { sealer, door } = cfg;
  const { gate } = createGate({ authorizer: cfg.authorizer, log: cfg.log });
  const mustChain = (/** @type {any} */ c) => { if (!isChain(c)) throw new KernelError("bad_input", "a call needs a kernel-built chain"); };
  const mustRecord = (/** @type {any} */ u) => { const s = segments(u); if (!s || s[0] !== cfg.space || s.length < 3) throw new KernelError("bad_input", "bad record"); };
  const mapErr = (/** @type {any} */ e) => (e instanceof KernelError ? e : new KernelError(typeof e?.code === "string" ? e.code : "unavailable", "sealing refused"));
  const run = async (/** @type {() => Promise<any>} */ f) => { try { return await f(); } catch (e) { throw mapErr(e); } };
  const sameActor = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id && a.space === b.space;
  /** The approval for this record, for this executor, within its age: an approval is the doer's, not whoever knows its id (K4 item 7). */
  async function approvalFor(/** @type {any} */ chain, /** @type {any} */ i) {
    const ap = await need(cfg.approvals, "approvals").get(i.approval);
    if (!ap || ap.record !== i.record) throw new KernelError("not_found", "no such approval");
    mustChain(ap.approver_chain);
    if (ap.doer && !sameActor(chain.hops[chain.hops.length - 1].actor, ap.doer)) throw new KernelError("not_found", "no such approval");
    if (typeof ap.approved_at === "number" && (cfg.clock || Date.now)() - ap.approved_at > (cfg.approval_max_age ?? APPROVAL_MAX_AGE)) throw new KernelError("not_found", "that approval has expired");
    return ap;
  }
  const need = (/** @type {any} */ p, /** @type {string} */ what) => { if (!p) throw new KernelError("unavailable", `${what} is not wired`); return p; };

  return Object.freeze({
    /** The person types a value; it becomes a reference the record keeps. A uniqueness check is the person's only (the process enforces it). */
    async put(chain, i) {
      mustChain(chain); mustRecord(i.record);
      await gate(chain, "seal.put", i.record);
      return run(() => sealer.api.put({ chain, record: i.record, field: i.field, class: i.class, value: i.value, hint_allowed: i.hint_allowed, unique: i.unique }));
    },

    /** Show a value to the person on their own screen. `admin` risk: a presence session at least, and the process wants the signed proof. */
    async reveal(chain, i) {
      mustChain(chain); mustRecord(i.record);
      // Without the door there is no ledger to record what a person is shown, so a reveal is refused rather than run without one.
      if (!door) throw new KernelError("unavailable", "the inference door is not wired");
      await gate(chain, "seal.reveal", i.record, { presence: i.proof });
      const ledger_key = door.ledgerKey(chain, i.session ?? `reveal_${i.ref}`);
      return run(() => sealer.api.reveal({ chain, ref: i.ref, purpose: i.purpose, proof: i.proof, ledger_key }));
    },

    /** Merge a sealed value into a template for a verified destination. The call names only the approval; everything else is looked up. */
    async use(chain, i) {
      mustChain(chain); mustRecord(i.record);
      await gate(chain, "seal.use", i.record);
      const ap = await approvalFor(chain, i);
      const tpl = await need(cfg.templates, "templates").get(ap.template, ap.template_version);
      if (!tpl) throw new KernelError("not_found", "no such template version");
      const destination = await need(cfg.destinations, "destinations").resolve(i.record, i.destination);
      if (!destination) throw new KernelError("not_found", "no verified destination");
      return run(() => sealer.api.use({ chain, approver_chain: ap.approver_chain, bindings: ap.bindings, body: tpl.body, template: ap.template, template_version: ap.template_version, destination, proof: ap.proof }));
    },

    /**
     * Send what was merged. Outward: authorize asks for the person. The approver is the recorded approval's; the proof is the approver's
     * own signature over this envelope and output, made after the merge (its reference did not exist at approval) and verified by the
     * sealing process against the approver's chain, so a caller cannot make one.
     */
    async deliver(chain, i) {
      mustChain(chain); mustRecord(i.record);
      // The approval is the evidence that satisfies the outward ask: the person approved exactly this sink and these recipients. A deny, or
      // a missing grant or presence, still refuses; only `needs_approval` is met by the approval (K4 item 6).
      const d = await cfg.authorizer.authorize({ chain, action: "seal.deliver", resource: i.record });
      if (d.effect === "deny") throw Object.assign(new KernelError("not_found", "no such record", d.reason), { decision: d.decision });
      if (d.effect === "ask" && d.reason !== "needs_approval") throw Object.assign(new KernelError(d.reason, "seal.deliver needs more"), { decision: d.decision, obligations: d.obligations });
      const ap = await approvalFor(chain, i);
      const dl = ap.delivery;
      const to = recipientsOf(i.envelope || {});
      if (!dl || dl.sink !== i.sink || !Array.isArray(dl.to) || !to.length || !to.every(x => dl.to.map((/** @type {any} */ y) => String(y).trim().toLowerCase()).includes(x))) throw new KernelError("not_found", "the approval does not cover this sink and these recipients");
      return run(() => sealer.deliver({ chain, approver_chain: ap.approver_chain, output_ref: i.output_ref, sink: i.sink, envelope: i.envelope, proof: i.proof }));
    },
  });
}
