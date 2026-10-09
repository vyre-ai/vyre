import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Divider, EmptyState, Field, LoadingState, Row, Text, markRef } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agentsList } from "../settings/real";
import { writeDraft } from "../../src/chat/drafts";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { SURFACE } from "../../src/state/live";
import { tool } from "../../src/real/box";
import { agentChoices, chatIdOf, createInput } from "../../src/state/new-chat-model.js";
import { ringForNewChat } from "../../src/state/chat-start";

/** /u/chats/new: pick who to talk to (your assistant is the default and is never listed), say what you want first if you like, and start. work.chat.create makes the chat; it opens with your first words ready to send. */
export default function NewChatScreen() {
  const router = useRouter();
  // "Chat about this": a record or project opens a new chat with its urn and name; the chat is linked to it, and the first words name it so the assistant can read it
  const { about, name } = useLocalSearchParams<{ about?: string; name?: string }>();
  const aboutUrn = typeof about === "string" && about.startsWith("vyre://") ? about : "";
  const [agents, setAgents] = useState<ReturnType<typeof agentChoices> | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState(aboutUrn ? `About ${typeof name === "string" && name ? name : "this"} (${aboutUrn}): ` : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const a = await agentsList();
        if (!live) return;
        const c = agentChoices(a);
        setAgents(c); setPick(c[0]?.name ?? null);
      } catch (e) { if (live) setLoadErr(e instanceof Error ? e.message : "Your Vyre did not answer."); }
    })();
    return () => { live = false; };
  }, []);
  const start = async () => {
    const agent = agents?.find((a) => a.name === pick) ?? null;
    setBusy(true); setErr("");
    try {
      const made = await ringForNewChat();
      if ("say" in made) { setErr(made.say); return; }
      const id = chatIdOf(await tool("work.chat.create", { ...createInput({ agent }), ...made }));
      if (!id) throw new Error("The chat started but Vyre did not say which one. Open it from Chat.");
      // linked to the record it is about; private to its people until they share it on the record's timeline
      if (aboutUrn) await tool("work.chat.link", { chat: id, record: aboutUrn }).catch(() => undefined);
      // The first words are sent into the new chat (work.chat.create takes none); that send starts the chat's run. If it fails they wait in the chat's box instead.
      if (text.trim()) {
        const first = await tool("stream.send", { chat: id, text: text.trim(), message: newUuid(), surface: SURFACE }).then(() => null).catch((e: Error) => e);
        if (first) writeDraft(id, text.trim());
      }
      router.replace({ pathname: "/u/chats/[id]", params: { id } });
    } catch (e) { setErr(e instanceof Error ? e.message : "The chat did not start."); } finally { setBusy(false); }
  };
  return (
    <Page title="New chat" sub="Who do you want to talk to?" back="/u/chats">
      {loadErr ? <Card><EmptyState title="Your Vyre did not answer" body={loadErr} action={{ label: "Back to Chat", onPress: () => router.replace("/u/chats" as never) }} /></Card>
        : agents === null ? <LoadingState rows={3} />
        : !agents.length ? <Card><EmptyState title="No assistants yet" body="A chat needs an assistant to talk to." action={{ label: "Connect your AI account", onPress: () => router.replace("/u/settings/ai" as never) }} /></Card>
        : (
          <View className="gap-s3">
            <Card flush>
              {agents.map((a, i) => (
                <View key={a.name}>{i ? <Divider /> : null}
                  <Row lead={<Avatar of={markRef(a.assistant ? "assistant" : "agent", a.name)} size={40} />} title={a.name} sub={a.assistant ? "Your assistant" : "Agent"} selected={pick === a.name} onPress={() => setPick(a.name)} />
                </View>
              ))}
            </Card>
            {aboutUrn ? <Banner tone="plain"><Text>{`This chat is about ${typeof name === "string" && name ? name : "that record"}. It stays private to the people in it until you share it on the timeline.`}</Text></Banner> : null}
            <Field label="First message (optional)" value={text} onChangeText={setText} placeholder="What do you want to work on?" multiline />
            {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
            <View className="flex-row"><Button kind="primary" label={busy ? "Starting" : "Start chat"} disabled={!pick || busy} onPress={() => void start()} /></View>
          </View>
        )}
    </Page>
  );
}
