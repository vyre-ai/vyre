// kernel/tasks/approvals.js: the `approvals` provider the gateway's sealing wiring asks (kernel/gateway/sealing.js). An approval is an
// approved task: `seal.use` and `seal.deliver` are unblocked only by a checker's approval of the exact payload that lists the sealed
// slots, and everything the sealing process needs (approver chain, the template and version the person saw, the record, the refs and slots)
// comes from the canonical body the approval covered, never from the caller.

/** @param {{ tasks: { approvalFor(id: string): any } }} cfg */
export function createApprovals(cfg) {
  return Object.freeze({
    /** @param {string} id the approved task's id */
    async get(id) {
      const a = typeof id === "string" ? cfg.tasks.approvalFor(id) : null;
      if (!a) return null;
      const payload = a.body.payload || {};
      const slots = Array.isArray(payload.sealed_slots) ? payload.sealed_slots : [];
      const t = payload.template;
      if (!slots.length || slots.some((/** @type {any} */ s) => typeof s.ref !== "string" || typeof s.slot !== "string") || !t || typeof t.id !== "string" || !Number.isInteger(t.version)) return null;
      const record = slots[0].record;
      if (typeof record !== "string" || slots.some((/** @type {any} */ s) => s.record !== record)) return null;
      return { approver_chain: a.approver_chain, proof: a.use_proof, template: t.id, template_version: t.version, record, doer: a.doer, approved_at: a.approved_at, delivery: payload.delivery || null, template_hash: (a.body.facts && a.body.facts.template && a.body.facts.template.hash) || null, bindings: slots.map((/** @type {any} */ s) => ({ slot: s.slot, ref: s.ref })), payload_hash: a.payload_hash };
    },
  });
}
