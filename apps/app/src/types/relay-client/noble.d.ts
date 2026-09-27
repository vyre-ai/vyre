// What the app uses of relay/client/noble.js (see client.d.ts for why this file exists).
import type { CryptoProvider } from "./webcrypto";

export function nobleCrypto(n: {
  x25519: { getPublicKey(priv: Uint8Array): Uint8Array; getSharedSecret(priv: Uint8Array, pub: Uint8Array): Uint8Array; utils?: unknown };
  sha256: (b: Uint8Array) => Uint8Array;
  hmac: (hash: any, key: Uint8Array, msg: Uint8Array) => Uint8Array;
  gcm: (key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array) => { encrypt(pt: Uint8Array): Uint8Array; decrypt(ct: Uint8Array): Uint8Array };
  randomBytes: (n: number) => Uint8Array;
}): CryptoProvider;
