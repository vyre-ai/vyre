// The person's yes with no prompt (v0.6.5, password only, until Apple signing): while the person is unlocked on a page that holds the opened master record (the Mac and web app), the identity key in memory signs
// the presence proof (class `session`, kernel/seal/proof.js). No Touch ID, no sheet, no phone. Locked, there is no key and this answers null, so nothing signs. EXPO_PUBLIC_VYRE_PRESENCE=prompt (a build
// for Apple-signed apps) turns it off and the hardware signers answer as before. The server's own `presence` setting still decides whether it takes the proof: a server set to prompt refuses it.
import type { Signer } from "./phone-approve.js";
import { getHost, hostWanted } from "../host";

export async function sessionSigner(): Promise<Signer | null> {
  if (process.env.EXPO_PUBLIC_VYRE_PRESENCE === "prompt") return null;
  if (!hostWanted()) return null;
  try { return (getHost().sessionSigner() as Signer | null) ?? null; } catch { return null; }
}
