// Presence in the web build: the person's passkey answering the box's challenge, the way the native build
// answers with its biometric key. A call a box refuses with presence_required, whose methods include
// "passkey", is proved here: POST /v1/presence/challenge bound to the tool and its exact input,
// navigator.credentials.get asks the person (Touch ID, Face ID, Windows Hello, a key), and the call goes
// again carrying the signed proof. Nothing here keeps a proof; each one is for one call.

import { post } from "../api/box";
import { getOptions, passkeyHeader } from "./presence-model.js";

export const canProve = (): boolean => typeof window !== "undefined" && !!(window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential && !!navigator?.credentials;

export class PresenceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The x-vyre-presence header value for one call, from a passkey the person uses now. Throws PresenceError with plain words. */
export async function passkeyProof(tool: string, input: Record<string, unknown>): Promise<string> {
  if (!canProve()) throw new PresenceError("no_passkey", "This browser cannot use a passkey. Use the Vyre app on your phone or computer.");
  const ch = await post("/v1/presence/challenge", { tool, input, method: "passkey" });
  const opts = getOptions(ch);
  if (ch.error || !opts) throw new PresenceError(ch.error?.code ?? "denied", ch.error?.message || "Your server did not offer a passkey for this.");
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({ publicKey: opts as PublicKeyCredentialRequestOptions })) as PublicKeyCredential | null;
  } catch (e) {
    throw new PresenceError("cancelled", (e as Error).name === "NotAllowedError" ? "The passkey was cancelled or timed out." : `The passkey did not work: ${(e as Error).message}`);
  }
  if (!cred) throw new PresenceError("cancelled", "The passkey was cancelled.");
  return passkeyHeader((ch.data as { challenge: string }).challenge, cred);
}
