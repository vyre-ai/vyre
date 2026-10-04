// @ts-check
// The owner's phone side of "a browser asks to sign in" (wink-2, work/wink-session): the server emits presence.session-asked { id, device, label }; the phone shows "Let <label> sign in" with
// Allow and Don't allow on the same card list as other approvals, and answers presence.person.session-answer { id, yes } (the phone's own call layer adds the owner's presence proof from the
// hardware key). An ask lives 5 minutes. Pure: Node tests it. The words are ours, never the server's.
import { answerRefusal } from "./phone-approve.js";

export const SESSION_ASKED = "presence.session-asked";
export const SESSION_ANSWER = "presence.person.session-answer";
export const ASK_LIFE_MS = 5 * 60_000;

/** @typedef {{ id: string, device: string, label: string, at: number }} SessionAsk */

/** The label a person reads: printable, short, never empty. @param {unknown} s */
const labelOf = (s) => String(s ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 64) || "a browser";

/** The list after one event: a new ask is added once, an expired one is dropped. @param {SessionAsk[]} list @param {{ type?: string, payload?: any }} ev @param {number} now @returns {SessionAsk[]} */
export function withAsk(list, ev, now) {
  const live = list.filter((a) => now - a.at < ASK_LIFE_MS);
  const p = ev && ev.type === SESSION_ASKED ? ev.payload : null;
  if (!p || typeof p.id !== "string" || !p.id || live.some((a) => a.id === p.id)) return live;
  return [...live, { id: p.id, device: String(p.device ?? ""), label: labelOf(p.label), at: now }];
}

/** @param {SessionAsk} a */
export const askTitle = (a) => `Let ${a.label} sign in`;
export const ASK_BODY = "This browser is asking to sign in to your server. If you did not just try that, choose Don't allow.";
export const ALLOW = "Allow";
export const DONT_ALLOW = "Don't allow";
export const allowedToast = "Allowed. The browser can sign in.";
export const refusedToast = "Not allowed. Nothing changed.";

/** Answer one ask. `call` is the phone's call, which adds the presence proof when the box asks. @param {SessionAsk} a @param {boolean} yes @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call */
export async function answerSession(a, yes, call) {
  await call(SESSION_ANSWER, { id: a.id, yes });
  return yes ? allowedToast : refusedToast;
}

/** The words for a failed answer. @param {string | undefined} code */
export function sessionRefusal(code) {
  if (code === "presence_required" || code === "needs_presence") return "That needs your Face ID. Nothing was allowed.";
  if (code === "expired" || code === "none") return "That request ended before you answered.";
  return answerRefusal(code);
}
