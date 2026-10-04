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
