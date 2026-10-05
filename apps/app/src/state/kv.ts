// A small keyed store for what this device keeps for itself (appearance, a collapsed section): localStorage on the web, the secure store on a phone. Every call answers nothing instead of throwing, so a blocked
// or full store never breaks a screen. Not for secrets.
import { Platform } from "react-native";

export async function kvGet(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    const S = await import("expo-secure-store");
    return await S.getItemAsync(key);
  } catch { return null; }
}

export async function kvSet(key: string, raw: string | null): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage === "undefined") return;
      if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw);
      return;
    }
    const S = await import("expo-secure-store");
    if (raw === null) await S.deleteItemAsync(key); else await S.setItemAsync(key, raw);
  } catch { /* nothing kept; the look is the default next time */ }
}
