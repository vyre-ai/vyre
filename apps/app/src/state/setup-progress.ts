// Where space setup stopped on this device, so closing and reopening Vyre resumes at the same step (DESIGN-spaces-first.md).
// Kept as one string (screens/install/flow.js packProgress): the step and what the person typed, never a code or a key.
// The web build keeps it in localStorage; the phone keeps it in the secure store beside the person's token. Both can fail, so every call answers nothing instead of throwing.
import { Platform } from "react-native";

const KEY = "vyre.setup.progress";

export async function readProgress(): Promise<string | null> {
  try {
    if (Platform.OS === "web") return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const S = await import("expo-secure-store");
    return await S.getItemAsync(KEY);
  } catch { return null; }
}

export async function writeProgress(raw: string | null): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage === "undefined") return;
      if (raw === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, raw);
      return;
    }
    const S = await import("expo-secure-store");
    if (raw === null) await S.deleteItemAsync(KEY); else await S.setItemAsync(KEY, raw);
  } catch { /* nothing kept; setup starts at the top next time */ }
}

const SKIPPED = "vyre.setup.skipped";

/** Did the person choose "Not now" on "I don't have Vyre running yet"? The gate then lets the not-connected landing open. Cleared when a pairing is saved or setup is begun again. */
export async function readSkipped(): Promise<boolean> {
  try {
    if (Platform.OS === "web") return false;
    const S = await import("expo-secure-store");
    return (await S.getItemAsync(SKIPPED)) === "1";
  } catch { return false; }
}

export async function writeSkipped(on: boolean): Promise<void> {
  try {
    if (Platform.OS === "web") return;
    const S = await import("expo-secure-store");
    if (on) await S.setItemAsync(SKIPPED, "1"); else await S.deleteItemAsync(SKIPPED);
  } catch { /* nothing kept; the gate asks for setup again */ }
}
