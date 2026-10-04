// The phone's paired-start key: the hardware key reported at pairing (api/relay.native.ts presenceKey: vyre.human, the Secure Enclave on an iPhone or the Android Keystore, StrongBox where
// present and the TEE otherwise, user authentication per use). The server checks the signature against that key, so a hardware-held key opens a non-software session. Each
// start asks for Face ID or the fingerprint once; a session lasts weeks, so the prompt is rare.
import * as Keys from "../../modules/vyre-signer";
import { derToP1363, fromB64url } from "./person";
import { keepPairedToken } from "./person.native";
import type { PairedKey } from "./paired-key";

export type { PairedKey };

export async function pairedKey(): Promise<PairedKey> {
  return {
    sign: async (m) => derToP1363(fromB64url(await Keys.sign(Keys.HUMAN, new TextDecoder().decode(m), { prompt: "Sign in to your server" }))),
    keep: (route, token) => keepPairedToken(route, token),
  };
}
