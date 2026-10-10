import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AvatarStack, Banner, Button, Card, Chip, Divider, EmptyState, LoadingState, Row, Text, markRef } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ageOf } from "./chat-model.js";
import { tool } from "../../src/real/box";
import { ChatsList } from "./ChatsList";
import { UNSUPPORTED, chatState, computerOf, chatSub, chatsOrdered, chatsShown, chatsView } from "./chats-model.js";
import { ensurePersistent } from "../../src/state/persistent-chat";
import { ProviderBadge } from "@vyre/ui";

/** /u/chats: every chat you can see, the ones that need you first. One row type for solo, group and people-only chats; a row for a chat you are not in is greyed and does not open. */
export default function ChatsScreen() {
  const router = useRouter();
  const chats = useChats();
  const gap = useGap();
  const status = useConnection();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  // Which chats run on one of your own computers (runner.places): a box without it answers nothing and the list says nothing about places.
  const [places, setPlaces] = useState<unknown>(null);
  useEffect(() => { let live = true; tool("runner.places", {}).then((x) => { if (live) setPlaces(x); }).catch(() => {}); return () => { live = false; }; }, [chats.rows.length]);
  const go = (p: string) => router.push(p as never);
  // your assistant has one chat, pinned at the top: it is started the first time you are here
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || chats.from === "none" || chats.from === "unsupported" || chats.rows.some((c) => c.pinned === "assistant")) return;
    asked.current = true;
    void ensurePersistent("assistant").then((r) => { if ("chat" in r) void refresh(); }).catch(() => { asked.current = false; });
  }, [chats.from, chats.rows]);
  const rows = chatsOrdered(chatsShown(chats.rows));
  const view = chatsView({ from: chats.from, gap, rows, live: status === "live" });
  return (
    <Page top title="Chat" actions={<Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => go("/u/chats/new")} />}>
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
        : view.body === "empty" ? <Card><EmptyState title="No chats yet" body="Start one with your assistant or an agent." action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>
        : (
          <ChatsList rows={rows} now={now} places={places} onOpen={(id) => router.push({ pathname: "/u/chats/[id]", params: { id } })} />
        )}
    </Page>
  );
}
