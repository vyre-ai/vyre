import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, EmptyState, LoadingState, Text, useUiTheme } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ChatsSidebar, ChatsSidebarHeader } from "./ChatsSidebar";
import { UNSUPPORTED, chatsLanding, chatsShown, chatsView } from "./chats-model.js";
import { PlaceTag } from "../../src/real/PlaceTag";
import { ensurePersistent } from "../../src/state/persistent-chat";

/**
 * /u/chats. Pressing Chat opens your Assistant's chat, ready to type, the way a chat app opens on a new conversation. The Assistant's chat is made here the first time. If it cannot be made, the page says why
 * (and offers Try again) instead of an empty list. The empty page shows only when there is no Assistant chat and it cannot be made.
 */
export default function ChatsScreen() {
  const router = useRouter();
  // ?list=1 is "show me the list" (the chat's own Chat list button on a phone): this page then stays the list
  const { list } = useLocalSearchParams<{ list?: string }>();
  const { phone } = useUiTheme();
  const chats = useChats();
  const gap = useGap();
  const status = useConnection();
  const go = (p: string) => router.push(p as never);
  const rows = chatsShown(chats.rows).filter((c) => c.open);
  const assistant = rows.find((c) => c.pinned === "assistant");
  const [say, setSay] = useState("");
  const [making, setMaking] = useState(false);
  const tried = useRef(false);
  const [again, setAgain] = useState(0);
  // Each time the person comes back to this page it tries again: the device may have become ready (its key published, its name known) since the last refusal.
  useFocusEffect(useCallback(() => { tried.current = false; setAgain((n) => n + 1); }, []));
  const openChat = (id: string) => router.replace({ pathname: "/u/chats/[id]", params: { id, focus: "1" } });
  const landing = chatsLanding({ assistant: !!assistant, from: chats.from, list });
  useEffect(() => { if (landing === "open" && assistant) openChat(assistant.id); }, [landing, assistant?.id]);
  const make = async () => {
    setMaking(true); setSay("");
    try {
      const r = await ensurePersistent("assistant");
      if ("chat" in r) { refresh(); openChat(r.chat); } else setSay(r.say);
    } catch (e) { setSay(e instanceof Error && e.message ? e.message : "Your Assistant's chat did not start."); } finally { setMaking(false); }
  };
  useEffect(() => { if (landing === "make" && !tried.current) { tried.current = true; void make(); } }, [landing, again]);
  const view = chatsView({ from: chats.from, gap, rows: chats.rows, live: status === "live" });
  return (
    <Page top title="Chat">
      <PlaceTag of="showing" />
      {view.banner && gap ? (
        <Banner icon="info">
          <View className="gap-s2">
            <Text strong>{gap.title}</Text>
            <Text size="caption" tone="muted">{gap.line}</Text>
            {gap.action && gap.route ? <View className="self-start"><Button size="sm" label={gap.action} onPress={() => go(gap.route as string)} /></View> : null}
          </View>
        </Banner>
      ) : null}
      {say && !assistant ? (
        <Banner tone="warn" icon="warning">
          <View className="gap-s2">
            <Text strong>Your Assistant's chat did not start</Text>
            <Text size="caption" tone="muted">{say}</Text>
            <View className="self-start"><Button size="sm" label={making ? "Trying" : "Try again"} disabled={making} onPress={() => void make()} /></View>
          </View>
        </Banner>
      ) : null}
      {view.body === "unsupported" ? <Card><EmptyState title={UNSUPPORTED} body="This app and your server ship together. Update the server, then come back." /></Card>
        : view.body === "gap" && gap ? <Card><EmptyState title={gap.title} body={gap.line} {...(gap.action && gap.route ? { action: { label: gap.action, onPress: () => go(gap.route as string) } } : {})} /></Card>
        : view.body === "loading" ? <LoadingState rows={4} />
        : view.body === "offline" ? <Card><EmptyState title="Your Vyre has not answered yet" body="Check that it is on and online. Nothing was lost." action={{ label: "Try again", onPress: () => refresh() }} /></Card>
        : phone ? <View className="gap-s3"><ChatsSidebarHeader /><ChatsSidebar /></View>
        : <Card><EmptyState title={view.body === "empty" ? "No chats yet" : "Pick a chat"} body={view.body === "empty" ? "Start one with an agent or a teammate." : "Your chats are in the list on the left."} action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>}
    </Page>
  );
}
