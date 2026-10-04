// The ways an existing name comes back onto this device (chat builds these; this file is the agreed surface, and chat's version replaces it).
//   recoverIdentity: with the recovery code, box-less (resolve the name, check the code's key is on the chain, make this device's key, sign the "add" op, append, keep).
//   addThisDevice:   this phone's half of "add from another device": a pairing session whose confirm() resolves once this device's key is on the chain and saved.
//   hadIdentity:     a marker (never the key) that this device once held a name, so a phone that lost its key after a restart says so.
import type { PairingSession } from "../api/pairing-session";
import type { WinkCode } from "../api/wink-code";

export type RestoreErrorCode = "not_found" | "not_a_person" | "wrong_code" | "unreachable" | "rate_limited" | "newcomer";

const todo = (message: string): never => { throw Object.assign(new Error(message), { code: "unreachable" }); };

export async function recoverIdentity(_o: { name: string; code: string; password?: string; deviceLabel: string; base?: string }): Promise<{ name: string; id: string }> {
  return todo("recovering a name on this device is not built yet");
}
export function addThisDevice(_code: Extract<WinkCode, { ok: true }>, _o: { deviceLabel: string }): PairingSession {
  return todo("adding this device is not built yet");
}
export async function hadIdentity(): Promise<boolean> { return false; }
