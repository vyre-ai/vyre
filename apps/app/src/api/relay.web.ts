// The relay path in a browser (relay.d.ts): WebCrypto with a non-extractable device key in
// IndexedDB (relay/client/webcrypto.js), the pairing in localStorage (it holds no secret), and the
// person session's P-256 key as the presence key.

import { indexedDbKeyStore, webCrypto } from "@vyre/relay-client/webcrypto.js";
import { b64url } from "../auth/person.ts"; // the explicit file: "../auth/person" resolves to person.web.ts on the web, which exports no b64url (the presence key was never offered)
import { personKey } from "../auth/person.web";
import { loadIdentity } from "../identity/store";
import { shellIdentity } from "../shell/shell.ts";
import { passkeyPresenceKey } from "../identity/passkey.js";
import { readPairing, type Pairing } from "./pairing";

const PAIRING = "vyre.relay.pairing";

let provider: ReturnType<typeof webCrypto> | null = null;
export const relayCrypto = () => (provider ??= webCrypto());

let store: ReturnType<typeof indexedDbKeyStore> | null = null;
export const relayKeyStore = () => (store ??= indexedDbKeyStore());

export async function presenceKey(): Promise<{ public_key: string; alg: number; storage?: "hardware" | "software" } | undefined> {
  try {
    // A browser whose identity is a passkey offers the passkey itself as its presence key (signer webauthn_platform); any other browser offers its person session's key.
    const mine = await loadIdentity().catch(() => null);
    const pk = passkeyPresenceKey(mine?.key?.keep?.() as never);
    // The box reads `key` (a base64url SPKI) with signer and rp for a passkey; the relay client's typedef names only public_key, so the shape is passed as it is.
    if (pk) return pk as unknown as { public_key: string; alg: number; storage?: "hardware" | "software" };
    const k = await personKey();
    return { public_key: b64url(await crypto.subtle.exportKey("spki", k.publicKey)), alg: -7 };
  } catch {
    return undefined;
  }
}

// The Mac and Windows windows are the app, not a browser: a "web" device is the limited kind (the box sees it as `web:<id>`, which has no door to the person's paired session), so a typed code that enrols the
// redeemer at once would leave the window unable to sign in. A browser keeps "web".
export const about = shellIdentity() ? { kind: "app" as const } : { kind: "web" as const };

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
