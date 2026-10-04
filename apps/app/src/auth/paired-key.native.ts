// The phone's paired-start key: the hardware key reported at pairing (api/relay.native.ts presenceKey: vyre.human, the Secure Enclave on an iPhone or the Android Keystore, StrongBox where
// present and the TEE otherwise, user authentication per use). The server checks the signature against that key, so a hardware-held key opens a non-software session. Each
// start asks for Face ID or the fingerprint once; a session lasts weeks, so the prompt is rare.
import * as Keys from "../../modules/vyre-signer";
import { derToP1363, fromB64url } from "./person";
import { keepPairedToken } from "./person.native";
import { lowS } from "../../modules/vyre-signer/presence-proof.js";
import type { PairedKey } from "./paired-key";

export type { PairedKey };

export async function pairedKey(): Promise<PairedKey> {
  // The hardware key that signs the session start is the same one the identity entry names as `enclave`, so one signature (one Face ID or fingerprint) serves as both `sig` and `esig`:
  // raw r||s with s in the low half, the one form the server accepts for an esig.
  let last: { m: string; done: Promise<Uint8Array> } | null = null;
  const once = (m: Uint8Array) => {
    const key = new TextDecoder().decode(m);
    if (!last || last.m !== key) last = { m: key, done: Keys.sign(Keys.HUMAN, key, { prompt: "Sign in to your server" }).then((d) => lowS(derToP1363(fromB64url(d)))) };
    return last.done;
  };
  return { sign: once, signEnclave: once, keep: (route, token) => keepPairedToken(route, token) };
}
