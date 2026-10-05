// The relay path on the phone (relay.d.ts): Hermes has no WebCrypto X25519, so the Noise
// handshake runs on @noble (relay/client/noble.js) with randomness from vyre-signer, and the
// device key is 32 raw bytes in the secure store, this device only (never in a backup, so a
// restored phone pairs again). The presence key is vyre-signer's "vyre.person" (ES256).

import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { gcm } from "@noble/ciphers/aes";
import { nobleCrypto } from "@vyre/relay-client/noble.js";
import { base64url, fromBase64url } from "@vyre/relay-client/bytes.js";
import * as Keys from "../../modules/vyre-signer";
import { keyStorage } from "../native/presence-model";
import { fromB64url, spkiFromXY } from "../auth/person.ts"; // the explicit file: "../auth/person" resolves to person.native.ts on the phone, which exports neither
import { readPairing, type Pairing } from "./pairing";

const KEY = "vyre.relay.key";
const PAIRING = "vyre.relay.pairing";
const ONLY_HERE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const randomBytes = (n: number) => fromB64url(Keys.randomBytes(n));

// Hermes has no crypto.getRandomValues; relay/client's paths uses it for an Idempotency-Key.
const g = globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView | null>(a: T) => T } };
if (!g.crypto?.getRandomValues) {
  g.crypto = g.crypto ?? {};
  g.crypto.getRandomValues = (a) => {
    if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(randomBytes(a.byteLength));
    return a;
  };
}

let provider: ReturnType<typeof nobleCrypto> | null = null;
export const relayCrypto = () => (provider ??= nobleCrypto({ x25519, sha256, hmac, gcm, randomBytes }));

export function relayKeyStore() {
  const crypto = relayCrypto();
  return {
    async get() {
      const raw = await SecureStore.getItemAsync(KEY, ONLY_HERE);
      return raw ? crypto.importKeyPair(fromBase64url(raw)) : null;
    },
    async set(k: { privateKey: Uint8Array }) {
      await SecureStore.setItemAsync(KEY, base64url(k.privateKey), ONLY_HERE);
    },
  };
}

export async function presenceKey(): Promise<{ public_key: string; alg: number; storage?: "hardware" | "software" } | undefined> {
  try {
    // The biometric-bound key, so every presence proof over the relay needs a fingerprint or face
    // (e2e: the pairing's presence key is vyre.human).
    const { x, y } = await Keys.ensureKey(Keys.HUMAN, { biometric: true });
    // Where the key was made, from the platform's own key API (Secure Enclave on iOS, StrongBox or the TEE on Android); left out when it cannot say.
    let storage: "hardware" | "software" | undefined;
    try {
      const i = Keys.info();
      // info().level describes vyre.person, which may not exist yet; then the phone's own answer about its keystore decides.
      storage = i.level === "none" ? (i.secureHardware ? "hardware" : "software") : keyStorage(i.level);
    } catch { /* unknown */ }
    return { public_key: spkiFromXY(x, y), alg: -7, ...(storage ? { storage } : null) };
  } catch {
    return undefined;
  }
}

export const about = { kind: "app" as const };

export const deviceName = () => (Platform.OS === "ios" ? "Vyre on iPhone" : "Vyre on Android");

/** Hidden unless the app is in front: relay/client stops keeping alive and reconnects on return. */
export const visibility = {
  hidden: () => AppState.currentState !== "active",
  on(fn: () => void) {
    const sub = AppState.addEventListener("change", fn);
    return () => sub.remove();
  },
};

/** expo/fetch streams a response body, which React Native's own fetch does not (the event stream needs it). */
export const directFetch = expoFetch as unknown as typeof fetch;

export async function loadPairing(): Promise<Pairing | null> {
  try {
    return readPairing(await SecureStore.getItemAsync(PAIRING, ONLY_HERE));
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing | null): Promise<void> {
  try {
    if (p) await SecureStore.setItemAsync(PAIRING, JSON.stringify(p), ONLY_HERE);
    else await SecureStore.deleteItemAsync(PAIRING, ONLY_HERE);
  } catch {}
}
