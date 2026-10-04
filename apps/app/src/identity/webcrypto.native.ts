// Hermes has no WebCrypto. The identity code (kernel/identity/chain.js, src/identity/*) calls crypto.subtle for exactly these: SHA-256 digest, HKDF into AES-GCM,
// AES-GCM encrypt and decrypt with additional data, and Ed25519 verify; and crypto.getRandomValues. This file installs those, on @noble (pure JS, the same libraries the
// relay path uses), only where the runtime does not have them. generateKey for Ed25519 refuses, so keys.js falls back to its seed key, which store.native.ts keeps in the Keychain.

import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { gcm } from "@noble/ciphers/aes";
import { ed25519 } from "@noble/curves/ed25519";
import * as Keys from "../../modules/vyre-signer";
import { fromB64url } from "../auth/person";

type Raw = { kind: "hkdf" | "aes" | "ed25519-public"; raw: Uint8Array };
const bytes = (d: BufferSource): Uint8Array => (d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength));
const nameOf = (a: unknown): string => String(typeof a === "string" ? a : (a as { name?: string })?.name ?? "").toUpperCase();
const refuse = (what: string) => Object.assign(new Error(`${what} is not available on this runtime`), { name: "NotSupportedError" });
const out = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

const subtle = {
  async digest(algo: unknown, data: BufferSource) {
    if (nameOf(algo) !== "SHA-256") throw refuse(`digest ${nameOf(algo)}`);
    return out(sha256(bytes(data)));
  },
  async importKey(format: string, data: BufferSource, algo: unknown): Promise<Raw> {
    if (format !== "raw") throw refuse(`importKey ${format}`);
    const n = nameOf(algo);
    if (n === "HKDF") return { kind: "hkdf", raw: bytes(data) };
    if (n === "ED25519") return { kind: "ed25519-public", raw: bytes(data) };
    throw refuse(`importKey ${n}`);
  },
  async deriveKey(algo: { name: string; hash: string; salt: BufferSource; info: BufferSource }, base: Raw, target: { name: string; length: number }): Promise<Raw> {
    if (nameOf(algo) !== "HKDF" || nameOf(algo.hash) !== "SHA-256" || nameOf(target) !== "AES-GCM") throw refuse("deriveKey");
    return { kind: "aes", raw: hkdf(sha256, base.raw, bytes(algo.salt), bytes(algo.info), target.length / 8) };
  },
  async encrypt(algo: { name: string; iv: BufferSource; additionalData?: BufferSource; tagLength?: number }, key: Raw, data: BufferSource) {
    if (nameOf(algo) !== "AES-GCM" || key.kind !== "aes" || (algo.tagLength ?? 128) !== 128) throw refuse("encrypt");
    return out(gcm(key.raw, bytes(algo.iv), algo.additionalData ? bytes(algo.additionalData) : undefined).encrypt(bytes(data)));
  },
  async decrypt(algo: { name: string; iv: BufferSource; additionalData?: BufferSource; tagLength?: number }, key: Raw, data: BufferSource) {
    if (nameOf(algo) !== "AES-GCM" || key.kind !== "aes" || (algo.tagLength ?? 128) !== 128) throw refuse("decrypt");
    return out(gcm(key.raw, bytes(algo.iv), algo.additionalData ? bytes(algo.additionalData) : undefined).decrypt(bytes(data)));
  },
  async verify(algo: unknown, key: Raw, sig: BufferSource, msg: BufferSource) {
    if (nameOf(algo) !== "ED25519" || key.kind !== "ed25519-public") throw refuse("verify");
    try { return ed25519.verify(bytes(sig), bytes(msg), key.raw); } catch { return false; }
  },
  async generateKey(algo: unknown) { throw refuse(`generateKey ${nameOf(algo)}`); },
};

const g = globalThis as unknown as { crypto?: { subtle?: unknown; getRandomValues?: <T extends ArrayBufferView | null>(a: T) => T } };
g.crypto = g.crypto ?? {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (a) => {
    if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(fromB64url(Keys.randomBytes(a.byteLength)));
    return a;
  };
}
if (!g.crypto.subtle) g.crypto.subtle = subtle;
