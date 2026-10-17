// How long a quiet spell locks the app (src/shell/lock-gate.js): kept on this device only, as one of the choices' minutes ("0" is Never). The web build keeps it in localStorage; the phone keeps it in the
// secure store. Both can fail, so a read that fails answers the default and a write that fails changes nothing. A change tells the lock gate at once.
import { Platform } from "react-native";
import { DEFAULT_LOCK_MINUTES, lockMinutes } from "./lock-gate.js";

const KEY = "vyre.autolock.minutes";
const listeners = new Set<(minutes: number) => void>();

export async function readLockMinutes(): Promise<number> {
  try {
    if (Platform.OS === "web") return lockMinutes(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY));
    const S = await import("expo-secure-store");
    return lockMinutes(await S.getItemAsync(KEY));
  } catch { return DEFAULT_LOCK_MINUTES; }
}

export async function writeLockMinutes(choice: string): Promise<void> {
  const minutes = lockMinutes(choice);
  try {
    if (Platform.OS === "web") { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, String(minutes)); }
    else { const S = await import("expo-secure-store"); await S.setItemAsync(KEY, String(minutes)); }
  } catch { /* nothing kept; the gate still uses this choice until the app closes */ }
  listeners.forEach((f) => f(minutes));
}

/** Hear a change of the setting. Returns the stop. */
export function onLockMinutes(f: (minutes: number) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

const refreshers = new Set<() => void>();

/** Hear that the lock state may have changed (the person pressed Lock now). Returns the stop. */
export function onLockChanged(f: () => void): () => void {
  refreshers.add(f);
  return () => { refreshers.delete(f); };
}

/** Tell the lock gate to read the state again. */
export function lockChanged(): void {
  refreshers.forEach((f) => f());
}
