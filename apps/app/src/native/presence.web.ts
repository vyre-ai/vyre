// The web build of presence.ts. A browser cannot hold the phone's approval key. On the web a
// person approves with the box's own passkey sign-in (src/auth/person.web.ts and the box's
// WebAuthn flow); this file says so instead of pretending, and reports whether the browser has a
// platform authenticator at all.

import { refusal, type PresenceResult } from "./presence-model.ts";

export type { PresenceResult, PresenceFail } from "./presence-model.ts";
export { promptTitle, levelWords } from "./presence-model.ts";

export type PresenceSupport = { ready: boolean; hardware: boolean; level: string; say: string };

export async function presenceSupport(): Promise<PresenceSupport> {
  let platform = false;
  try {
    const pk = (globalThis as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
    platform = (await pk?.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true;
  } catch {}
  return {
    ready: false,
    hardware: false,
    level: "none",
    say: platform
      ? "This browser can use a passkey to sign in. Approving a send, a reveal or a payment needs the Vyre phone app."
      : "Approving a send, a reveal or a payment needs the Vyre phone app.",
  };
}

export async function approveAndSign(_message: string, _what: string): Promise<PresenceResult> {
  return refusal("unavailable");
}

export async function confirmHere(_what: string): Promise<PresenceResult> {
  return refusal("unavailable");
}
