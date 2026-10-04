// One interface for the keys of this phone, for app-wire and chat (PD-A). Where each lives, said honestly:
//   identity key  Ed25519 software seed, Keychain item this device only (WHEN_UNLOCKED_THIS_DEVICE_ONLY), no biometric: it signs the device's own chain operations.
//   presence key  P-256 in the Secure Enclave (vyre.human), Face ID on every signature; in the simulator a software key, and keyStorage() says "software".
//   Android       the presence key is not in RC1 (signPresence rejects ERR_NOT_IN_RC1); the identity seed is in the Keystore-backed secure store like iOS's Keychain.

import { Platform } from "react-native";
import { createIdentityKey, hasIdentity, identityKey, forgetIdentity } from "../identity/store.native";
import * as Signer from "../../modules/vyre-signer";

export type { PresenceCard, PresenceProof } from "../../modules/vyre-signer";
export type KeyStorage = { identity: "keychain" | "none"; presence: "secure-enclave" | "software" | "none" | "not-in-rc1" };

export { createIdentityKey };
export const { signPresence, presenceKey, enrolAttestation, setPersonProvider, enclavePublic } = Signer;

/** Sign an identity-chain operation (bytes) with the device's Ed25519 key. @throws ERR_NO_KEY when there is none. */
export async function signIdentityOp(message: Uint8Array): Promise<Uint8Array> {
  const k = await identityKey();
  if (!k) throw Object.assign(new Error("no identity key on this device"), { code: "ERR_NO_KEY" });
  return k.sign(message);
}

/**
 * Sign a change to who speaks for this identity (add or remove a device, replace the recovery code, change the space owner): the Ed25519 seed signs it AND the Secure Enclave key signs
 * the same bytes behind Face ID (NK-2: the chain refuses such a change from a phone without `esig`). Pass the result to chain.js makeOp as sign and esign. Face ID is asked once.
 */
export async function signListChange(message: Uint8Array, prompt: string): Promise<{ sig: Uint8Array; esig: string }> {
  const sig = await signIdentityOp(message);
  const esig = await Signer.enclaveSign(message, prompt);
  return { sig, esig };
}

/**
 * What recoverIdentity / claimIdentity need from this device so its new entry carries the Secure Enclave key (RX-1, NK-2): on an iPhone `{ enclave, requireEnclave: true }` (the call refuses
 * rather than make a phone entry whose seed alone could change the list; no Face ID or no enrolled face means no enclave key, and the error says so); elsewhere nothing.
 */
export async function recoveryKeyOptions(): Promise<{ enclave?: string; requireEnclave?: boolean }> {
  if (Platform.OS !== "ios") return {};
  try { return { enclave: await Signer.enclavePublic(), requireEnclave: true }; } catch (e) {
    throw Object.assign(new Error("Set up Face ID or Touch ID on this iPhone, then try again."), { code: "no_biometrics", cause: e });
  }
}

export async function hasKeys(): Promise<{ identity: boolean; presence: boolean }> {
  return { identity: await hasIdentity(), presence: Signer.hasPresenceKey() };
}

/** Forget both keys on this phone. The recovery code is the way back to the name. */
export async function wipeKeys(): Promise<void> {
  await forgetIdentity();
  await Signer.wipePresence();
}

export async function keyStorage(): Promise<KeyStorage> {
  const s = Signer.keyStorage();
  return { identity: (await hasIdentity()) ? "keychain" : "none", presence: s.presence };
}
