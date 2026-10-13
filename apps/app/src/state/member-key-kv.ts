// Where this device keeps a member's vault Secret Key: the phone's secure store, or the browser's storage on the web (which has no secure store; the key is useless without the master password).
import { Platform } from "react-native";

export async function kvGet(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    const S = await import("expo-secure-store");
    return await S.getItemAsync(key);
  } catch { return null; }
}

export async function kvSet(key: string, raw: string | null): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") throw new Error("this browser would not keep your vault's key");
    if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw);
    return;
  }
  const S = await import("expo-secure-store");
  if (raw === null) await S.deleteItemAsync(key); else await S.setItemAsync(key, raw);
}
