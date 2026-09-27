// @ts-check
// needs-credential: the one shape of "this needs a key first" (ADR 0028, decision 9b). A module
// that cannot act on a connection because a vault item is missing or not granted answers with
// { code: "needs_credential", message, detail: { module, need, account? } }, so every surface can
// offer the same fix: vault.connect { module, need }. Pure, with no feature state, so any part
// may import it from the kernel.

/**
 * @typedef {{ module: string, need: string, account?: string }} NeedDetail
 * @typedef {{ code: "needs_credential", message: string, detail: NeedDetail }} NeedsCredential
 */

/**
 * The plain object, for a tool result or an error body.
 * @param {NeedDetail} detail @param {string} [message]
 * @returns {NeedsCredential}
 */
export function needsCredential({ module, need, account }, message) {
  const m = String(module ?? "").slice(0, 64), n = String(need ?? "").slice(0, 64);
  const a = account === undefined || account === null ? undefined : String(account).slice(0, 200);
  return {
    code: "needs_credential",
    message: message ? String(message).slice(0, 500) : `${m} needs ${n}${a ? ` for ${a}` : ""} from the Vault first · vyre vault connect ${m} ${n}`,
    detail: { module: m, need: n, ...(a ? { account: a } : {}) },
  };
}

/**
 * The same as an Error to throw from a tool: the registry passes `code` through, and `detail`
 * rides along for callers in-process.
 * @param {NeedDetail} detail @param {string} [message]
 */
export function needsCredentialError(detail, message) {
  const n = needsCredential(detail, message);
  return Object.assign(new Error(n.message), { code: n.code, detail: n.detail });
}

/** Whether an error or result body is this shape. @param {any} e */
export const isNeedsCredential = e => Boolean(e && e.code === "needs_credential" && e.detail && typeof e.detail.module === "string" && typeof e.detail.need === "string");
