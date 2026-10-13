// The Chat list's Flows filter: one row per Flow chat, with its last run's state and a needs-you count. Hidden until "Flows" is pressed.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Chip, Divider, EmptyState, ErrorState, IconTile, LoadingState, Row, Text } from "@vyre/ui";
import { callT as call } from "../../src/real/call-tool";
import { flowChatSub, flowChats, type FlowChat } from "./flow-chat-model.ts";

/** The Flow chats on the box, newest first (shared with the agent page's Work). */
export function useFlowChats(): { chats: FlowChat[] | null; err: string } {
  const [chats, setChats] = useState<FlowChat[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    call<unknown>("threads.list", { all: true }).then((r) => { if (!live) return; if (r.error) setErr(r.error.message || "The server did not answer."); else setChats(flowChats(r.data)); }).catch((e) => live && setErr(e instanceof Error && e.message ? e.message : "The server did not answer."));
    return () => { live = false; };
  }, []);
  return { chats, err };
}

export default function FlowChatsList({ now }: { now: number }) {
  const router = useRouter();
  const { chats, err } = useFlowChats();
  if (err) return <Card flush><ErrorState title="Flow chats did not load" reason={err} /></Card>;
  if (!chats) return <LoadingState rows={3} />;
  if (!chats.length) return <Card><EmptyState title="No Flow chats yet" body="When a Flow hands a step to an agent, its work shows up here. A run that waits on you also shows in the main list." /></Card>;
  return (
    <Card flush>
      {chats.map((c, i) => (
        <View key={c.id}>
          {i ? <Divider /> : null}
          <Row lead={<IconTile size={40} name="flows" />} title={<Text strong numberOfLines={2}>{c.title}</Text>} sub={flowChatSub(c, now)} chevron end={c.needsYou ? <Chip>{`${c.needsYou} need${c.needsYou === 1 ? "s" : ""} you`}</Chip> : undefined}
            accessibilityLabel={`Open ${c.title}`} onPress={() => router.push(`/u/chats/flow/${encodeURIComponent(c.id)}` as never)} />
        </View>
      ))}
    </Card>
  );
}
