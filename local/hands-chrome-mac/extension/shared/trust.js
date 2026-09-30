// @ts-check
// trust: what a caller has been APPROVED for, kept apart from what it ASKS for. Approvals (asked, writeOk, a release signature, the module's write budget)
// travel in a separate object the host fills from the real caller; they are never in `args`, and an args value that carries one of these keys at any depth is refused.

/** @typedef {{ asked?: boolean, writeOk?: boolean, release?: { sig?: string, signature?: string }, diag?: boolean, writeBudget?: { create?: number, edit?: number, origin?: string, tab?: number, tabOrigin?: string } }} Trust */
/** Keys that mean "approved". They may appear in trust only. */
export const TRUST_KEYS = Object.freeze(["asked", "writeOk", "release", "writeBudget", "diag"]);
/** The trust the host sent, cut down to what it may contain. @param {any} t @returns {Trust} */
export function cleanTrust(t) {
  if (!t || typeof t !== "object") return {};
  const out = /** @type {Trust} */ ({});
  if (t.asked === true) out.asked = true;
  if (t.diag === true) out.diag = true; // the harness only: the guard's diagnostics go to the stage, never back to a model
  if (t.writeOk === true) out.writeOk = true;
  if (t.release && typeof t.release === "object") out.release = { ...(typeof t.release.sig === "string" ? { sig: t.release.sig.slice(0, 200) } : {}), ...(typeof t.release.signature === "string" ? { signature: t.release.signature.slice(0, 200) } : {}) };
  if (t.writeBudget && typeof t.writeBudget === "object") out.writeBudget = { create: Math.max(0, Math.floor(Number(t.writeBudget.create) || 0)), edit: Math.max(0, Math.floor(Number(t.writeBudget.edit) || 0)), ...(typeof t.writeBudget.origin === "string" ? { origin: t.writeBudget.origin.slice(0, 200) } : {}), ...(Number.isInteger(t.writeBudget.tab) ? { tab: t.writeBudget.tab } : {}), ...(typeof t.writeBudget.tabOrigin === "string" ? { tabOrigin: t.writeBudget.tabOrigin.slice(0, 200) } : {}) };
  return out;
}
/**
 * The first approval key found where an op could READ one: the top-level keys of args and, for a batch, the top-level keys of each step's args. Never inside an
 * api.call body, a query or a headers object: those are opaque data sent to the site (a real API field may be called "agent" or "release"), and no op reads an
 * approval from inside them (a hygiene test keeps that true).
 * @param {any} args @returns {string}
 */
export function trustKeyIn(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  for (const k of Object.keys(args)) if (TRUST_KEYS.includes(k)) return k;
  if (Array.isArray(args.steps)) for (const st of args.steps) { const a = st && typeof st === "object" ? st.args : null; if (a && typeof a === "object" && !Array.isArray(a)) for (const k of Object.keys(a)) if (TRUST_KEYS.includes(k)) return k; }
  return "";
}
