// Hermes has no WebCrypto. The identity code (kernel/identity/chain.js, src/identity/*) calls crypto.subtle for SHA-256, HKDF into AES-GCM, AES-GCM, Ed25519 verify and ECDSA
// P-256 verify, btoa and atob, and crypto.getRandomValues. webcrypto-impl.js has them on @noble (tested against node:crypto); this installs them, and makes getRandomValues the
// native source (SecRandomCopyBytes through vyre-signer) whatever else was loaded first. A boot self-check fails closed.

import * as Keys from "../../modules/vyre-signer";
import { fromB64url } from "../auth/person";
import { install } from "./webcrypto-impl.js";

/** n random bytes straight from the platform, in chunks (the native call takes 1 to 1024). */
export function nativeRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 1024) out.set(fromB64url(Keys.randomBytes(Math.min(1024, n - at))), at);
  return out;
}

install(globalThis, nativeRandom);
