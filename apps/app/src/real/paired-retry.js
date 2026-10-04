// @ts-check
// An admin act (records.define and the like) on a server-hosted space from a paired device: when the home answers needs_presence because this device has no live paired session, the device
// starts one with its key (links.startPaired: pair-challenge, sign, start-paired) and makes the call again ONCE (wink-2, work/wink-session 7120f5b64; lead's ruling ea835cb). A needs_presence that
// carries error.detail.reason is a refused approval proof (vault), not a missing session, so it is left alone for reasonLine. The words are ours, never the server's.
import { reasonLine } from "./on-phone.js";
import { renewWords } from "../auth/notice.js";

/** Is this refusal "no live paired session"? @param {any} e */
export const isNoSession = (e) => Boolean(e) && e.code === "needs_presence" && !(e.detail && e.detail.reason);

/**
 * @param {{ call: () => Promise<any>, renew: () => Promise<boolean>, failure: () => ("denied" | "unreachable" | "other" | null), how?: "touchid" | "phone" }} o
 * @returns {Promise<any>}
 */
export async function withPairedSession(o) {
  try { return await o.call(); }
  catch (e) {
    if (!isNoSession(e)) throw e;
    if (!(await o.renew())) throw Object.assign(new Error(renewWords(o.failure() ?? "other")), { code: "session_refused" });
    try { return await o.call(); }
    catch (e2) {
      // Still no session after a good start: the act itself needs the person's own approval.
      if (isNoSession(e2)) throw Object.assign(new Error(reasonLine("no_proof", o.how) || ""), { code: "needs_presence" });
      throw e2;
    }
  }
}
