// @ts-check
// trust: what a caller has been APPROVED for, kept apart from what it ASKS for. Approvals (asked, writeOk, a release signature, the module's write budget)
// travel in a separate object the host fills from the real caller; they are never in `args`, and an args value that carries one of these keys at any depth is refused.

/** @typedef {{ asked?: boolean, writeOk?: boolean, release?: { sig?: string, signature?: string }, writeBudget?: { create?: number, edit?: number, origin?: string } }} Trust */
/** Keys that mean "approved". They may appear in trust only. */
export const TRUST_KEYS = Object.freeze(["asked", "writeOk", "release", "writeBudget", "agent"]);
/** The trust the host sent, cut down to what it may contain. @param {any} t @returns {Trust} */
export function cleanTrust(t) {
  if (!t || typeof t !== "object") return {};
  const out = /** @type {Trust} */ ({});
  if (t.asked === true) out.asked = true;
  if (t.writeOk === true) out.writeOk = true;
  if (t.release && typeof t.release === "object") out.release = { ...(typeof t.release.sig === "string" ? { sig: t.release.sig.slice(0, 200) } : {}), ...(typeof t.release.signature === "string" ? { signature: t.release.signature.slice(0, 200) } : {}) };
  if (t.writeBudget && typeof t.writeBudget === "object") out.writeBudget = { create: Math.max(0, Math.floor(Number(t.writeBudget.create) || 0)), edit: Math.max(0, Math.floor(Number(t.writeBudget.edit) || 0)), ...(typeof t.writeBudget.origin === "string" ? { origin: t.writeBudget.origin.slice(0, 200) } : {}) };
  return out;
}
/** The first approval key found in an args value, at any depth, or "". @param {any} v @param {number} [d] */
export function trustKeyIn(v, d = 0) {
  if (!v || typeof v !== "object" || d > 16) return "";
  if (Array.isArray(v)) { for (const x of v) { const k = trustKeyIn(x, d + 1); if (k) return k; } return ""; }
  for (const [k, x] of Object.entries(v)) { if (TRUST_KEYS.includes(k)) return k; const f = trustKeyIn(x, d + 1); if (f) return f; }
  return "";
}

