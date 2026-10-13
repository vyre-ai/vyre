// The person's own pin and mute of a chat (this device): a pinned chat sits first in the list, a muted one makes no alerts. In memory for the session and, on the web, in localStorage so a reload keeps it.
// The server's own pin is only the assistant's and engineer's chat (work.chat.pin); this is the person's quiet preference.
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

type Prefs = { pinned: string[]; muted: string[] };
const KEY = "vyre.chatprefs";
let state: Prefs = { pinned: [], muted: [] };
try { if (Platform.OS === "web" && typeof localStorage !== "undefined") { const raw = JSON.parse(localStorage.getItem(KEY) ?? "null"); if (raw && Array.isArray(raw.pinned) && Array.isArray(raw.muted)) state = raw; } } catch { /* none kept */ }
const subs = new Set<() => void>();
const set = (next: Prefs) => { state = next; try { if (Platform.OS === "web" && typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* none kept */ } subs.forEach((f) => f()); };
const flip = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

export const chatPrefs = {
  setPinned: (id: string, on: boolean) => set({ ...state, pinned: flip(state.pinned, id, on) }),
  setMuted: (id: string, on: boolean) => set({ ...state, muted: flip(state.muted, id, on) }),
};
export function useChatPrefs(): Prefs {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state, () => state);
}
