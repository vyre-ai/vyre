// Vyre autofill on Android (ADR 0028, decision 6): pair this phone with vyred's fill listener and
// turn on the autofill service. Android only; the web and iOS builds never import this.
//
// The service itself runs without the app open. It lists matching logins by name (the device
// token), and every value needs a fingerprint or face through the device key, which opens a
// 30-minute fill window on vyred. See README.md.

import { requireNativeModule } from "expo";

/**
 * Error codes the native side rejects with (error.code):
 *   ERR_BAD_SERVER       the address is not https (http://127.0.0.1 is allowed only in a debug build)
 *   ERR_NO_BIOMETRICS    the device key needs a screen lock and an enrolled fingerprint or face
 *   ERR_KEYGEN           the keystore refused to make the key
 *   ERR_NETWORK          vyred did not answer
 *   ERR_PAIR             vyred refused the pairing; the message starts with its code
 *                        (bad_code, locked_out, vault_locked, origin_required, bad_input)
 *   ERR_NO_CONTEXT       the app is not up yet
 */
export type AutofillErrorCode =
  | "ERR_BAD_SERVER"
  | "ERR_NO_BIOMETRICS"
  | "ERR_KEYGEN"
  | "ERR_NETWORK"
  | "ERR_PAIR"
  | "ERR_NO_CONTEXT";

export type Paired = {
  device: string;
  name: string;
  /** Where the device key lives: "strongbox", "tee", "software" or "none". */
  level: string;
};

export type AutofillStatus = {
  /** A device token and a device key are both on this phone. */
  paired: boolean;
  /** The fill listener's base URL, as setServer normalized it. */
  server: string | null;
  device: string | null;
  name: string | null;
  level: string;
  /** A fill window is open in this process (it is memory only). */
  unlocked: boolean;
  /** Vyre is the phone's autofill service. */
  enabled: boolean;
  /** vyred answered the status call. */
  reachable: boolean;
  /** vyred says this phone was unpaired there: pair again. */
  revoked: boolean;
};

type Native = {
  setServer(url: string): Promise<string>;
  pair(url: string, code: string, name: string): Promise<Paired>;
  status(): Promise<AutofillStatus>;
  lock(): Promise<boolean>;
  unpair(): Promise<boolean>;
  isEnabled(): boolean;
  openSettings(): boolean;
};

const native = requireNativeModule<Native>("VyreAutofill");

/** Set the fill listener's address. Changing it from the paired one forgets the pairing. */
export function setServer(url: string): Promise<string> {
  return native.setServer(url);
}

/**
 * Pair with a code from `vyre vault pair`: makes the device key (StrongBox where present,
 * BIOMETRIC_STRONG for each use) and sends its public key. `name` is how vyred lists this phone,
 * such as "alex's Pixel 8".
 */
export function pair(url: string, code: string, name: string): Promise<Paired> {
  return native.pair(url, code, name);
}

export function status(): Promise<AutofillStatus> {
  return native.status();
}

/** End this phone's fill window now. */
export function lock(): Promise<boolean> {
  return native.lock();
}

/**
 * Forget the pairing and delete the device key. vyred still lists the device until it is revoked
 * there (vault.device.revoke); the token is gone from the phone either way.
 */
export function unpair(): Promise<boolean> {
  return native.unpair();
}

/** Vyre is the selected autofill service. */
export function isEnabled(): boolean {
  return native.isEnabled();
}

/** Open the system screen that picks the autofill service, with Vyre offered. */
export function openSettings(): boolean {
  return native.openSettings();
}
