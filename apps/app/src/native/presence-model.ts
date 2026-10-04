// Approving with a fingerprint or face, in plain words (pure). The key that signs is vyre.human in
// modules/vyre-signer: in the Keystore (StrongBox where the phone has one) or the Secure Enclave,
// and it signs only after the system's biometric prompt. presence.ts wraps it; person.native.ts
// already uses it for the box's x-vyre-presence header, so this adds no second key.

export type PresenceLevel = "strongbox" | "tee" | "secure-enclave" | "software" | "none";

export type PresenceFail =
  | "no-biometrics" // no screen lock or nothing enrolled
  | "changed" // the enrolled fingerprints or faces changed: the key is void
  | "canceled" // the person closed the prompt
  | "locked" // too many wrong tries, or no hardware
  | "background" // the prompt needs the app in front
  | "unavailable" // this build cannot do it
  | "failed";

export type PresenceResult =
  | { ok: true; signature: string }
  | { ok: false; reason: PresenceFail; say: string };

export const SAY: Record<PresenceFail, string> = {
  "no-biometrics": "Set a screen lock and add a fingerprint or face in your phone's settings, then try again.",
  changed: "Your fingerprints or faces changed, so this phone's approval key was reset. Sign in again to make a new one.",
  canceled: "You closed the prompt. Nothing was approved.",
  locked: "The fingerprint or face check is locked. Use your passcode on the phone, then try again.",
  background: "Bring Vyre to the front to approve.",
  unavailable: "Approving with a fingerprint or face is not available here.",
  failed: "The check did not finish. Nothing was approved.",
};

const BY_CODE: Record<string, PresenceFail> = {
  ERR_NO_BIOMETRICS: "no-biometrics",
  ERR_KEY_INVALIDATED: "changed",
  ERR_CANCELED: "canceled",
  ERR_BIOMETRIC: "locked",
  ERR_NO_ACTIVITY: "background",
};

export function failFrom(e: unknown): PresenceFail {
  const code = (e as { code?: unknown } | null)?.code;
  return (typeof code === "string" && BY_CODE[code]) || "failed";
}

export const refusal = (reason: PresenceFail): PresenceResult => ({ ok: false, reason, say: SAY[reason] });

/** Where the key lives, for a settings line: true for hardware, false for software or none. */
export const inHardware = (level: string): boolean => level === "strongbox" || level === "tee" || level === "secure-enclave";

/** What the pairing hello reports about the key (`storage`): "hardware" for the Secure Enclave, StrongBox or the TEE, "software" when the platform's own key API says the key is in software, nothing when it is not known. Self-reported, display only. */
export const keyStorage = (level: string | null | undefined): "hardware" | "software" | undefined => (level && inHardware(level) ? "hardware" : level === "software" ? "software" : undefined);

export function levelWords(level: string): string {
  switch (level) {
    case "strongbox": return "A dedicated security chip holds the key.";
    case "tee": return "The phone's secure hardware holds the key.";
    case "secure-enclave": return "The Secure Enclave holds the key.";
    case "software": return "The key is kept in software on this device. Hardware is not available.";
    default: return "There is no approval key on this device yet.";
  }
}

/** The prompt's title is the thing being approved, trimmed to fit a system dialog. */
export function promptTitle(what: string, max = 60): string {
  const s = String(what ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "Approve with your fingerprint or face";
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
