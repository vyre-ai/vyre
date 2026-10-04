// The one door the /u screens use to read and write the real box: the box's own tools through
// src/api/box (POST /v1/tools/<name> over the paths layer). The sample data stays for development:
// it is on only when EXPO_PUBLIC_VYRE_MOCK=1; otherwise a screen shows what the box answers, an empty
// state when it has nothing, and an error line when it cannot be reached. Never sample people.

import { call } from "../api/box";
import { peerCall, peerWanted } from "./peer";
import { wantsPasskey } from "./presence-model.js";
import { claimBlocked } from "../../screens/shell/rc";
import { needsPerson, onPhoneFor, reasonLine, softwareKeyLine } from "./on-phone.js";
import { APPROVE_ON_PHONE, actWords, askPhone, endLine, heldApproval, phoneRoute, proofHeader, waitHeld } from "./approvals.js";
import { useApproval } from "./approval-state";
import { Platform } from "react-native";
import { passkeyProof, PresenceError } from "./presence";
import { withSpace } from "./with-space.js";
import { useSpaces } from "../../screens/shell/state";

/** True only in a development build started with EXPO_PUBLIC_VYRE_MOCK=1. */
export const MOCK: boolean = typeof process !== "undefined" && process.env.EXPO_PUBLIC_VYRE_MOCK === "1";

export class BoxError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.code = code;
  }
}

/** One tool call; resolves the data, throws BoxError with the box's own code and words. */
/** The words a screen shows while the phone is asked. */
export const WAITING_TITLE = APPROVE_ON_PHONE;
export async function tool<T = unknown>(name: string, given: Record<string, unknown> = {}): Promise<T> {
  // Every call that acts in a space names it: the one the screen gave, else the one showing (nothing under All spaces).
  const input = withSpace(name, given, useSpaces.getState().space);
  // A device paired to its server over the relay (device-first install) calls it over the peer wire: the server runs the call as this device with its paired session.
  if (peerWanted()) {
    try { return await peerCall<T>(name, input); }
    catch (e) {
      const x = e as { code?: string; message?: string; detail?: unknown };
      // An act held for the owner's yes: the phone approves it, the server runs it, and the result comes back here (no proof is carried by this browser).
      const held = heldApproval(x);
      if (held) return waitOnPhone<T>(held, (t, i) => peerCall<any>(t, i ?? {}));
      throw new BoxError(x.code ?? "error", x.message ?? "");
    }
  }
  let r = await call<T>(name, input).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
  // A kernel act a person signs (a rule, say), asked from the web app: the paired phone approves it ("Approve on your phone"), then the act goes again with the proof it signed.
  if (r.error && Platform.OS === "web" && phoneRoute(name, r.error, input)) {
    const space = typeof input.space === "string" && input.space ? input.space : String(((await call<{ space?: string }>("records.me")).data as { space?: string } | undefined)?.space ?? "");
    const st = useApproval.getState();
    const ask = (t: string, i?: Record<string, unknown>) => call<any>(t, i ?? {}).then((x) => { if (x.error) throw new BoxError(x.error.code ?? "error", x.error.message ?? ""); return x.data; });
    st.show(actWords(name));
    try {
      const out = await askPhone(ask, { tool: name, input, space, signal: st.signal });
      if ("ended" in out) throw new BoxError("not_approved", endLine(out.ended));
      r = await call<T>(name, input, { kernelProof: proofHeader(out.proof) }).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
    } finally { useApproval.getState().hide(); }
  }
  // An act held for the owner's yes (design 6e03707): wait for the phone, then the server's result.
  { const held = r.error ? heldApproval(r.error) : null; if (held) return waitOnPhone<T>(held, async (t, i) => { const x = await call<any>(t, i ?? {}); if (x.error) throw Object.assign(new Error(x.error.message), { code: x.error.code }); return x.data; }); }
  // RC1: a browser does not answer a person-only ask (vault secrets, pairing a device, an outbound send): the person does it in Vyre on their phone.
  if (r.error && claimBlocked() && needsPerson(r.error)) throw new BoxError("on_phone", onPhoneFor(name));
  // A human-only call: the box asks for presence, and in a browser the person's passkey answers it. Once, for this call.
  if (r.error && wantsPasskey(r.error)) {
    try {
      const proof = await passkeyProof(name, input);
      r = await call<T>(name, input, { presence: proof }).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
    } catch (e) {
      if (e instanceof PresenceError) throw new BoxError(e.code, e.message);
      throw e;
    }
  }
  // A presence proof made with a software key (a computer's key file) is refused on a release server: the person approves it on their phone, in our words.
  if (r.error?.code === "software_key") throw new BoxError("software_key", softwareKeyLine());
  // A refused proof on an approval says why in error.detail.reason (expired, replayed, wrong request...): each has its own sentence.
  if (r.error?.code === "needs_presence") {
    const line = reasonLine((r.error as { detail?: { reason?: string } }).detail?.reason);
    if (line) throw new BoxError("needs_presence", line);
  }
  if (r.error) throw new BoxError(r.error.code ?? "error", r.error.message ?? "");
  return r.data as T;
}

/** The sheet "Approve this in Vyre on your phone" with Stop waiting while a held act waits, then its result. */
async function waitOnPhone<T>(held: { id: string; line: string }, ask: (tool: string, input?: Record<string, unknown>) => Promise<any>): Promise<T> {
  const st = useApproval.getState();
  st.show(held.line || softwareKeyLine());
  try {
    const out = await waitHeld(ask, { id: held.id, signal: st.signal });
    if ("ended" in out) throw new BoxError("not_approved", endLine(out.ended));
    return out.result as T;
  } catch (e) {
    if (e instanceof BoxError) throw e;
    const x = e as { code?: string; message?: string };
    throw new BoxError(x.code ?? "error", x.message ?? "");
  } finally { useApproval.getState().hide(); }
}

/** The words to show for a failed call. */
export const said = (e: unknown): string => (e instanceof Error && !(e instanceof BoxError) && typeof (e as { code?: unknown }).code === "string" ? e.message : e instanceof BoxError ? (e.code === "offline" || /no JSON/i.test(e.message) ? "Cannot reach your server right now." : /anonymous callers/i.test(e.message) ? "This browser is not signed in to your server yet. Pair it first." : e.message) : "Something went wrong.");
