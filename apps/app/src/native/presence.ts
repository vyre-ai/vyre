// Biometric approval on the phone. The key is the hardware-backed vyre.human from
// modules/vyre-signer (Android Keystore with StrongBox where present, iOS Secure Enclave); it
// signs only after a strong biometric. expo-local-authentication answers the question "can this
// phone do it" before a prompt is shown. person.native.ts uses the same key for the box's presence
// header; this is the wrapper for any other approval (a Wink add, a vault reveal, a sent message).

import * as LocalAuthentication from "expo-local-authentication";
import * as Keys from "../../modules/vyre-signer";
import { failFrom, inHardware, levelWords, promptTitle, refusal, type PresenceResult } from "./presence-model.ts";

export type { PresenceResult, PresenceFail } from "./presence-model.ts";
export { promptTitle, levelWords } from "./presence-model.ts";

export type PresenceSupport = {
  /** A biometric is enrolled and the phone can show the prompt. */
  ready: boolean;
  /** The key is in secure hardware. */
  hardware: boolean;
  level: string;
  say: string;
};

export async function presenceSupport(): Promise<PresenceSupport> {
  let level = "none";
  try {
    level = Keys.info().level;
  } catch {}
  try {
    const has = await LocalAuthentication.hasHardwareAsync();
    const enrolled = has && (await LocalAuthentication.isEnrolledAsync());
    return {
      ready: enrolled,
      hardware: inHardware(level),
      level,
      say: enrolled ? levelWords(level) : "Set a screen lock and add a fingerprint or face in your phone's settings.",
    };
  } catch {
    return { ready: false, hardware: inHardware(level), level, say: "Approving with a fingerprint or face is not available here." };
  }
}

/** Sign `message` with the biometric key after the system prompt titled by `what`. The signature is DER, base64url. */
export async function approveAndSign(message: string, what: string): Promise<PresenceResult> {
  try {
    await Keys.ensureKey(Keys.HUMAN, { biometric: true });
    const signature = await Keys.sign(Keys.HUMAN, message, { prompt: promptTitle(what) });
    return { ok: true, signature };
  } catch (e) {
    return refusal(failFrom(e));
  }
}

/** The prompt alone, no signature: a yes from the person's own body for something local (showing a secret on this screen). */
export async function confirmHere(what: string): Promise<PresenceResult> {
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: promptTitle(what),
      cancelLabel: "Cancel",
      disableDeviceFallback: true,
    });
    if (r.success) return { ok: true, signature: "" };
    return refusal(r.error === "user_cancel" || r.error === "system_cancel" || r.error === "app_cancel" ? "canceled" : r.error === "lockout" ? "locked" : r.error === "not_enrolled" ? "no-biometrics" : "failed");
  } catch (e) {
    return refusal(failFrom(e));
  }
}
