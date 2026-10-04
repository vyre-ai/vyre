// The root PUBLIC key of each space this device made on a server (claimServerSpace's rootPublic), kept beside the space id. It is public: the record carries it and invites are fingerprinted with it.
// localStorage on the web, the secure store on the phone. Every call answers nothing instead of throwing.
import { Platform } from "react-native";

const KEY = "vyre.space-roots";

async function readAll(): Promise<Record<string, string>> {
  try {
    const raw = Platform.OS === "web" ? (typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)) : await (await import("expo-secure-store")).getItemAsync(KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" ? o : {};
  } catch { return {}; }
}

export async function keepRootPublic(space: string, rootPublic: string): Promise<void> {
  if (!space || !rootPublic) return;
  try {
    const all = { ...(await readAll()), [space]: rootPublic };
    const raw = JSON.stringify(all);
    if (Platform.OS === "web") { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, raw); return; }
    await (await import("expo-secure-store")).setItemAsync(KEY, raw);
  } catch { /* nothing kept: the record at the directory still carries it */ }
}

export async function rootPublicOf(space: string): Promise<string | null> { return (await readAll())[space] ?? null; }
