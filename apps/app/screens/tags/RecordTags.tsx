import { useRouter } from "expo-router";
import { View } from "react-native";
import { TagRow, Text, showToast, tagsOf, tallyTags, useRecordsWorld, useStore, withTag, withoutTag } from "@vyre/ui";
import { href } from "../../../../lib/tags.js";

/** The tags of one record (a project, a chat's record) as chips on its page: a chip opens that tag's page, "Tag" adds one, a chip in edit takes it off. Reads and writes the record's own `tags` text. */
export function RecordTags({ rec, onChanged }: { rec: { urn: string; version?: number; data?: Record<string, unknown> }; onChanged?: () => void }) {
  const store = useStore();
  const router = useRouter();
  const { data: world } = useRecordsWorld();
  const known = world ? tallyTags(Object.values(world.byType).flat()).map((t) => t.tag) : [];
  const save = async (next: string) => {
    try { await store.update(rec.urn, { tags: next }, rec.version); onChanged?.(); } catch (e) { showToast(e instanceof Error && e.message ? e.message : "The tags were not saved. Try again."); throw e; }
  };
  const text = rec.data?.tags;
  return <TagRow tags={tagsOf(text)} known={known} onOpen={(t) => router.push(href(t) as never)} onAdd={(t) => save(withTag(text, t))} onRemove={(t) => save(withoutTag(text, t))} />;
}

/** The tags of a chat: they live on the chat's record (type chat-record, its `chat` field is the chat id). Nothing shows where the chat has no record yet. */
export function ChatTags({ chat, thread }: { chat: string; thread?: string }) {
  const { data: world, reload } = useRecordsWorld();
  const rec = (world?.byType["chat-record"] || []).find((r: any) => r.data?.chat === chat || (thread && r.data?.chat === thread));
  return rec ? <View className="gap-s1 px-s4 py-s2"><Text size="caption" tone="label">Tags</Text><RecordTags rec={rec as never} onChanged={reload} /></View> : null;
}
