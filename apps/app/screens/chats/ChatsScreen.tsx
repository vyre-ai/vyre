import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, EmptyState, LoadingState, Row, Text, markRef } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useThreads, useThreadsFrom } from "../../src/state/threads";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ageOf, ordered, stateOf, subOf } from "./chat-model.js";

/** /u/chats: the box's sessions, the ones that need you first. A row opens the session's chat. */
export default function ChatsScreen() {
  const router = useRouter();
  const threads = useThreads();
  const from = useThreadsFrom();
  const gap = useGap();
  const status = useConnection();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const go = (p: string) => router.push(p as never);
  const rows = ordered(threads);
  return (
    <Page top title="Chat" actions={<Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => go("/u/chats/new")} />}>
      {gap ? <Card><EmptyState title={gap.title} body={gap.line} action={{ label: gap.action, onPress: () => go(gap.route) }} /></Card>
        : from === "none" && !rows.length ? (status === "live" ? <LoadingState rows={4} /> : <Card><EmptyState title="Your Vyre has not answered yet" body="Check that it is on and online. Nothing was lost." action={{ label: "Try again", onPress: () => refresh() }} /></Card>)
        : !rows.length ? <Card><EmptyState title="No chats yet" body="Start one with your assistant or an agent." action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>
        : (
          <Card flush>
            {rows.map((t, i) => (
              <View key={t.id}>
                {i ? <Divider /> : null}
                <Row lead={<Avatar of={markRef(t.agent ? "assistant" : "agent", t.agent ?? t.name ?? "session")} size={40} />} title={t.name ?? "Session"} sub={subOf(t)}
                  end={<>{stateOf(t) === "needs-you" ? <Chip tone="accent">Needs you</Chip> : stateOf(t) === "failed" ? <Chip tone="warn">Failed</Chip> : null}{t.last ? <Text size="caption" tone="label">{ageOf(t.last, now)}</Text> : null}</>}
                  onPress={() => router.push({ pathname: "/session/[id]", params: { id: t.id } })} />
              </View>
            ))}
          </Card>
        )}
    </Page>
  );
}
