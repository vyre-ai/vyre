// The key a paired device signs its session start with, and where it keeps the token (web build; paired-key.native.ts is the phone's). A browser signs with its own WebCrypto
// person key (the one it reported at pairing, software), and keeps the token where webPerson reads it.
import { keepToken, personKey } from "./person.web";

export type PairedKey = {
  /** ES256 over the message, raw 64 bytes r||s. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** Keep the session token where this device's box client reads it. `route` names the paired server (the phone keys its store by it). */
  keep(route: string, token: string): Promise<void>;
};

export async function pairedKey(): Promise<PairedKey> {
  const k = await personKey();
  return {
    sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, m as BufferSource)),
    keep: (_route, token) => keepToken(location.origin, token),
  };
}
