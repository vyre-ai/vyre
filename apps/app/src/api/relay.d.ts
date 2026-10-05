// Types for the platform files: relay.web.ts and relay.native.ts. What differs between the web and
// the phone on the relay path (ADR 0026): the crypto provider, where the device key and the pairing
// live, the presence key offered when pairing, and how visibility is read.
import type { Pairing } from "./pairing";

/** relay/client's crypto provider: WebCrypto on the web, @noble on the phone. */
export function relayCrypto(): any;
/** Where this device's relay key lives: IndexedDB on the web, the secure store on the phone. */
export function relayKeyStore(): { get(): Promise<any>; set(k: any): Promise<void> };
/** The public key pair() offers as the device's presence key: base64url SPKI DER, alg -7 (ES256), and where the key was made (`storage`, native only; left out when unknown, and in a browser, which cannot say). */
export function presenceKey(): Promise<{ public_key: string; alg: number; storage?: "hardware" | "software"; key?: string; signer?: string; rp?: string } | undefined>;
/** What the device says about itself in each hello. */
export const about: { kind: "app" | "web" };
/** A name for this device on the box's list. */
export function deviceName(): string;
/** Visibility for relay/client; undefined where the default (document.visibilityState) is right. */
export const visibility: { hidden(): boolean; on(fn: () => void): () => void } | undefined;
/** The fetch the direct path uses; undefined for the global one. */
export const directFetch: typeof fetch | undefined;
export function loadPairing(): Promise<Pairing | null>;
export function savePairing(p: Pairing | null): Promise<void>;
