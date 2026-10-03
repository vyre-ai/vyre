// kernel/core/gate.js: the shape every kernel call uses to ask `authorize`: allow returns the decision; ask throws what
// is needed (with the decision id and obligations, so the caller can raise the one card); deny looks like absence
// (`not_found`, invariant 8) with the true reason kept on the error and in an `access.denied` event.
import { isChain } from "./chain.js";
import { KernelError } from "./errors.js";

/** @param {{ authorizer: { authorize(i: any): Promise<any> }, log: any }} cfg */
export function createGate(cfg) {
  const { authorizer, log } = cfg;
  /** @param {any} chain @param {string} action @param {string} resource @param {{ quiet?: boolean, presence?: any }} [opts] */
  async function gate(chain, action, resource, opts = {}) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const d = await authorizer.authorize({ chain, action, resource, ...(opts.presence ? { presence: opts.presence } : {}) });
    if (d.effect === "allow") return d;
    if (d.effect === "ask") throw Object.assign(new KernelError(d.reason, `${action} needs ${d.reason === "needs_presence" ? "presence" : "approval"}`), { decision: d.decision, obligations: d.obligations });
    if (!opts.quiet && d.obligations.some((/** @type {any} */ o) => o.type === "audit")) {
      try { log.append(chain, { type: "access.denied", sv: 1, subject: resource, data: { action, reason: d.reason }, prov: { decision: d.decision } }); } catch { /* the refusal stands even if the note cannot be written */ }
    }
    throw Object.assign(new KernelError("not_found", "no such record", d.reason), { decision: d.decision });
  }
  const allowed = async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource) => {
    try { await gate(chain, action, resource, { quiet: true }); return true; } catch { return false; }
  };
  return { gate, allowed };
}
