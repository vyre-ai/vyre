import { useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { ringForNewChat } from "../../src/state/chat-start";
import { SURFACE } from "../../src/state/live";
import { viewerZone } from "../../src/time/show.js";
import { askSource } from "./ask-source";
import { agentCards, mention } from "./home-model.js";
import { HomeField } from "./HomeField";
import { HomeAgents } from "./HomeAgents";

/** The ask field: the words start a new thread with the assistant (or with the agent named by @) and open it. Enter sends. */
export function AskDock({ names, assistant, text, onChangeText }: { names: string[]; assistant: string; text: string; onChangeText: (v: string) => void }) {
  const router = useRouter();
  const src = useMemo(() => askSource(callT, { ring: ringForNewChat, surface: SURFACE, zone: viewerZone(), uuid: newUuid }), []);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await src.ask(text, names, assistant);
    setBusy(false);
    if ("problem" in r) { showToast(r.problem); return; }
    onChangeText("");
    router.push(`/u/chats/${encodeURIComponent(r.thread)}` as never);
  };
  return <HomeField name="Ask" value={text} onChangeText={onChangeText} placeholder="Ask anything, or @ an agent" icon="send" action="Send" busy={busy} busyLabel="Starting" onSubmit={() => void send()} />;
}

/** The ask field and the face chips under it. `live` reads agents.list. `cards` is a fixed row (the pictures). Names passed to ask include every agent, so a typed @ still routes. */
export function HomeComposer({ live, cards }: { live?: boolean; cards?: ReturnType<typeof agentCards> }) {
  const [text, setText] = useState("");
  const [who, setWho] = useState(() => ({
    names: cards?.map((c) => c.name) ?? [],
    assistant: cards?.find((c) => c.kind === "assistant")?.name ?? "",
  }));
  return (
    <View className="gap-s2">
      <AskDock names={who.names} assistant={who.assistant} text={text} onChangeText={setText} />
      <HomeAgents live={live} cards={cards} onMention={(name) => setText((t) => mention(t, name))} onNames={(names, assistant) => setWho({ names, assistant })} />
    </View>
  );
}
