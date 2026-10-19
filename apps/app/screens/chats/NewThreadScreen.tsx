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

/**
 * /u/chats/new-thread: what pressing Chat opens. A new thread with your Assistant, the composer ready to type, like a chat app opens on a new conversation. Nothing is made on the server until you send the
 * first message, so empty threads do not pile up; your earlier threads are in the list. If this device cannot start a private chat yet, the page says why and checks again on its own (when you come back,
 * and every few seconds), so the box is not left silent.
 */
export default function NewThreadScreen() {
  const router = useRouter();
  const st = useStore();
  const [name, setName] = useState<string | null>(null);
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
        if (on) setName(mine ? mine.name : "Assistant");
      } catch { if (on) setName("Assistant"); }
    })();
    return () => { on = false; };
  }, [st]);
  const check = useCallback(async () => { if (allowsMock()) { setGap(null); return; } const g = await deviceReadiness(); if (live.current) setGap(g); }, []);
  // again when the person comes back to the page, and every few seconds while the device is not ready
  useFocusEffect(useCallback(() => { void check(); }, [check]));
  useEffect(() => { if (!gap) return; const t = setInterval(() => void check(), 5000); return () => clearInterval(t); }, [gap, check]);
  const send = async () => {
    if (!text.trim() || !name) return;
    setBusy(true); setErr("");
    try {
      const made = await agentThreads.start(name);
      if ("problem" in made) { setErr(made.problem); return; }
      const first = await tool("stream.send", { chat: made.thread, text: text.trim(), message: newUuid(), surface: SURFACE }).then(() => null).catch((e: Error) => e);
      if (first) writeDraft(made.thread, text.trim());
      refresh();
      router.replace({ pathname: "/u/chats/[id]", params: { id: made.thread } });
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : "The thread did not start."); } finally { setBusy(false); }
  };
  return (
    <Page title={name ?? "Assistant"} sub="New thread" back="/u/chats?list=1">
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
              <Field name={`Message ${name}`} value={text} onChangeText={setText} placeholder={`Message ${name}`} multiline lines={4} autoFocus />
              {err ? <Text tone="warn">{err}</Text> : null}
              <View className="flex-row justify-end"><Button kind="primary" label={busy ? "Starting" : "Send"} disabled={busy || !text.trim() || !!gap} onPress={() => void send()} /></View>
            </View>
          </Card>
          <Text size="caption" tone="label">Your earlier threads with {name} are in the list.</Text>
        </View>
      )}
    </Page>
  );
}
