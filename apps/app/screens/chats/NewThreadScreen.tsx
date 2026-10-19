import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Banner, Button, Card, Field, LoadingState, Text, allowsMock, useStore } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agentsList } from "../settings/real";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { agentThreads } from "../../src/chat/threads-source";
import { writeDraft } from "../../src/chat/drafts";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { SURFACE, refresh } from "../../src/state/live";
import { tool } from "../../src/real/box";
import { deviceReadiness } from "../../src/state/chat-start";
import { sendFirst, watchReadiness } from "./new-thread-model.js";

/**
 * /u/chats/new-thread: what pressing Chat opens. A new thread with your Assistant, the composer ready to type, like a chat app opens on a new conversation. Nothing is made on the server until you send the
 * first message, so empty threads do not pile up; your earlier threads are in the list. If this device cannot start a private chat yet, the page says why and checks again on its own (when you come back,
 * and every few seconds), so the box is not left silent.
 */
export default function NewThreadScreen() {
  const router = useRouter();
  const st = useStore();
  const [name, setName] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [gap, setGap] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const me = String((await (st.me?.() as Promise<string> | undefined)?.catch(() => "")) ?? "");
        const list: any[] = await agentsList().catch(() => []);
        const mine = visibleAgents(list.map((x) => agentRow(x, me)), me).find((r) => r.kind === "assistant");
        if (on) { setName(mine ? mine.name : "Assistant"); setTitle(mine ? mine.title : "Assistant"); }
      } catch { if (on) { setName("Assistant"); setTitle("Assistant"); } }
    })();
    return () => { on = false; };
  }, [st]);
  // The device is asked now, when the person comes back to the page, and every few seconds while it is not ready.
  const watch = useRef<ReturnType<typeof watchReadiness> | null>(null);
  useEffect(() => {
    const w = watchReadiness({ check: () => (allowsMock() ? Promise.resolve(null) : deviceReadiness()), on: (g) => { if (live.current) setGap(g); }, every: 5000 });
    watch.current = w;
    return () => w.stop();
  }, []);
  const check = useCallback(() => watch.current?.again() ?? Promise.resolve(), []);
  useFocusEffect(useCallback(() => { void check(); }, [check]));
  const send = async () => {
    setBusy(true); setErr("");
    try {
      const r = await sendFirst({ name: name ?? "", text }, {
        start: (agent) => agentThreads.start(agent),
        send: async (chat, words) => { await tool("stream.send", { chat, text: words, message: newUuid(), surface: SURFACE }); },
        keep: (chat, words) => writeDraft(chat, words),
      });
      if (!r) return;
      if ("problem" in r) { setErr(r.problem); return; }
      refresh();
      router.replace({ pathname: "/u/chats/[id]", params: { id: r.thread } });
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : "The thread did not start."); } finally { setBusy(false); }
  };
  return (
    <Page title={title || "Assistant"} sub="New thread" back="/u/chats?list=1">
      {name === null ? <LoadingState rows={2} /> : (
        <View className="gap-s3">
          {gap ? (
            <Banner tone="warn" icon="warning">
              <View className="gap-s2">
                <Text strong>This device is not ready to start a chat</Text>
                <Text size="caption" tone="muted">{gap}</Text>
                <Text size="caption" tone="label">Checking again on its own.</Text>
                <View className="self-start"><Button size="sm" label="Try again" onPress={() => void check()} /></View>
              </View>
            </Banner>
          ) : null}
          <Card>
            <View className="gap-s3">
              <Field name={`Message ${title}`} value={text} onChangeText={setText} placeholder={`Message ${title}`} multiline lines={4} autoFocus />
              {err ? <Text tone="warn">{err}</Text> : null}
              <View className="flex-row justify-end"><Button kind="primary" label={busy ? "Starting" : "Send"} disabled={busy || !text.trim() || !!gap} onPress={() => void send()} /></View>
            </View>
          </Card>
          <Text size="caption" tone="label">Your earlier threads with {title} are in the list.</Text>
        </View>
      )}
    </Page>
  );
}
