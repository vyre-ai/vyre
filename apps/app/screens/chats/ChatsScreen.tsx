import { useEffect } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, EmptyState, LoadingState, Text, useUiTheme } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ChatsSidebar, ChatsSidebarHeader } from "./ChatsSidebar";
import { UNSUPPORTED, chatsLanding, chatsView } from "./chats-model.js";
import { PlaceTag } from "../../src/real/PlaceTag";

/**
 * /u/chats. Pressing Chat opens a new thread with your Assistant, ready to type (/u/chats/new-thread), the way a chat app opens on a new conversation; your earlier threads are in the list. ?list=1 is the list itself
 * (a phone's Chat list button). This page shows only while the box has not answered, or says what is wrong with it.
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
  const landing = chatsLanding({ from: chats.from, list });
  useEffect(() => { if (landing === "new") router.replace("/u/chats/new-thread" as never); }, [landing]);
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
      {chats.note && view.body === "list" && !phone ? <Text size="caption" tone="label">This is the last list. It did not refresh.</Text> : null}
      {view.body === "unsupported" ? <Card><EmptyState title={UNSUPPORTED} body="This app and your server ship together. Update the server, then come back." /></Card>
        : view.body === "gap" && gap ? <Card><EmptyState title={gap.title} body={gap.line} {...(gap.action && gap.route ? { action: { label: gap.action, onPress: () => go(gap.route as string) } } : {})} /></Card>
        : view.body === "loading" ? <LoadingState rows={4} />
        : view.body === "failed" ? <Card><EmptyState title="Your chats did not load" body="Your Vyre did not send the list. Nothing was lost." action={{ label: "Try again", onPress: chats.retry }} /></Card>
        : view.body === "offline" ? <Card><EmptyState title="Your Vyre has not answered yet" body="Check that it is on and online. Nothing was lost." action={{ label: "Try again", onPress: () => refresh() }} /></Card>
        : phone ? <View className="gap-s3"><ChatsSidebarHeader /><ChatsSidebar /></View>
        : <Card><EmptyState title={view.body === "empty" ? "No chats yet" : "Pick a chat"} body={view.body === "empty" ? "Start one with an agent or a teammate." : "Your chats are in the list on the left."} action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>}
    </Page>
  );
}
