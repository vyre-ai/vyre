// The identity key of the Mac app's window and of the Windows app's panel (same four calls; the name is the Mac's, the first to have it): the page asks the shell (window.__vyreShell.identity, Host/MacIdentity.swift) for the public key and for signatures over the bytes of a chain
// operation; the Ed25519 seed stays in the Mac's Keychain and never reaches this page. The result is a DeviceKey like the phone's and the browser's, so claim, recover and add-device
// take it as they take any other. A Mac key signs a list change alone (the chain asks for an enclave signature only of an entry that names an enclave key).

import { b64u, eidOf } from "../../../../kernel/identity/chain.js";
import { shellIdentity } from "../shell/shell.ts";
import type { DeviceKey } from "./keys.js";
import { lowS } from "../../modules/vyre-signer/presence-proof.js";

/** Does this page run in the Mac app's window, which can keep an identity key for it? */
export const macKeyAvailable = (): boolean => !!shellIdentity();

const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** What a store keeps for this key: only that it is the Mac's own (the seed is not here and never was). */
export const MAC_KEPT = { kind: "mac-keychain" } as const;

/** This Mac's identity key. `create` makes it when it is missing (a claim or a recovery); without it a missing key is null. */
export async function macDeviceKey(create = false): Promise<DeviceKey | null> {
  const id = shellIdentity();
  if (!id) return null;
  let pub: string;
  try { pub = await id.public(create); } catch { return null; }
  const raw = unb64u(pub);
  return {
    publicKey: pub,
    eid: await eidOf(raw),
    software: false,
    sign: async (m: Uint8Array) => unb64u(await id.sign(b64u(m))),
    keep: () => MAC_KEPT,
  };
}

/**
 * The public point of this Mac's Secure Enclave key (Host/MacEnclave.swift), raw uncompressed, base64url: the `enclave` field of its device entry (NK-2). null on a Mac with no Secure Enclave,
 * which then keeps an Ed25519 entry that signs alone. `create` makes the key the first time (a claim or a recovery).
 */
export async function macEnclavePublic(create = false): Promise<string | null> {
  const id = shellIdentity();
  if (!id?.enclavePublic) return null;
  try { return await id.enclavePublic(create); } catch { return null; }
}

/** The enclave key's signature over `message`, behind Touch ID: the raw 64 bytes r||s with s in the low half, the one form the chain accepts as `esig`. Rejects with the shell's words when declined. */
export async function macEnclaveSign(message: Uint8Array, prompt: string): Promise<Uint8Array> {
  const id = shellIdentity();
  if (!id?.enclaveSign) throw Object.assign(new Error("This Mac has no Secure Enclave key to sign with."), { code: "ERR_NO_ENCLAVE" });
  return lowS(unb64u(await id.enclaveSign(b64u(message), prompt)));
}

/** A list change from this Mac: the Ed25519 key signs it, and when the entry names an enclave key the enclave signs the same bytes behind Touch ID. Touch ID is asked once. */
export async function macSignListChange(message: Uint8Array, prompt: string): Promise<{ sig: Uint8Array; esig?: Uint8Array }> {
  const key = await macDeviceKey();
  if (!key) throw Object.assign(new Error("no identity key on this Mac"), { code: "ERR_NO_KEY" });
  const sig = await key.sign(message);
  if ((await macEnclavePublic(false)) === null) return { sig };
  return { sig, esig: await macEnclaveSign(message, prompt) };
}
