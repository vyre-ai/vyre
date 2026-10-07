// Hermes has no WebCrypto. The identity code (kernel/identity/chain.js, src/identity/*) calls crypto.subtle for SHA-256, HKDF into AES-GCM, AES-GCM, Ed25519 verify and ECDSA
// P-256 verify, btoa and atob, and crypto.getRandomValues. webcrypto-impl.js has them on @noble (tested against node:crypto); this installs them, and makes getRandomValues the
// native source (SecRandomCopyBytes through vyre-signer) whatever else was loaded first. A boot self-check fails closed.

import * as Keys from "../../modules/vyre-signer";
// Not "../auth/person": on native Metro resolves that to person.native.ts, which does not export fromB64url (it was undefined here: the RC1 launch crash).
import { fromB64url } from "../../modules/vyre-signer/presence-proof.js";
import { install } from "./webcrypto-impl.js";

/** n random bytes straight from the platform, in chunks (the native call takes 1 to 1024). */
export function nativeRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 1024) out.set(fromB64url(Keys.randomBytes(Math.min(1024, n - at))), at);
  return out;
}

// A missing or broken native source must not take the whole app down at launch: log it and leave crypto uninstalled, so only the identity calls that need it fail (closed).
try {
  install(globalThis, nativeRandom);
} catch (e) {
  console.error("webcrypto: not installed, identity operations will fail:", e);
}
