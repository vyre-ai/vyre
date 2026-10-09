import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AvatarStack, Button, Card, Chip, Divider, EmptyState, LoadingState, Row, Text, markRef } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ageOf } from "./chat-model.js";
import { UNSUPPORTED, chatState, chatSub, chatsOrdered, chatsShown } from "./chats-model.js";
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
  const go = (p: string) => router.push(p as never);
  // your assistant has one chat, pinned at the top: it is started the first time you are here
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || chats.from === "none" || chats.from === "unsupported" || chats.rows.some((c) => c.pinned === "assistant")) return;
    asked.current = true;
    void ensurePersistent("assistant").then((r) => { if ("chat" in r) void refresh(); }).catch(() => { asked.current = false; });
  }, [chats.from, chats.rows]);
  const rows = chatsOrdered(chatsShown(chats.rows));
  return (
    <Page top title="Chat" actions={<Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => go("/u/chats/new")} />}>
      {chats.from === "unsupported" ? <Card><EmptyState title={UNSUPPORTED} body="This app and your server ship together. Update the server, then come back." /></Card>
        : gap ? <Card><EmptyState title={gap.title} body={gap.line} action={{ label: gap.action, onPress: () => go(gap.route) }} /></Card>
        : chats.from === "none" && !rows.length ? (status === "live" ? <LoadingState rows={4} /> : <Card><EmptyState title="Your Vyre has not answered yet" body="Check that it is on and online. Nothing was lost." action={{ label: "Try again", onPress: () => refresh() }} /></Card>)
        : !rows.length ? <Card><EmptyState title="No chats yet" body="Start one with your assistant or an agent." action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>
        : (
          <Card flush>
            {rows.map((t, i) => (
              <View key={t.id} style={t.open ? undefined : { opacity: 0.5 }}>
                {i ? <Divider /> : null}
                <Row lead={<AvatarStack of={[...t.people.map((n) => markRef("person", n)), ...t.agents.map((n) => markRef("assistant", n))]} size={40} max={3} />} title={t.pinned === "assistant" ? "Your assistant" : t.title} sub={t.pinned === "assistant" ? "Always here. Lumen talks to this chat too." : chatSub(t)}
                  end={<>{t.providers.map((p) => <ProviderBadge key={p} provider={p} size={16} />)}{chatState(t) === "needs-you" ? <Chip tone="accent">Needs you</Chip> : chatState(t) === "failed" ? <Chip tone="warn">Failed</Chip> : null}{t.unread > 0 ? <Chip tone="accent">{t.unread > 99 ? "99+" : String(t.unread)}</Chip> : null}{t.last ? <Text size="caption" tone="label">{ageOf(t.last, now)}</Text> : null}</>}
                  onPress={t.open ? () => router.push({ pathname: "/u/chats/[id]", params: { id: t.id } }) : undefined} />
              </View>
            ))}
          </Card>
        )}
    </Page>
  );
}
