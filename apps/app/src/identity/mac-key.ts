// The identity key of the Mac app's window: the page asks the shell (window.__vyreShell.identity, Host/MacIdentity.swift) for the public key and for signatures over the bytes of a chain
// operation; the Ed25519 seed stays in the Mac's Keychain and never reaches this page. The result is a DeviceKey like the phone's and the browser's, so claim, recover and add-device
// take it as they take any other. A Mac key signs a list change alone (the chain asks for an enclave signature only of an entry that names an enclave key).

import { b64u, eidOf } from "../../../../kernel/identity/chain.js";
import { shell } from "../shell/shell.ts";
import type { DeviceKey } from "./keys.js";

/** Does this page run in the Mac app's window, which can keep an identity key for it? */
export const macKeyAvailable = (): boolean => !!shell()?.identity;

const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** What a store keeps for this key: only that it is the Mac's own (the seed is not here and never was). */
export const MAC_KEPT = { kind: "mac-keychain" } as const;

/** This Mac's identity key. `create` makes it when it is missing (a claim or a recovery); without it a missing key is null. */
export async function macDeviceKey(create = false): Promise<DeviceKey | null> {
  const id = shell()?.identity;
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
