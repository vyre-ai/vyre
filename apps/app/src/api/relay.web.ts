// The relay path in a browser (relay.d.ts): WebCrypto with a non-extractable device key in
// IndexedDB (relay/client/webcrypto.js), the pairing in localStorage (it holds no secret), and the
// person session's P-256 key as the presence key.

import { indexedDbKeyStore, webCrypto } from "@vyre/relay-client/webcrypto.js";
import { b64url } from "../auth/person";
import { personKey } from "../auth/person.web";
import { readPairing, type Pairing } from "./pairing";

const PAIRING = "vyre.relay.pairing";

let provider: ReturnType<typeof webCrypto> | null = null;
export const relayCrypto = () => (provider ??= webCrypto());

let store: ReturnType<typeof indexedDbKeyStore> | null = null;
export const relayKeyStore = () => (store ??= indexedDbKeyStore());

export async function presenceKey(): Promise<{ public_key: string; alg: number; storage?: "hardware" | "software" } | undefined> {
  try {
    const k = await personKey();
    return { public_key: b64url(await crypto.subtle.exportKey("spki", k.publicKey)), alg: -7 };
  } catch {
    return undefined;
  }
}

export const about = { kind: "web" as const };

export function deviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const what = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : "browser";
  return `Vyre on ${what}`;
}

export const visibility = undefined;
export const directFetch = undefined;

export async function loadPairing(): Promise<Pairing | null> {
  try {
    return readPairing(localStorage.getItem(PAIRING));
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing | null): Promise<void> {
  try {
    if (p) localStorage.setItem(PAIRING, JSON.stringify(p));
    else localStorage.removeItem(PAIRING);
  } catch {}
}
