// The phone's person-session keys (ADR 0027 section 3a): a local Expo module, Android Keystore
// (StrongBox where present) and the iOS Secure Enclave. Only native code imports this; the web
// build never does (src/auth/person.native.ts is its one user).

import { requireNativeModule } from "expo";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha256";
import { b64, b64url, fromB64url, keyIdOf, lowS, p1363FromDer, proofBody, proofBytes, spkiFromXY, enrolClientData } from "./presence-proof.js";

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
  agreePublic?(create: boolean): Promise<string>;
  agree?(epk: string): Promise<string>;
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

/**
 * This phone's agreement key: ECDH on P-256, in the Secure Enclave or the Android Keystore (Android 12 and later), no prompt per use. `agreePublic` is its raw uncompressed point (65 bytes,
 * base64url), made on first use with `create`; `agree(epk)` is the 32-byte shared secret with a peer's point. A phone that cannot hold one rejects, and its identity entry carries no `agree`.
 */
export function agreePublic(create: boolean): Promise<string> {
  if (!native.agreePublic) return Promise.reject(Object.assign(new Error("this build has no agreement key"), { code: "ERR_NO_AGREE" }));
  return native.agreePublic(create);
}
export function agree(epk: string): Promise<string> {
  if (!native.agree) return Promise.reject(Object.assign(new Error("this build has no agreement key"), { code: "ERR_NO_AGREE" }));
  return native.agree(epk);
}

/** `n` bytes from the platform's secure random source, as base64url (Hermes has no getRandomValues). */
export function randomBytes(n: number): string {
  return native.randomBytes(n);
}


// ---- The kernel presence proof (iPhone, RC1) ---------------------------------------------------------------------------------------------------------------------
// One function for app-wire and chat: signPresence(card) -> the PresenceProof the kernel's sealing process checks. The key is "vyre.human" (Secure Enclave P-256,
// biometryCurrentSet: Face ID on every signature). Bytes are platform's (kernel/seal/wire.js): see presence-proof.js. On Android the same proof is signed by the Keystore key (vyre.human, TEE or StrongBox, BiometricPrompt per use) with signer class "strongbox" (the kernel contract's Android class; unattested in RC1).

export type PresenceCard = { op: string; space: string; fields: Record<string, unknown>; payload_hash: string; prompt: string; person?: string };
export type PresenceProof = { signer: "secure_enclave" | "strongbox"; key_id: string; payload_hash: string; decision: string; chain_hash: string; issued_at: number; expires_at: number; nonce: string; signature: string; assertion?: string };

const APPATTEST_KEY = "vyre.appattest.keyid";
const ONLY_HERE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** The person id the proof's chain names. app-wire sets it once the identity is known (the identity chain's id, or the box's person); a card may also carry `person`. */
let personProvider: (() => Promise<string | null>) | null = null;
export function setPersonProvider(f: () => Promise<string | null>): void { personProvider = f; }

/** The signer class the kernel contract names for this platform's key. */
const signerClass = (): "secure_enclave" | "strongbox" => (Platform.OS === "android" ? "strongbox" : "secure_enclave");

/** The iPhone and Android phones have a hardware presence key; the web build does not (a browser answers with a passkey). */
function iosOnly(): void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") throw Object.assign(new Error("a presence key for this platform is not in RC1"), { code: "ERR_NOT_IN_RC1" });
}

/** The presence key's public half in the form the sealing process enrols: its SPKI (standard base64), the key id and the signer class. Makes the key if missing (no prompt: only signing asks for Face ID). */
export async function presenceKey(): Promise<{ key_id: string; spki: string; signer: "secure_enclave" | "strongbox"; storage: "secure-enclave" | "keystore" | "software" }> {
  iosOnly();
  const { x, y } = await ensureKey(HUMAN, { biometric: true });
  const spki = spkiFromXY(fromB64url(x), fromB64url(y));
  return { key_id: keyIdOf(spki), spki: b64(spki), signer: signerClass(), storage: info().secureHardware ? (Platform.OS === "android" ? "keystore" : "secure-enclave") : "software" };
}

