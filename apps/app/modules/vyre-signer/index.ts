// The phone's person-session keys (ADR 0027 section 3a): a local Expo module, Android Keystore
// (StrongBox where present) and the iOS Secure Enclave. Only native code imports this; the web
// build never does (src/auth/person.native.ts is its one user).

import { requireNativeModule } from "expo";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha256";
import { b64, b64url, fromB64url, keyIdOf, p1363FromDer, proofBody, proofBytes, spkiFromXY, enrolClientData } from "./presence-proof.js";

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
  appAttestSupported?(): Promise<boolean>;
  appAttestGenerateKey?(): Promise<string>;
  appAttestAttest?(keyId: string, clientDataHash: string): Promise<string>;
  appAttestAssert?(keyId: string, clientDataHash: string): Promise<string>;
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


// ---- The kernel presence proof (iPhone, RC1) ---------------------------------------------------------------------------------------------------------------------
// One function for app-wire and chat: signPresence(card) -> the PresenceProof the kernel's sealing process checks. The key is "vyre.human" (Secure Enclave P-256,
// biometryCurrentSet: Face ID on every signature). Bytes are platform's (kernel/seal/wire.js): see presence-proof.js. Android is not in RC1: it rejects ERR_NOT_IN_RC1.

export type PresenceCard = { op: string; space: string; fields: Record<string, unknown>; payload_hash: string; prompt: string; person?: string };
export type PresenceProof = { signer: "secure_enclave"; key_id: string; payload_hash: string; decision: string; chain_hash: string; issued_at: number; expires_at: number; nonce: string; signature: string; assertion?: string };

const APPATTEST_KEY = "vyre.appattest.keyid";
const ONLY_HERE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** The person id the proof's chain names. app-wire sets it once the identity is known (the identity chain's id, or the box's person); a card may also carry `person`. */
let personProvider: (() => Promise<string | null>) | null = null;
export function setPersonProvider(f: () => Promise<string | null>): void { personProvider = f; }

function iosOnly(): void {
  if (Platform.OS !== "ios") throw Object.assign(new Error("a presence key for this platform is not in RC1"), { code: "ERR_NOT_IN_RC1" });
}

/** The presence key's public half in the form the sealing process enrols: its SPKI (standard base64), the key id and the signer class. Makes the key if missing (no prompt: only signing asks for Face ID). */
export async function presenceKey(): Promise<{ key_id: string; spki: string; signer: "secure_enclave"; storage: "secure-enclave" | "software" }> {
  iosOnly();
  const { x, y } = await ensureKey(HUMAN, { biometric: true });
  const spki = spkiFromXY(fromB64url(x), fromB64url(y));
  return { key_id: keyIdOf(spki), spki: b64(spki), signer: "secure_enclave", storage: info().secureHardware ? "secure-enclave" : "software" };
}

/** Does this device have a presence key already? True when the Secure Enclave key exists (info().level is not "none"). */
export function hasPresenceKey(): boolean { return Platform.OS === "ios" && info().level !== "none"; }

/** Does this build and device do App Attest? False in the simulator and on a device without it. */
export async function appAttestSupported(): Promise<boolean> {
  if (Platform.OS !== "ios" || !native.appAttestSupported) return false;
  try { return await native.appAttestSupported(); } catch { return false; }
}

/**
 * What the enrolment sends beside the key: the App Attest attestation of this key, over the token the sealing process gave (vault's exact bytes: clientDataHash = SHA-256
 * of "vyre-enrol\n" + token + "\n" + the SPKI as base64 text, exactly the `spki` field sent). Null where App Attest is not available (a simulator), and the sealer then sees an
 * unattested key. The App Attest key id is kept in the Keychain, this device only.
 */
export async function enrolAttestation(token: string): Promise<{ format: "apple-appattest"; key_id: string; attestation: string } | null> {
  if (!(await appAttestSupported())) return null;
  const k = await presenceKey();
  const keyId = await native.appAttestGenerateKey!();
  await SecureStore.setItemAsync(APPATTEST_KEY, keyId, ONLY_HERE);
  const attestation = b64(fromB64url(await native.appAttestAttest!(keyId, b64url(enrolClientData(token, k.spki)))));
  return { format: "apple-appattest", key_id: keyId, attestation };
}

/**
 * Sign a card: refuse unless its fields hash to its payload_hash, then Face ID signs the proof bytes (ECDSA P-256, r||s, base64url). Where an App Attest key is enrolled
 * the proof also carries an `assertion` over SHA-256 of the same bytes. The Face ID prompt is titled by the card's own title.
 */
export async function signPresence(card: PresenceCard): Promise<PresenceProof> {
  iosOnly();
  const person = card.person ?? (personProvider ? await personProvider() : null) ?? "";
  const k = await presenceKey();
  const body = proofBody({ op: card.op, space: card.space, fields: card.fields as Record<string, unknown>, payload_hash: card.payload_hash, person }, { keyId: k.key_id, now: Date.now(), nonce: randomBytes(16) });
  const bytes = proofBytes(body);
  const der = await native.sign(HUMAN, new TextDecoder().decode(bytes), card.prompt ? { prompt: card.prompt } : {});
  const proof: PresenceProof = { ...body, signature: b64url(p1363FromDer(fromB64url(der))) };
  const keyId = await SecureStore.getItemAsync(APPATTEST_KEY);
  if (keyId && native.appAttestAssert) {
    proof.assertion = b64(fromB64url(await native.appAttestAssert(keyId, b64url(sha256(bytes)))));
  }
  return proof;
}

/** Where each key lives, said honestly: the identity key is a software Ed25519 seed in the Keychain (this device only); the presence key is in the Secure Enclave on a device and a software key in the simulator. */
export function keyStorage(): { identity: "keychain" | "none"; presence: "secure-enclave" | "software" | "none" | "not-in-rc1" } {
  const level = Platform.OS === "ios" ? info().level : "none";
  return { identity: Platform.OS === "web" ? "none" : "keychain", presence: Platform.OS !== "ios" ? "not-in-rc1" : level === "secure-enclave" ? "secure-enclave" : level === "software" ? "software" : "none" };
}
