import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Text, useUiTheme } from "@vyre/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentsList } from "../settings/real";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { agentThreads } from "../../src/chat/threads-source";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { SURFACE, refresh } from "../../src/state/live";
import { callT } from "../../src/real/call-tool";
import { ChatHeader } from "../../src/chat/ChatHeader";
import { ChatComposer } from "../../src/chat/ChatComposer";
import { Face } from "../../src/chat/Face";
import { writeDraft } from "../../src/chat/drafts";
import { sendFirst } from "./new-thread-model.js";
import { openWho } from "@vyre/ui";
import "./WhoPane";

const DRAFT = "new-thread";

/**
 * /u/chats/new-thread: what pressing Chat opens. It looks like the chat it becomes: the title with who it is with, an empty transcript, and the normal composer at the bottom, focused. There is no separate form.
 * Nothing is made on the server until the first message is sent, so empty threads never pile up; `?agent=<name>` opens it with that agent instead of the person's Assistant (the side pane's New thread). The words show
 * at once while the thread starts, and a refusal puts them back in the box with the reason. Pressing the name or avatar opens that agent's side pane.
 */
export default function NewThreadScreen() {
  const router = useRouter();
  const { color, phone } = useUiTheme();
  const insets = useSafeAreaInsets();
  const q = useLocalSearchParams<{ agent?: string }>();
  const want = typeof q.agent === "string" && q.agent ? q.agent : "";
  const [name, setName] = useState<string | null>(want || null);
  const [title, setTitle] = useState(want || "Assistant");
  const [sending, setSending] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [boxKey, setBoxKey] = useState(0);
  const live = useRef(true);
  // a thread a refused first try already made: Send again posts into it, so a second thread is never made
  const made = useRef("");
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    if (want) { setName(want); setTitle(want); return; }
    let on = true;
    void (async () => {
      try {
        const list: any[] = await agentsList().catch(() => []);
        const mine = visibleAgents(list.map((x) => agentRow(x, "")), "").find((r) => r.kind === "assistant");
        if (on) { setName(mine ? mine.name : "Assistant"); setTitle(mine ? mine.title : "Assistant"); }
      } catch { if (on) { setName("Assistant"); setTitle("Assistant"); } }
    })();
    return () => { on = false; };
  }, [want]);

  const send = async (words: string) => {
    if (!name || sending !== null) return;
    setSending(words); setErr("");
    try {
      const r = await sendFirst({ name, text: words, thread: made.current }, {
        start: (agent) => agentThreads.start(agent),
        send: async (chat, t) => { const x = await callT<unknown>("stream.send", { chat, text: t, message: newUuid(), surface: SURFACE }); if (x.error) throw new Error(x.error.message || x.error.code || "The message was not sent."); },
      });
      if (!r || !live.current) return;
      if ("thread" in r && r.thread) made.current = r.thread;
      if ("problem" in r) { setErr(r.problem); writeDraft(DRAFT, words); setBoxKey((k) => k + 1); setSending(null); return; }
      refresh();
      router.replace({ pathname: "/u/chats/[id]", params: { id: r.thread } });
    } catch (e) {
      if (!live.current) return;
      setErr(e instanceof Error && e.message ? e.message : "The thread did not start.");
      writeDraft(DRAFT, words); setBoxKey((k) => k + 1); setSending(null);
    }
  };

  const faces = [{ id: `agent:${name ?? title}`, name: title, family: "assistant" }];
  return (
    <View style={{ flex: 1, backgroundColor: color["surface-1"], paddingTop: insets.top }}>
      <ChatHeader title={title} participants={faces} viewer="person:me" phone={phone} onBack={() => router.replace("/u/chats?list=1" as never)} onOpen={() => {}}
        onOpenWho={name ? () => openWho("agent", name) : undefined} />
      <View style={{ flex: 1, minHeight: 0, width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: phone ? 16 : 24 }}>
        {sending === null ? (
          <View style={{ alignItems: "center", gap: 8, paddingTop: 48 }}>
            <Face name={title} family="assistant" size={40} id={`agent:${name ?? title}`} />
            <Text medium>{title}</Text>
            <Text size="caption" tone="label">The start of this chat</Text>
          </View>
        ) : (
          <View style={{ alignItems: "flex-end", paddingTop: 24 }}>
            <View style={{ maxWidth: "85%", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: color["surface-3"], opacity: 0.7 }}><Text>{sending}</Text></View>
            <Text size="caption" tone="label" style={{ paddingTop: 6 }}>Starting</Text>
          </View>
        )}
      </View>
      {err ? <View accessibilityRole="alert" style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingBottom: 6 }}><Banner tone="warn" icon="warning"><Text>{err}</Text></Banner></View> : null}
      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer key={boxKey} state="waiting" phone={phone} autoFocus draftKey={DRAFT} onSend={(t) => { void send(t); }} />
      </View>
    </View>
  );
}
