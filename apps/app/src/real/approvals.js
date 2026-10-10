// @ts-check
// "Approve on your phone" for a kernel act a person signs (platform's core/approvals): the web session cannot prove it, so it asks the box for the act's exact proof request
// (approvals.request, so nothing here hashes anything), opens an ask (approvals.ask), waits for the paired phone to sign it (approvals.status), then sends the act again with the proof.

import { hashMatches } from "./payload-hash.js";
import { MOMENT_OPS, REUSE_OPS } from "../../../../lib/one-yes-ops.js";

/** How each tool the app calls maps to the act the kernel verifies: the call's name and its arguments after the space. Only acts the kernel's proof table covers. @type {Record<string, (i: any) => { call: string, args: any[] } | null>} */
export const ACTS = {
  "rules.define": (i) => ({ call: "ruleSet", args: [i.rule] }),
  "rules.enable": (i) => ({ call: "ruleEnable", args: [i.id] }),
  "rules.disable": (i) => ({ call: "ruleDisable", args: [i.id] }),
  "rules.remove": (i) => ({ call: "ruleRemove", args: [i.id] }),
  "rules.accept": (i) => ({ call: "ruleAccept", args: [i.id] }),
  "rules.dismiss": (i) => ({ call: "ruleDismiss", args: [i.id] }),
  // Members and invites (platform, 5 Oct): the spaces module maps these onto the kernel's calls with the same fields. A temp member or invite carries its scope and end date.
  "spaces.members.set-role": (i) => ({ call: "setRole", args: [{ person: i.person, role: i.role, ...(i.scope ? { scope: i.scope } : {}), ...(i.expires ? { expires: i.expires } : {}) }] }),
  "spaces.members.remove": (i) => ({ call: "removeMember", args: [{ person: i.person }] }),
  "spaces.invites.confirm": (i) => ({ call: "inviteConfirm", args: [i.id, { words: i.words }] }),
  // A named invite (`to`) is resolved to a person by the spaces module before the kernel sees it, which the app cannot reproduce: it has no phone route and says to do it on the phone.
  "spaces.invites.create": (i) => (i.to ? null : { call: "inviteCreate", args: [{ role: i.role, ...(i.scope ? { scope: i.scope } : {}), ...(i.expires ? { expires: i.expires } : {}), ...(i.ttlDays ? { valid_ms: Number(i.ttlDays) * 86_400_000 } : {}) }] }),
};

/** Is this a refusal that the kernel wants the person's own proof, for an act the phone route covers? @param {string} tool @param {{ code?: string } | null | undefined} error @param {any} [input] */
export const phoneRoute = (tool, error, input = {}) => Boolean(error) && ["needs_presence", "presence_required"].includes(String(error?.code)) && Object.hasOwn(ACTS, tool) && ACTS[tool](input) !== null;

