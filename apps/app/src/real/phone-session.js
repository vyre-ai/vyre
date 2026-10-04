// @ts-check
// A paired browser's session at the phone's strength: before the browser starts its session for an admin act, it asks the owner's phone to approve it. Tool names are wink-2's to confirm
// (presence.person.session-ask files the ask, presence.person.session-status answers it); on approved the server holds the one-use grant, and the browser's ordinary startPaired follows.
// `call` is the paired channel's call (no session needed). Time is injected so a test runs without waiting. The words are ours, never the server's.
import { endLine } from "./approvals.js";

export const SESSION_ASK = "presence.person.session-ask";
export const SESSION_STATUS = "presence.person.session-status";
export const WAITING_SESSION = "Open Vyre on your phone and approve it there. Nothing changes until you do.";

/** @param {{ error?: { code?: string } }} r */
const refused = (r) => Object.assign(new Error(r.error?.code === "no_such_tool" ? "Your server cannot ask your phone yet. Update it, then try again." : "Your phone could not be asked. Nothing changed."), { code: r.error?.code === "no_such_tool" ? "server_too_old" : "ask_failed" });

/**
 * @param {(tool: string, input: Record<string, unknown>) => Promise<{ data?: any, error?: { code?: string, message?: string } }>} call
 * @param {{ onWaiting?: () => void, signal?: { stopped: boolean }, sleep?: (ms: number) => Promise<void>, now?: () => number, pollMs?: number, limitMs?: number }} [o]
 * @returns {Promise<{ approved: true } | { ended: "refused" | "none" | "timeout" }>}
 */
export async function askPhoneForSession(call, o = {}) {
  const sleep = o.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const ask = await call(SESSION_ASK, {});
  if (ask.error || !ask.data || !ask.data.id) throw refused(ask);
  o.onWaiting?.();
  const start = now();
  for (;;) {
    if (o.signal?.stopped) return { ended: "none" };
    const s = await call(SESSION_STATUS, { id: String(ask.data.id) });
    if (s.error) throw refused(s);
    const state = s.data?.state;
    if (state === "approved") return { approved: true };
    if (state === "refused" || state === "none" || state === "timeout") return { ended: state };
    if (now() - start > (o.limitMs ?? 300_000)) return { ended: "timeout" };
    await sleep(o.pollMs ?? 2000);
  }
}

/** The sentence for an ended ask. @param {"refused" | "none" | "timeout"} state */
export const sessionEndLine = (state) => endLine(state);
