// @ts-check
// How a Windows PC claims its name. The Mac claims with the key in its Keychain; on Windows the DPAPI key is exactly the weak kind (a script on the page can ask the shell to sign with it, so its entry is `held: "web"`: it cannot
// change who speaks for the name, and the invitee door of a team's server refuses it), so a Windows PC claims with its Windows Hello passkey instead: its entry is a full device that asks the person at the OS on every use
// (reverses IR-32 for Windows only; the Mac stays as it is). Where Hello cannot be used, the PC falls back to the DPAPI key as before, held.
import { passkeyRp } from "./passkey.js";

/**
 * Which way this window claims. `helloAvailable` is `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` (asked only when the page is one the shell makes a passkey on).
 * @param {{ shell: "mac" | "windows" | null, origin: string | undefined, helloAvailable: () => Promise<boolean> }} d
 * @returns {Promise<{ how: "windows-hello", rp: string } | { how: "shell-key" } | { how: "other" }>}
 */
export async function claimRoute(d) {
  if (d.shell === "mac") return { how: "shell-key" };
  if (d.shell !== "windows") return { how: "other" };
  const rp = passkeyRp(d.origin, { shell: true });
  if (!rp) return { how: "shell-key" };
  let ok = false;
  try { ok = await d.helloAvailable(); } catch { ok = false; }
  return ok ? { how: "windows-hello", rp } : { how: "shell-key" };
}

/** Is a platform authenticator (Windows Hello) usable here? False where WebAuthn is not exposed. */
export const helloHere = async () => typeof PublicKeyCredential !== "undefined" && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function" && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
