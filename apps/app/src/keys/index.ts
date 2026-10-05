// One interface for the keys of this device (web build; keys/index.native.ts is the phone's). The browser's identity key is the WebCrypto key in IndexedDB; it has no
// Secure Enclave presence key, so a presence proof from a browser is the passkey path (src/auth/person.web.ts), not this.

import { createIdentityKey, hasIdentity, identityKey, forgetIdentity } from "../identity/store";
import { macDeviceKey, macEnclavePublic, macKeyAvailable, macSignListChange, shellKeyHeld } from "../identity/mac-key.ts";
import { agreePublic } from "../identity/agree.ts";

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
export const recoveryKeyOptions = async (): Promise<{ enclave?: string; requireEnclave?: boolean; agree?: string; held?: boolean; key?: NonNullable<Awaited<ReturnType<typeof macDeviceKey>>> }> => {
  // a browser has no Mac key, but its agreement key still goes in the entry (the one that opens its chats)
  if (!macKeyAvailable()) { const agree = (await agreePublic(true)) ?? undefined; return agree ? { agree } : {}; }
  const key = await macDeviceKey(true);
  if (!key) return {};
  const enclave = await macEnclavePublic(true); // a Mac with no Secure Enclave keeps an entry that signs alone
  const agree = (await agreePublic(true)) ?? undefined;
  const held = await shellKeyHeld();
  return { key, ...(enclave ? { enclave } : {}), ...(agree ? { agree } : {}), ...(held ? { held: true } : {}) };
};
export async function hasKeys(): Promise<{ identity: boolean; presence: boolean }> { return { identity: await hasIdentity(), presence: macKeyAvailable() && (await macEnclavePublic(false)) !== null }; }
export async function wipeKeys(): Promise<void> { await forgetIdentity(); }
export async function keyStorage(): Promise<KeyStorage> {
  const k = await identityKey();
  return { identity: !k ? "none" : macKeyAvailable() ? "mac-keychain" : k.software ? "software-indexeddb" : "webcrypto-indexeddb", presence: macKeyAvailable() && (await macEnclavePublic(false)) !== null ? "secure-enclave" : "passkey" };
}
const notOnWeb = (): never => { throw Object.assign(new Error("a browser answers presence with a passkey, not this key"), { code: "ERR_NOT_ON_WEB" }); };
export const signPresence = async (_card: import("../../modules/vyre-signer/index").PresenceCard): Promise<import("../../modules/vyre-signer/index").PresenceProof> => notOnWeb();
export const presenceKey = async (): Promise<Awaited<ReturnType<typeof import("../../modules/vyre-signer/index").presenceKey>>> => notOnWeb();
export const enclavePublic = async (): Promise<string> => {
  if (!macKeyAvailable()) return notOnWeb();
  const p = await macEnclavePublic(true);
  if (!p) throw Object.assign(new Error("This Mac has no Secure Enclave key."), { code: "ERR_NO_ENCLAVE" });
  return p;
};
export const enrolAttestation = async (_token: string): Promise<null> => null;
export const setPersonProvider = (_f: () => Promise<string | null>): void => {};
export const signListChange = async (m: Uint8Array, prompt: string): Promise<{ sig: Uint8Array; esig: Uint8Array }> => {
  if (!macKeyAvailable()) return notOnWeb();
  const r = await macSignListChange(m, prompt);
  if (!r.esig) throw Object.assign(new Error("This Mac has no Secure Enclave key to sign with."), { code: "ERR_NO_ENCLAVE" });
  return { sig: r.sig, esig: r.esig };
};
/** The `sign` and `esign` chain.js makeOp takes for a list change from this Mac: one Touch ID covers both for the same message. */
export function listChangeSigners(prompt: string): { sign: (m: Uint8Array) => Promise<Uint8Array>; esign: (m: Uint8Array) => Promise<Uint8Array> } {
  if (!macKeyAvailable()) return notOnWeb();
  let last: { m: Uint8Array; done: ReturnType<typeof macSignListChange> } | null = null;
  const both = (m: Uint8Array) => {
    if (!last || last.m.length !== m.length || last.m.some((x, i) => x !== m[i])) last = { m, done: macSignListChange(m, prompt) };
    return last.done;
  };
  return { sign: async (m) => (await both(m)).sig, esign: async (m) => { const r = await both(m); if (!r.esig) throw Object.assign(new Error("no enclave key"), { code: "ERR_NO_ENCLAVE" }); return r.esig; } };
}
