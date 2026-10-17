import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, EmptyState, LoadingState, Text, useUiTheme } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ChatsSidebar } from "./ChatsSidebar";
import { UNSUPPORTED, chatsShown, chatsView } from "./chats-model.js";
import { PlaceTag } from "../../src/real/PlaceTag";

/**
 * /u/chats. The list of chats lives in the sidebar, so on a wide screen this page opens the most recent chat (or says there is none yet). A phone has no sidebar, so there this page is the list.
 */
export default function ChatsScreen() {
  const router = useRouter();
  const { phone } = useUiTheme();
  const chats = useChats();
  const gap = useGap();
  const status = useConnection();
  const go = (p: string) => router.push(p as never);
  const rows = chatsShown(chats.rows).filter((c) => c.open);
  const latest = [...rows].sort((a, b) => b.last - a.last)[0];
  useEffect(() => { if (!phone && latest) router.replace({ pathname: "/u/chats/[id]", params: { id: latest.id } }); }, [phone, latest?.id]);
  const view = chatsView({ from: chats.from, gap, rows: chats.rows, live: status === "live" });
  return (
    <Page top title="Chat">
      <PlaceTag of="showing" />
      {view.banner && gap ? (
        <Banner icon="info">
          <View className="gap-s2">
            <Text strong>{gap.title}</Text>
            <Text size="caption" tone="muted">{gap.line}</Text>
            <View className="self-start"><Button size="sm" label={gap.action} onPress={() => go(gap.route)} /></View>
          </View>
        </Banner>
      ) : null}
      {view.body === "unsupported" ? <Card><EmptyState title={UNSUPPORTED} body="This app and your server ship together. Update the server, then come back." /></Card>
        : view.body === "gap" && gap ? <Card><EmptyState title={gap.title} body={gap.line} action={{ label: gap.action, onPress: () => go(gap.route) }} /></Card>
        : view.body === "loading" ? <LoadingState rows={4} />
        : view.body === "offline" ? <Card><EmptyState title="Your Vyre has not answered yet" body="Check that it is on and online. Nothing was lost." action={{ label: "Try again", onPress: () => refresh() }} /></Card>
        : phone ? <ChatsSidebar />
        : <Card><EmptyState title={view.body === "empty" ? "No chats yet" : "Pick a chat"} body={view.body === "empty" ? "Start one with an agent or a teammate." : "Your chats are in the list on the left."} action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>}
    </Page>
  );
}
