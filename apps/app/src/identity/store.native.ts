// Where the phone keeps the identity it made (PD-A). The public record (name, id, chain, pin) and the Ed25519 device seed are two Keychain items, this device only
// (kSecAttrAccessibleWhenUnlockedThisDeviceOnly: never in a backup, never synced, so a restored phone claims or pairs again; the recovery code is the way back). Neither is
// biometric: the identity key signs the device's own chain operations and must not nag; every human-only act is signed by the Secure Enclave presence key behind Face ID.
// The seed is a software Ed25519 key because the Secure Enclave has no Ed25519 and Hermes has no WebCrypto Ed25519 (docs/work/native-core.md, "The iPhone's keys").
// Replaces the in-memory fallback of store.ts on a phone. The same signatures as store.ts.

import * as SecureStore from "expo-secure-store";
import { fromSeed, restoreDeviceKey, type DeviceKey } from "./keys.js";
import { b64, fromB64url } from "../../modules/vyre-signer/presence-proof.js";
import type { KeptIdentity } from "./store";

export type { KeptIdentity };

const RECORD = "vyre.identity.record";
const SEED = "vyre.identity.seed";
const ONLY_HERE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function saveIdentity(i: { name: string; id: string; eid: string; ops: unknown[]; pin: KeptIdentity["pin"]; key: DeviceKey }): Promise<void> {
  const kept = i.key.keep() as { kind: string; seed?: Uint8Array };
  if (kept.kind !== "seed" || !kept.seed) throw new Error("the phone keeps only a seed key");
  const rec = { name: i.name, id: i.id, eid: i.eid, ops: i.ops, pin: i.pin, software: i.key.software, createdAt: Date.now() };
  // The seed first: a record with no key to go with it is the state to avoid, the other way round is harmless.
  await SecureStore.setItemAsync(SEED, b64(kept.seed), ONLY_HERE);
  await SecureStore.setItemAsync(RECORD, JSON.stringify(rec), ONLY_HERE);
}

export async function loadIdentity(): Promise<(KeptIdentity & { key: DeviceKey }) | null> {
  const [raw, seed] = await Promise.all([SecureStore.getItemAsync(RECORD, ONLY_HERE), SecureStore.getItemAsync(SEED, ONLY_HERE)]);
  if (!raw || !seed) return null;
  const rec = JSON.parse(raw) as Omit<KeptIdentity, "kept">;
  const key = await restoreDeviceKey({ kind: "seed", seed: fromB64url(seed) });
  return { ...rec, kept: { kind: "seed" }, key };
}

/** Make the Ed25519 device key and put its seed in the Keychain at once, before any claim: a restart between claiming and saving the record then keeps the key. Returns the key to claim with. */
export async function createIdentityKey(): Promise<DeviceKey> {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  await SecureStore.setItemAsync(SEED, b64(seed), ONLY_HERE);
  return fromSeed(seed);
}

/** The key kept in the Keychain, or null. */
export async function identityKey(): Promise<DeviceKey | null> {
  const seed = await SecureStore.getItemAsync(SEED, ONLY_HERE);
  return seed ? fromSeed(fromB64url(seed)) : null;
}

/** Is there an identity key on this phone? */
export async function hasIdentity(): Promise<boolean> {
  return Boolean(await SecureStore.getItemAsync(SEED, ONLY_HERE));
}

/** Forget the identity key and record (a claim that did not go through, or signing out of this name on this phone). The recovery code, kept by the person, is what makes a new one. */
export async function forgetIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(RECORD, ONLY_HERE);
  await SecureStore.deleteItemAsync(SEED, ONLY_HERE);
}
