// A message half written is kept per thread, so Back or Close never loses it. In memory for the session; on the web also in localStorage so a reload keeps it.
// A phone does not write drafts to disk: they can hold anything the person was about to say.
import { Platform } from "react-native";

const mem = new Map<string, string>();
const key = (thread: string) => `vyre.draft.${thread}`;

export function readDraft(thread: string): string {
  const m = mem.get(thread);
  if (m !== undefined) return m;
  try { return Platform.OS === "web" && typeof localStorage !== "undefined" ? localStorage.getItem(key(thread)) ?? "" : ""; } catch { return ""; }
}

export function writeDraft(thread: string, text: string): void {
  if (text) mem.set(thread, text); else mem.delete(thread);
  try {
    if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
    if (text) localStorage.setItem(key(thread), text); else localStorage.removeItem(key(thread));
  } catch { /* nothing kept */ }
}
