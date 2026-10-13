// One Flow chat: every wake of the Flow's agent steps in one scroll, oldest to newest, a divider per wake. A divider collapses its wake; older runs start collapsed.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Chip, EmptyState, LoadingState, Row, Text, showToast, useUiTheme } from "@vyre/ui";
import { Page } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";
import { useFlowChats } from "./FlowChatsList";
import ThreadInline from "./ThreadInline";
import { ChatComposer } from "../../src/chat/ChatComposer";
import { replyTarget, wakeHeader, type Section } from "./flow-chat-model.ts";

export default function FlowChatScreen() {
  const { flow } = useLocalSearchParams<{ flow: string }>();
  const router = useRouter();
  const { chats, err } = useFlowChats();
  const chat = chats?.find((c) => c.id === String(flow)) ?? null;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const [aim, setAim] = useState<Section | null>(null);
  const { phone, color } = useUiTheme();
  const sections = useMemo(() => chat?.sections ?? [], [chat]);
  const folded = (s: Section) => (open.has(s.thread) ? false : shut.has(s.thread) ? true : s.collapsed);
  const flip = (s: Section) => {
    const now = folded(s);
    setOpen((o) => { const n = new Set(o); now ? n.add(s.thread) : n.delete(s.thread); return n; });
    setShut((o) => { const n = new Set(o); now ? n.delete(s.thread) : n.add(s.thread); return n; });
  };
  const target = chat ? replyTarget(chat, aim) : null;
  const send = (text: string) => {
    if (!chat || !target || !text.trim()) return;
    const thread = target.thread ?? chat.sections[chat.sections.length - 1]?.thread;
    if (!thread) return;
    call("threads.post", { thread, text: text.trim() }).then((r) => { if (r.error) showToast(`Not sent. ${r.error.message}`); }).catch((e) => showToast(`Not sent. ${e instanceof Error ? e.message : "The server did not answer."}`));
  };
  return (
    <Page title={chat?.title ?? "Flow chat"} back="/u/chats">
      {err ? <Banner icon="info">{err}</Banner> : null}
      {!chats && !err ? <LoadingState rows={4} /> : null}
      {chats && !chat ? <Card><EmptyState title="No such Flow chat" body="It may have no runs yet. Go back to Chat and press Flows." /></Card> : null}
      {chat ? (
        <View className="gap-s3">
          {/* One conversation: each wake is a bordered divider with its transcript under it, oldest to newest. */}
          <Card flush>
            {sections.map((s, i) => {
              const h = wakeHeader(s.marker);
              const shown = !folded(s);
              return (
                <View key={s.thread} style={i ? { borderTopWidth: 1, borderTopColor: color.edge } : undefined}>
                  <Row dense chevron title={<Text strong numberOfLines={2}>{s.divider}</Text>} end={s.needsYou ? <Chip>Needs you</Chip> : undefined} accessibilityLabel={`${shown ? "Collapse" : "Expand"} ${s.divider}`} onPress={() => flip(s)} />
                  {shown ? (
                    <View className="gap-s2 px-s3 pb-s3">
                      <Text size="caption" tone="label">{[h.where, h.access].filter(Boolean).join(" · ")}</Text>
                      <ThreadInline thread={s.thread} />
                      <View className="flex-row flex-wrap gap-s2">
                        <Button size="sm" kind="ghost" label="Open run" onPress={() => router.push(h.openRun as never)} />
                        <Button size="sm" kind="ghost" label="Open thread" onPress={() => router.push(`/u/chats/${encodeURIComponent(s.thread)}` as never)} />
                        <Button size="sm" kind={aim?.thread === s.thread ? "secondary" : "ghost"} label="Reply to this run" onPress={() => setAim(s)} />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Card>
          <View className="gap-s1">
            <Text size="caption" tone="label">{target?.label}</Text>
            {aim ? <View className="flex-row"><Button size="sm" kind="ghost" label="Back to the whole chat" onPress={() => setAim(null)} /></View> : null}
            <ChatComposer key={aim?.thread ?? "all"} draftKey={`flowchat:${chat.id}:${aim?.thread ?? "all"}`} state="idle" phone={phone} onSend={send} people={[]} records={[]} models={[]} peopleOnly />
          </View>
        </View>
      ) : null}
    </Page>
  );
}