/** Does this device have a presence key already? True when the Secure Enclave key exists (info().level is not "none"). */
export function hasPresenceKey(): boolean {
  if (Platform.OS === "android") return info().secureHardware; // the presence key (vyre.human) is made on first use; the phone can hold one when its keystore is in hardware
  return Platform.OS === "ios" && info().level !== "none";
}

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
  // A build signed without the App Attest entitlement (a sideloaded build on a personal team) reports the service as supported and then refuses the key: the presence key stays
  // a Secure Enclave key, unattested, and no assertion is added to proofs. Only the missing entitlement and an unsupported device are treated so; any other failure still throws.
  let keyId: string;
  try { keyId = await native.appAttestGenerateKey!(); } catch (e) {
    const m = String((e as { code?: string; message?: string })?.code ?? "") + " " + String((e as Error)?.message ?? "");
    if (/ERR_APPATTEST|entitlement|not supported|DCError|serverUnavailable|featureUnsupported/i.test(m)) return null;
    throw e;
  }
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
  const body = proofBody({ op: card.op, space: card.space, fields: card.fields as Record<string, unknown>, payload_hash: card.payload_hash, person }, { keyId: k.key_id, now: Date.now(), nonce: randomBytes(16), signer: signerClass() });
  const bytes = proofBytes(body);
  const der = await native.sign(HUMAN, new TextDecoder().decode(bytes), card.prompt ? { prompt: card.prompt } : {});
  const proof: PresenceProof = { ...(body as Omit<PresenceProof, "signature" | "assertion">), signature: b64url(p1363FromDer(fromB64url(der))) };
  const keyId = await SecureStore.getItemAsync(APPATTEST_KEY);
  if (keyId && native.appAttestAssert) {
    proof.assertion = b64(fromB64url(await native.appAttestAssert(keyId, b64url(sha256(bytes)))));
  }
  return proof;
}

/** Where each key lives, said honestly: the identity key is a software Ed25519 seed in the Keychain (this device only); the presence key is in the Secure Enclave on a device and a software key in the simulator. */
export function keyStorage(): { identity: "keychain" | "none"; presence: "secure-enclave" | "keystore" | "software" | "none" } {
  const identity = Platform.OS === "web" ? "none" : "keychain";
  if (Platform.OS === "android") return { identity, presence: info().secureHardware ? "keystore" : "software" };
  const level = Platform.OS === "ios" ? info().level : "none";
  return { identity, presence: level === "secure-enclave" ? "secure-enclave" : level === "software" ? "software" : "none" };
}

/** The Secure Enclave key's public point, raw uncompressed (65 bytes, leading 0x04), base64url: the `enclave` field of this phone's device entry on the identity chain (NK-2). */
export async function enclavePublic(): Promise<string> {
  iosOnly();
  const { x, y } = await ensureKey(HUMAN, { biometric: true });
  const pt = new Uint8Array(65);
  pt[0] = 4; pt.set(fromB64url(x), 1); pt.set(fromB64url(y), 33);
  return b64url(pt);
}

/** The Enclave key's ECDSA P-256 SHA-256 signature over `message`, behind Face ID: the raw 64 bytes r||s with s in the low half, the one form the chain accepts as `esig` (NE-1). */
export async function enclaveSign(message: Uint8Array, prompt: string): Promise<Uint8Array> {
  iosOnly();
  await ensureKey(HUMAN, { biometric: true });
  return lowS(p1363FromDer(fromB64url(await native.sign(HUMAN, new TextDecoder().decode(message), { prompt }))));
}

/** Forget every key of this phone's signer: the presence key, the person (request) key and the App Attest key id. */
export async function wipePresence(): Promise<void> {
  await native.deleteKey(HUMAN);
  await native.deleteKey(PERSON);
  await SecureStore.deleteItemAsync(APPATTEST_KEY, ONLY_HERE);
}