/** base64url of the proof object, as x-vyre-kernel-proof takes it (at most 4 KB). @param {unknown} proof */
export function proofHeader(proof) {
  const json = JSON.stringify(proof);
  if (typeof json !== "string" || json.length > 4096) throw new Error("that proof is too large to send");
  const bytes = new TextEncoder().encode(json);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const APPROVE_ON_PHONE = "Approve on your phone";

/** What a web session is asking to do, in words, for the waiting sheet (the phone card shows the box's own body). */
export const ACT_WORDS = {
  "rules.define": "Add or change a rule",
  "rules.enable": "Turn a rule on",
  "rules.disable": "Turn a rule off",
  "rules.remove": "Remove a rule",
  "rules.accept": "Accept a proposed rule",
  "rules.dismiss": "Turn down a proposed rule",
};
/** @param {string} tool */
export const actWords = (tool) => /** @type {Record<string, string>} */ (ACT_WORDS)[tool] ?? "";
export const WAITING_LINE = "Open Vyre on your phone and approve it there. Nothing changes until you do.";

/** The words for how an ask ended. @param {"approved" | "refused" | "none" | "timeout"} state */
export function endLine(state) {
  if (state === "refused") return "You said no on your phone. Nothing changed.";
  if (state === "none") return "The request ended before it was answered. Try again.";
  if (state === "timeout") return "Nobody approved it on your phone in time. Nothing changed.";
  return "";
}

/**
 * Ask, wait, and give back the proof. `call` is the app's one tool call (throws with the box's code), `sleep` and `now` are injected so a test runs without time.
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<any>} call
 * @param {{ tool: string, input: any, space: string, onWaiting?: () => void, signal?: { stopped: boolean }, sleep?: (ms: number) => Promise<void>, now?: () => number, pollMs?: number, limitMs?: number }} o
 * @returns {Promise<{ proof: any } | { ended: "refused" | "none" | "timeout" }>}
 */
export async function askPhone(call, o) {
  const act = ACTS[o.tool]?.(o.input);
  if (!act) throw Object.assign(new Error("that act has no phone approval"), { code: "no_route" });
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const req = await call("approvals.request", { space: o.space, call: act.call, args: act.args });
  if (!hashMatches(req)) throw Object.assign(new Error("the box's proof request does not match its own fields"), { code: "hash_mismatch" });
  const ask = await call("approvals.ask", { op: req.op, space: req.space, fields: req.fields });
  if (ask.payload_hash !== req.payload_hash) throw Object.assign(new Error("the ask is for a different act"), { code: "hash_mismatch" });
  o.onWaiting?.();
  const start = now();
  for (;;) {
    if (o.signal?.stopped) return { ended: "none" };
    const s = await call("approvals.status", { id: ask.id });
    if (s.state === "approved" && s.proof) return { proof: s.proof };
    if (s.state === "refused") return { ended: "refused" };
    if (s.state === "none") return { ended: "none" };
    if (now() - start > (o.limitMs ?? 300_000)) return { ended: "timeout" };
    await sleep(o.pollMs ?? 2000);
  }
}


/** The moment a tool belongs to when it needs the owner's fresh yes: vault secrets (reveal, copy, totp, inject, resolve, render), pairing, and outward send, post, pay, publish, reply, forward. @param {string} tool @returns {"vault" | "pair" | "outward" | null} */
export const momentOf = (tool) => {
  const t = String(tool);
  if (VAULT_TOOLS.has(t)) return "vault";
  if (PAIR_TOOLS.has(t)) return "pair";
  if (/^[a-z][a-z0-9]*\.(send|post|pay|publish|reply|forward)[a-z0-9.-]*$/.test(t)) return "outward";
  return null;
};
// Each moment covers an explicit tool list (wink-2, f0409aa1b); anything else is bad_input at ask, so a floor refusal on another tool is never turned into an ask.
/** A reveal, a copy or a code asks for the five-minute reuse (lib/one-yes.js REUSE_OPS). */
const VAULT_TOOLS = new Set(MOMENT_OPS.vault);
const PAIR_TOOLS = new Set(MOMENT_OPS.pair);

/**
 * An act that needs the owner's yes and carries no approval answers the ordinary floor error `presence_required` on a moment tool (wink-2, f0409aa1b; the earlier `held` answer was withdrawn, and is still
 * read here if a server sends it: detail { moment, request } is exactly what approvals.ask takes). The browser asks the phone, then sends the same act again with the approval id.
 * @param {any} error @param {string} tool @param {Record<string, unknown>} [input]
 * @returns {{ moment: "vault" | "pair" | "outward", request: { op: string, fields: Record<string, any> } } | null}
 */
export const heldAsk = (error, tool, input = {}) => {
  const d = error && error.code === "held" ? error.detail : null;
  if (d && ["pair", "vault", "outward"].includes(d.moment) && d.request && typeof d.request.op === "string") return { moment: d.moment, request: { op: d.request.op, fields: d.request.fields && typeof d.request.fields === "object" ? d.request.fields : {} } };
  // The server names the moment and the exact request it needs approved (0.3.1): ask for that, whatever list this build mirrors.
  if (error && error.code === "presence_required" && ["pair", "vault", "outward"].includes(error.moment) && error.request && typeof error.request.op === "string") return { moment: error.moment, request: { op: error.request.op, fields: error.request.fields && typeof error.request.fields === "object" ? error.request.fields : {} } };
  const moment = momentOf(tool);
  return error && error.code === "presence_required" && moment ? { moment, request: { op: String(tool), fields: input } } : null;
};

/**
 * Ask the owner's phone for the yes (approvals.ask { moment, request } -> { id, expires_in_s, line }), then wait while the phone answers: approvals.status gives { state } and NO proof (the server verifies and spends
 * the phone's proof itself). Resolves { approval } (the id approvals.status names) when approved: the caller retries its act with `approval: <id>` once. Or { ended }.
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<any>} call
 * @param {{ moment: string, request: any, onAsked?: (id: string) => Promise<void> | void, onWaiting?: (line: string) => void, signal?: { stopped: boolean }, sleep?: (ms: number) => Promise<void>, now?: () => number, pollMs?: number, limitMs?: number }} o
 * @returns {Promise<{ approval: string } | { ended: "refused" | "none" | "timeout" }>}
 */
export async function askYes(call, o) {
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const reuse = o.request && REUSE_OPS.includes(o.request.op);
  const ask = await call("approvals.ask", { moment: o.moment, request: o.request, ...(reuse ? { reuse: true } : {}) });
  if (!ask || typeof ask.id !== "string") throw Object.assign(new Error("the ask did not open"), { code: "ask_failed" });
  o.onWaiting?.(typeof ask.line === "string" ? ask.line : "");
  // A browser whose key is a passkey says its own yes: the caller answers the card it just opened. A failure leaves the ask for the phone.
  if (o.onAsked) await Promise.resolve(o.onAsked(ask.id)).catch(() => {});
  const start = now();
  for (;;) {
    if (o.signal?.stopped) return { ended: "none" };
    const s = await call("approvals.status", { id: ask.id });
    if (s.state === "approved") return { approval: typeof s.approval === "string" ? s.approval : ask.id };
    if (s.state === "refused" || s.state === "none" || s.state === "timeout") return { ended: s.state };
    if (now() - start > (o.limitMs ?? 300_000)) return { ended: "timeout" };
    await sleep(o.pollMs ?? 2000);
  }
}
