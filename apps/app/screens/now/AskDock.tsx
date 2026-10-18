import { useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { Button, Field, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { ringForNewChat } from "../../src/state/chat-start";
import { SURFACE } from "../../src/state/live";
import { viewerZone } from "../../src/time/show.js";
import { askSource } from "./ask-source";

/** The ask box at the bottom of Home: the words start a new thread with the assistant (or with the agent named by @) and open it. */
export function AskDock({ names, assistant }: { names: string[]; assistant: string }) {
  const router = useRouter();
  const src = useMemo(() => askSource(callT, { ring: ringForNewChat, surface: SURFACE, zone: viewerZone(), uuid: newUuid }), []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await src.ask(text, names, assistant);
    setBusy(false);
    if ("problem" in r) { showToast(r.problem); return; }
    setText("");
    router.push(`/u/chats/${encodeURIComponent(r.thread)}` as never);
  };
  return (
    <View className="flex-row items-end gap-s2">
      <View className="min-w-0 flex-1"><Field label="Ask your assistant" value={text} onChangeText={setText} placeholder="Ask anything, or @ an agent" onSubmit={() => void send()} /></View>
      <Button kind="primary" label={busy ? "Starting" : "Ask"} disabled={!text.trim() || busy} onPress={() => void send()} />
    </View>
  );
}
