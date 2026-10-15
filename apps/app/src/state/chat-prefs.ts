// The person's own pin and mute of a chat: pinned chats sit first in the list, muted chats make no alerts.
// Stored on the box (work.chat.prefs) and mirrored here for instant UI; localStorage is a cache only.
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";

type Prefs = { pinned: string[]; muted: string[] };
const KEY = "vyre.chatprefs";
let state: Prefs = { pinned: [], muted: [] };
let loaded = false;
try { if (Platform.OS === "web" && typeof localStorage !== "undefined") { const raw = JSON.parse(localStorage.getItem(KEY) ?? "null"); if (raw && Array.isArray(raw.pinned) && Array.isArray(raw.muted)) state = raw; } } catch { /* none kept */ }
const subs = new Set<() => void>();
const persistLocal = (next: Prefs) => { try { if (Platform.OS === "web" && typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* none kept */ } };
const set = (next: Prefs) => { state = next; persistLocal(next); subs.forEach((f) => f()); };
const flip = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

async function syncFromServer() {
  if (allowsMock()) return;
  try {
    const d = await tool<{ muted?: string[]; pinned?: string[] }>("work.chat.prefs", {});
    if (d && Array.isArray(d.muted) && Array.isArray(d.pinned)) set({ muted: d.muted, pinned: d.pinned });
  } catch { /* keep cache */ }
  loaded = true;
}

void syncFromServer();

async function pushServer(chat: string, patch: { muted?: boolean; pinned?: boolean }) {
  if (allowsMock()) return;
  try {
    const d = await tool<{ muted?: boolean; pinned?: boolean }>("work.chat.prefs", { chat, ...patch });
    if (d && typeof d.muted === "boolean" && typeof d.pinned === "boolean") {
      set({ muted: flip(state.muted, chat, d.muted), pinned: flip(state.pinned, chat, d.pinned) });
      return;
    }
  } catch { /* fall through */ }
  await syncFromServer();
}

export const chatPrefs = {
  refresh: () => syncFromServer(),
  setPinned: (id: string, on: boolean) => {
    set({ ...state, pinned: flip(state.pinned, id, on) });
    void pushServer(id, { pinned: on });
  },
  setMuted: (id: string, on: boolean) => {
    set({ ...state, muted: flip(state.muted, id, on) });
    void pushServer(id, { muted: on });
  },
};
export function useChatPrefs(): Prefs {
  return useSyncExternalStore((f) => { subs.add(f); if (!loaded && !allowsMock()) void syncFromServer().then(() => f()); return () => subs.delete(f); }, () => state, () => state);
}
