// A message half written is kept per thread, so Back or Close never loses it. In memory for the session; on the web also in localStorage so a reload keeps it.
// A phone does not write drafts to disk: they can hold anything the person was about to say.
import { Platform } from "react-native";
import { keptMentions } from "./draft-mentions.js";

export type DraftMention = { kind: string; id: string; name: string };
const tags = new Map<string, DraftMention[]>();

const mem = new Map<string, string>();
const key = (thread: string) => `vyre.draft.${thread}`;

export function readDraft(thread: string): string {
  const m = mem.get(thread);
  if (m !== undefined) return m;
  try { return Platform.OS === "web" && typeof localStorage !== "undefined" ? localStorage.getItem(key(thread)) ?? "" : ""; } catch { return ""; }
}

/** The # tags a draft holds (memory only, for this session). */
export const readDraftMentions = (thread: string): DraftMention[] => tags.get(thread) ?? [];

/** Keep a draft. The tags (a file asked about: { kind: "drive", id: "<share>:<path>", name }) ride with it and show as chips in the composer. */
export function writeDraft(thread: string, text: string, mentions?: DraftMention[]): void {
  if (mentions) { const k = keptMentions(text, mentions); if (k.length) tags.set(thread, k); else tags.delete(thread); }
  if (text) mem.set(thread, text); else { mem.delete(thread); tags.delete(thread); }
  try {
    if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
    if (text) localStorage.setItem(key(thread), text); else localStorage.removeItem(key(thread));
  } catch { /* nothing kept */ }
}
