// One interface for the keys of this device (web build; keys/index.native.ts is the phone's). The browser's identity key is the WebCrypto key in IndexedDB; it has no
// Secure Enclave presence key, so a presence proof from a browser is the passkey path (src/auth/person.web.ts), not this.

import { createIdentityKey, hasIdentity, identityKey, forgetIdentity } from "../identity/store";
import { macDeviceKey, macKeyAvailable } from "../identity/mac-key.ts";

export type KeyStorage = { identity: "webcrypto-indexeddb" | "software-indexeddb" | "mac-keychain" | "none"; presence: "passkey" | "none" | "not-in-rc1" | "secure-enclave" | "keystore" | "software" };
export type { PresenceCard, PresenceProof } from "../../modules/vyre-signer/index";

export { createIdentityKey };
/** Sign an identity-chain operation with the device key. @throws when there is no key. */
export async function signIdentityOp(message: Uint8Array): Promise<Uint8Array> {
  const k = await identityKey();
  if (!k) throw Object.assign(new Error("no identity key on this device"), { code: "ERR_NO_KEY" });
  return k.sign(message);
}
/** The Mac app's window hands recovery its own key (the seed stays in the Keychain); a browser makes one in the call. */
export const recoveryKeyOptions = async (): Promise<{ enclave?: string; requireEnclave?: boolean; key?: NonNullable<Awaited<ReturnType<typeof macDeviceKey>>> }> => {
  const key = macKeyAvailable() ? await macDeviceKey(true) : null;
  return key ? { key } : {};
};
export async function hasKeys(): Promise<{ identity: boolean; presence: boolean }> { return { identity: await hasIdentity(), presence: false }; }
export async function wipeKeys(): Promise<void> { await forgetIdentity(); }
export async function keyStorage(): Promise<KeyStorage> {
  const k = await identityKey();
  return { identity: !k ? "none" : macKeyAvailable() ? "mac-keychain" : k.software ? "software-indexeddb" : "webcrypto-indexeddb", presence: "passkey" };
}
const notOnWeb = (): never => { throw Object.assign(new Error("a browser answers presence with a passkey, not this key"), { code: "ERR_NOT_ON_WEB" }); };
export const signPresence = async (_card: import("../../modules/vyre-signer/index").PresenceCard): Promise<import("../../modules/vyre-signer/index").PresenceProof> => notOnWeb();
export const presenceKey = async (): Promise<Awaited<ReturnType<typeof import("../../modules/vyre-signer/index").presenceKey>>> => notOnWeb();
export const enclavePublic = async (): Promise<string> => notOnWeb();
export const enrolAttestation = async (_token: string): Promise<null> => null;
export const setPersonProvider = (_f: () => Promise<string | null>): void => {};
export const signListChange = async (_m: Uint8Array, _prompt: string): Promise<{ sig: Uint8Array; esig: Uint8Array }> => notOnWeb();
export const listChangeSigners = (_prompt: string): { sign: (m: Uint8Array) => Promise<Uint8Array>; esign: (m: Uint8Array) => Promise<Uint8Array> } => notOnWeb();
