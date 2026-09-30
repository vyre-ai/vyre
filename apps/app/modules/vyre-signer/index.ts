// The phone's person-session keys (ADR 0027 section 3a): a local Expo module, Android Keystore
// (StrongBox where present) and the iOS Secure Enclave. Only native code imports this; the web
// build never does (src/auth/person.native.ts is its one user).

import { requireNativeModule } from "expo";

/** Signs every request's x-vyre-proof; no user auth. */
export const PERSON = "vyre.person";
/** Signs HUMAN_ONLY calls; each signature asks for a strong biometric. */
export const HUMAN = "vyre.human";

export type Alias = typeof PERSON | typeof HUMAN;

/**
 * Error codes the native side rejects with (error.code):
 *   ERR_NO_KEY           no key under that alias: call ensureKey
 *   ERR_NO_BIOMETRICS    a biometric key needs a screen lock and an enrolled finger or face
 *   ERR_KEY_INVALIDATED  the enrolled biometrics changed: deleteKey, ensureKey, sign in again
 *   ERR_CANCELED         the person closed the prompt
 *   ERR_BIOMETRIC        the prompt failed (locked out, no hardware)
 *   ERR_NO_ACTIVITY      Android: the prompt needs the app in front
 *   ERR_KEYGEN, ERR_SIGN the platform refused
 */
export type SignerErrorCode =
  | "ERR_NO_KEY"
  | "ERR_NO_BIOMETRICS"
  | "ERR_KEY_INVALIDATED"
  | "ERR_CANCELED"
  | "ERR_BIOMETRIC"
  | "ERR_NO_ACTIVITY"
  | "ERR_KEYGEN"
  | "ERR_SIGN";

export type SignerInfo = {
  /** Android: the phone has a StrongBox keystore. Always false on iOS. */
  strongBox: boolean;
  /** Keys live in secure hardware (TEE, StrongBox, Secure Enclave). False in the iOS simulator. */
  secureHardware: boolean;
  /** Where vyre.person lives now: "strongbox", "tee", "secure-enclave", "software", or "none". */
  level: string;
};

type Native = {
  ensureKey(alias: string, options: { biometric: boolean }): Promise<{ x: string; y: string }>;
  sign(alias: string, message: string, options: { prompt?: string }): Promise<string>;
  deleteKey(alias: string): Promise<boolean>;
  info(): SignerInfo;
  randomBytes(n: number): string;
};

const native = requireNativeModule<Native>("VyreSigner");

/** Make the key under `alias` if it is missing; its public point as base64url x and y (32 bytes each). */
export function ensureKey(alias: Alias, options: { biometric?: boolean } = {}): Promise<{ x: string; y: string }> {
  return native.ensureKey(alias, { biometric: options.biometric ?? alias === HUMAN });
}

/** ES256 over the UTF-8 message: the DER signature as base64url. `prompt` titles the biometric prompt. */
export function sign(alias: Alias, message: string, options: { prompt?: string } = {}): Promise<string> {
  return native.sign(alias, message, options.prompt ? { prompt: options.prompt } : {});
}

/** Delete the key; true when there was one. */
export function deleteKey(alias: Alias): Promise<boolean> {
  return native.deleteKey(alias);
}

export function info(): SignerInfo {
  return native.info();
}

/** `n` bytes from the platform's secure random source, as base64url (Hermes has no getRandomValues). */
export function randomBytes(n: number): string {
  return native.randomBytes(n);
}
