// Where the phone keeps the identity it made (PD-A, reviewer-3's NK-1 to NK-6). All of it is Keychain, this device only (kSecAttrAccessibleWhenUnlockedThisDeviceOnly: never in a
// backup, never synced), in the app's own default access group; the app declares no keychain-access-groups and shares nothing with any other app.
//   vyre.identity.seed     the Ed25519 device seed (32 bytes, base64). Software key: the Secure Enclave has no Ed25519 and Hermes has no WebCrypto Ed25519.
//   vyre.identity.record   small: name, id, eid, pin, software, createdAt.
//   vyre.identity.ops.N    the public chain, in chunks of CHUNK characters (a Keychain value is warned at 2048 bytes, and a chain grows), and vyre.identity.ops.n their count.
// Neither the seed nor the record is biometric: the identity key signs the device's own chain operations and must not nag. A change to who speaks for the identity also carries a
// Face ID signature from the Secure Enclave key (NK-2, keys/index.native.ts signListChange). Keychain items survive an app delete and reinstall on iOS: a reinstalled app on the same
// phone resumes as the same identity (the unlocked phone is the trust boundary, the recovery code the backstop); "Sign out of this name" calls forgetIdentity/wipeKeys.
// A seed with no record is an UNCLAIMED key (an interrupted claim): it is reused by createIdentityKey, never read as an identity.

import * as SecureStore from "expo-secure-store";
import { fromSeed, restoreDeviceKey, type DeviceKey } from "./keys.js";
import { b64, fromB64url } from "../../modules/vyre-signer/presence-proof.js";
import { nativeRandom } from "./webcrypto.native";
import type { KeptIdentity } from "./store";

export type { KeptIdentity };

const RECORD = "vyre.identity.record";
const SEED = "vyre.identity.seed";
const OPS = "vyre.identity.ops.";
const CHUNK = 1500;
const ONLY_HERE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const get = (k: string) => SecureStore.getItemAsync(k, ONLY_HERE);
const set = (k: string, v: string) => SecureStore.setItemAsync(k, v, ONLY_HERE);
const del = (k: string) => SecureStore.deleteItemAsync(k, ONLY_HERE);

async function readOps(): Promise<unknown[]> {
  const n = Number(await get(OPS + "n"));
  if (!Number.isInteger(n) || n < 0) return [];
  let text = "";
  for (let i = 0; i < n; i++) text += (await get(OPS + i)) ?? "";
  return n ? (JSON.parse(text) as unknown[]) : [];
}
async function writeOps(ops: unknown[]): Promise<void> {
  const text = JSON.stringify(ops);
  const parts = Math.max(1, Math.ceil(text.length / CHUNK));
  const old = Number(await get(OPS + "n")) || 0;
  for (let i = 0; i < parts; i++) await set(OPS + i, text.slice(i * CHUNK, (i + 1) * CHUNK));
  await set(OPS + "n", String(parts));
  for (let i = parts; i < old; i++) await del(OPS + i);
}

export async function saveIdentity(i: { name: string; id: string; eid: string; ops: unknown[]; pin: KeptIdentity["pin"]; key: DeviceKey }): Promise<void> {
  const kept = i.key.keep() as { kind: string; seed?: Uint8Array };
  if (kept.kind !== "seed" || !kept.seed) throw new Error("the phone keeps only a seed key");
  const had = await get(RECORD);
  if (had && (JSON.parse(had) as { eid?: string }).eid !== i.eid) throw Object.assign(new Error("this phone already holds another identity key; sign out of that name first"), { code: "key_exists" });
  const rec = { name: i.name, id: i.id, eid: i.eid, pin: i.pin, software: i.key.software, createdAt: Date.now() };
  // The seed first, then the chain, then the record last: the record is what makes it an identity, so a half write leaves an unclaimed key, never an identity with no key.
  await set(SEED, b64(kept.seed));
  await writeOps(i.ops);
  await set(RECORD, JSON.stringify(rec));
}

export async function loadIdentity(): Promise<(KeptIdentity & { key: DeviceKey }) | null> {
  const [raw, seed] = await Promise.all([get(RECORD), get(SEED)]);
  if (!raw || !seed) return null;
  const rec = JSON.parse(raw) as Omit<KeptIdentity, "kept" | "ops">;
  const key = await restoreDeviceKey({ kind: "seed", seed: fromB64url(seed) });
  return { ...rec, ops: await readOps(), kept: { kind: "seed" }, key };
}

/** Make the Ed25519 device key, once. Never overwrites: with a record it returns that identity's key, with only a seed (an interrupted claim) it reuses the seed. The seed comes straight from the native random source. */
export async function createIdentityKey(): Promise<DeviceKey> {
  const have = await get(SEED);
  if (have) return fromSeed(fromB64url(have));
  const seed = nativeRandom(32);
  await set(SEED, b64(seed));
  return fromSeed(seed);
}

/** The key kept in the Keychain (claimed or not), or null. */
export async function identityKey(): Promise<DeviceKey | null> {
  const seed = await get(SEED);
  return seed ? fromSeed(fromB64url(seed)) : null;
}

/** Is there a CLAIMED identity on this phone? (A seed alone is an unclaimed key.) */
export async function hasIdentity(): Promise<boolean> {
  return Boolean(await get(RECORD)) && Boolean(await get(SEED));
}

/** Forget everything of the identity: the seed, the record and the chain. A claim that did not go through, or signing out of this name on this phone. The recovery code, kept by the person, makes a new one. */
export async function forgetIdentity(): Promise<void> {
  const n = Number(await get(OPS + "n")) || 0;
  for (let i = 0; i < n; i++) await del(OPS + i);
  await del(OPS + "n");
  await del(RECORD);
  await del(SEED);
}
