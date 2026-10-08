// The identity key of the Mac app's window and of the Windows app's panel (same four calls; the name is the Mac's, the first to have it): the page asks the shell (window.__vyreShell.identity, Host/MacIdentity.swift) for the public key and for signatures over the bytes of a chain
// operation; the Ed25519 seed stays in the Mac's Keychain and never reaches this page. The result is a DeviceKey like the phone's and the browser's, so claim, recover and add-device
// take it as they take any other. A Mac key signs a list change alone (the chain asks for an enclave signature only of an entry that names an enclave key).

import { b64u, eidOf } from "../../../../kernel/identity/chain.js";
import { shellIdentity, shellKind } from "../shell/shell.ts";
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

let keyFailure = "";
/** The shell's own words for why the last key call failed ("" when it did not): shown with the failure, so a person and the log see the real reason, not a generic one. */
export const lastKeyFailure = (): string => keyFailure;
const reasonOf = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e ?? "").slice(0, 300);

/** This Mac's identity key. `create` makes it when it is missing (a claim or a recovery); without it a missing key is null. */
export async function macDeviceKey(create = false): Promise<DeviceKey | null> {
  const id = shellIdentity();
  if (!id) return null;
  let pub: string;
  // A create that fails says why (the shell's own words), so the screen never shows one generic line for every cause (IR-31); the reason is also kept for lastKeyFailure.
  try { pub = await id.public(create); keyFailure = ""; } catch (e) { keyFailure = reasonOf(e); if (create) throw Object.assign(new Error(`This computer would not keep your key: ${keyFailure}`), { code: "cannot_keep" }); return null; }
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
export async function macEnclaveSign(message: Uint8Array, prompt: string, card?: { fields?: Record<string, unknown>; space?: string }): Promise<Uint8Array> {
  const id = shellIdentity();
  if (!id?.enclaveSign) throw Object.assign(new Error("This Mac has no Secure Enclave key to sign with."), { code: "ERR_NO_ENCLAVE" });
  return lowS(unb64u(await id.enclaveSign(b64u(message), prompt, card)));
}

/** A list change from this Mac: the Ed25519 key signs it, and when the entry names an enclave key the enclave signs the same bytes behind Touch ID. Touch ID is asked once. */
export async function macSignListChange(message: Uint8Array, prompt: string): Promise<{ sig: Uint8Array; esig?: Uint8Array }> {
  const key = await macDeviceKey();
  if (!key) throw Object.assign(new Error("no identity key on this Mac"), { code: "ERR_NO_KEY" });
  const sig = await key.sign(message);
  if ((await macEnclavePublic(false)) === null) return { sig };
  return { sig, esig: await macEnclaveSign(message, prompt) };
}

/**
 * Is this computer's key one a script on the page can reach, so its entry must say `held: "web"` and so cannot change who speaks for the identity (kernel/identity/chain.js, KP-1)? The shell signs
 * whatever bytes the page gives it, and on a team server that page is the operator's JavaScript. Two things stand between that and the person: a hardware key that asks the person for each
 * list change (the Mac's Secure Enclave with Touch ID), and nothing else. A computer with no such key is held (no enclave key), and so is Windows until a TPM computer has shown a Hello prompt on
 * every signature (reviewer-3's finding): its entry signs only its own genesis, and list changes come from the phone or the recovery code.
 */
export async function shellKeyHeld(): Promise<boolean> {
  if (!shellIdentity()) return false;
  if (shellKind() === "windows") return true;
  return (await macEnclavePublic(false)) === null;
}
