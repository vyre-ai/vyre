// One Flow chat: every wake of the Flow's agent steps in one scroll, oldest to newest, a divider per wake. A divider collapses its wake; older runs start collapsed.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";
import { useFlowChats } from "./FlowChatsList";
import { replyTarget, wakeHeader, type Section } from "./flow-chat-model.ts";

export default function FlowChatScreen() {
  const { flow } = useLocalSearchParams<{ flow: string }>();
  const router = useRouter();
  const { chats, err } = useFlowChats();
  const chat = chats?.find((c) => c.id === String(flow)) ?? null;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const [aim, setAim] = useState<Section | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sections = useMemo(() => chat?.sections ?? [], [chat]);
  const folded = (s: Section) => (open.has(s.thread) ? false : shut.has(s.thread) ? true : s.collapsed);
  const flip = (s: Section) => {
    const now = folded(s);
    setOpen((o) => { const n = new Set(o); now ? n.add(s.thread) : n.delete(s.thread); return n; });
    setShut((o) => { const n = new Set(o); now ? n.delete(s.thread) : n.add(s.thread); return n; });
  };
  const target = chat ? replyTarget(chat, aim) : null;
  const send = () => {
    if (!chat || !target || !text.trim()) return;
    const thread = target.thread ?? chat.sections[chat.sections.length - 1]?.thread;
    if (!thread) return;
    setBusy(true);
    call("threads.post", { thread, text: text.trim() }).then((r) => { if (r.error) showToast(`Not sent. ${r.error.message}`); else { setText(""); showToast("Sent."); } }).catch((e) => showToast(`Not sent. ${e instanceof Error ? e.message : "The server did not answer."}`)).finally(() => setBusy(false));
  };
  return (
    <Page title={chat?.title ?? "Flow chat"} back="/u/chats">
      {err ? <Banner icon="info">{err}</Banner> : null}
      {!chats && !err ? <LoadingState rows={4} /> : null}
      {chats && !chat ? <Card><EmptyState title="No such Flow chat" body="It may have no runs yet. Go back to Chat and press Flows." /></Card> : null}
      {chat ? (
        <View className="gap-s3">
          {sections.map((s) => {
            const h = wakeHeader(s.marker);
            const shown = !folded(s);
            return (
              <Card flush key={s.thread}>
                <Row dense chevron title={<Text strong numberOfLines={2}>{s.divider}</Text>} end={s.needsYou ? <Chip>Needs you</Chip> : undefined} accessibilityLabel={`${shown ? "Collapse" : "Expand"} ${s.divider}`} onPress={() => flip(s)} />
                {shown ? (
                  <View className="gap-s2 p-s3">
                    <Divider />
                    <Text size="caption" tone="label">{h.where}</Text>
                    {h.access ? <Text size="caption" tone="label">{h.access}</Text> : null}
                    <View className="flex-row flex-wrap gap-s2">
                      <Button size="sm" kind="secondary" label="Open thread" onPress={() => router.push(`/u/chats/${encodeURIComponent(s.thread)}` as never)} />
                      <Button size="sm" kind="ghost" label="Open run" onPress={() => router.push(h.openRun as never)} />
                      <Button size="sm" kind="ghost" label="Reply to this run" onPress={() => setAim(s)} />
                    </View>
                  </View>
                ) : null}
              </Card>
            );
          })}
          <Card className="gap-s2">
            <Field name="Message" value={text} onChangeText={setText} placeholder={target?.label ?? ""} />
            <View className="flex-row flex-wrap items-center gap-s2">
              <Button size="sm" label="Send" disabled={busy || !text.trim()} onPress={send} />
              {aim ? <Button size="sm" kind="ghost" label="Back to the whole chat" onPress={() => setAim(null)} /> : null}
            </View>
          </Card>
        </View>
      ) : null}
    </Page>
  );
}
