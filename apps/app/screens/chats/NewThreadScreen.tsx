import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Banner, Button, Card, Field, Text, allowsMock, useStore } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agentsList } from "../settings/real";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { agentThreads } from "../../src/chat/threads-source";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { SURFACE, refresh } from "../../src/state/live";
import { callT } from "../../src/real/call-tool";
import { NOT_LISTED, deviceReadiness } from "../../src/state/chat-start";
import { retryChatSetup } from "../settings/real";
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
  // a thread a refused first try already made: Send again posts into it, so a second thread is never made
  const made = useRef("");
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
  // This device's chat key is not the one on the list: one button replaces the list's entry with this device's key (the same step as Settings, Account and recovery, Try again).
  const [fixing, setFixing] = useState(false);
  const [fixNote, setFixNote] = useState("");
  const fix = async () => {
    setFixing(true); setFixNote("");
    try {
      const failed = await retryChatSetup();
      if (failed) { if (live.current) setFixNote(failed.charAt(0).toUpperCase() + failed.slice(1) + "."); return; }
      const g = await deviceReadiness().catch(() => "Vyre did not answer.");
      if (!live.current) return;
      setGap(g);
      if (g) setFixNote("Updated. Waiting for your list to catch up.");
      void check();
    } catch (e) {
      if (live.current) setFixNote(e instanceof Error && e.message ? e.message : "That did not work. Try again.");
    } finally { if (live.current) setFixing(false); }
  };
  useFocusEffect(useCallback(() => { void check(); }, [check]));
  const send = async () => {
    setBusy(true); setErr("");
    try {
      const r = await sendFirst({ name: name ?? "", text, thread: made.current }, {
        start: (agent) => agentThreads.start(agent),
        send: async (chat, words) => { const x = await callT<unknown>("stream.send", { chat, text: words, message: newUuid(), surface: SURFACE }); if (x.error) throw new Error(x.error.message || x.error.code || "The message was not sent."); },
      });
      if (!r) return;
      if ("thread" in r && r.thread) made.current = r.thread;
      if ("problem" in r) { setErr(r.problem); return; }
      refresh();
      router.replace({ pathname: "/u/chats/[id]", params: { id: r.thread } });
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : "The thread did not start."); } finally { setBusy(false); }
  };
  return (
    <Page title={title || "Assistant"} sub="New thread" back="/u/chats?list=1">
      {(
        <View className="gap-s3">
          {gap ? (
            <Banner tone="warn" icon="warning">
              <View className="gap-s2">
                <Text strong>{gap === NOT_LISTED ? "This device's chat key needs updating" : "This device is not ready to start a chat"}</Text>
                <Text size="caption" tone="muted">{gap === NOT_LISTED ? "The chat key on your list is not the one this device holds. Updating it takes a moment." : gap}</Text>
                {fixNote ? <Text size="caption" tone="muted">{fixNote}</Text> : null}
                <Text size="caption" tone="label">Checking again on its own.</Text>
                <View className="self-start flex-row gap-s2">
                  {gap === NOT_LISTED
                    ? <Button size="sm" kind="primary" label={fixing ? "Updating" : "Update chat key"} disabled={fixing} onPress={() => void fix()} />
                    : <Button size="sm" label="Try again" onPress={() => void check()} />}
                </View>
              </View>
            </Banner>
          ) : null}
          <Card>
            <View className="gap-s3">
              <Field name={`Message ${title || "Assistant"}`} value={text} onChangeText={setText} placeholder={`Message ${title || "Assistant"}`} multiline lines={4} autoFocus />
              {err ? <Banner tone="warn" icon="warning"><Text>{err}</Text></Banner> : null}
              <View className="flex-row justify-end"><Button kind="primary" label={busy ? "Starting" : "Send"} disabled={busy || name === null || !text.trim() || !!gap} onPress={() => void send()} /></View>
            </View>
          </Card>
          <Text size="caption" tone="label">Your earlier threads with {title || "your Assistant"} are in the list.</Text>
        </View>
      )}
    </Page>
  );
}
